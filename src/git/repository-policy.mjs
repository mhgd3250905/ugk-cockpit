import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { git } from './probe.mjs';

// Repository-local configuration is attacker-controlled whenever Cockpit is
// pointed at a repository it did not author. Git reads classes of settings that
// turn ordinary operations into command execution or redirect a destination:
//
//   filter.<driver>.clean|smudge|process   -> runs on `git add` / checkout / status
//   diff.<driver>.command|textconv         -> runs on `git diff` / `log -p`
//   diff.external                          -> replaces the whole diff machinery
//   merge.<driver>.driver                  -> runs on conflicted merges
//   gpg.<program>|gpg.ssh.<program>        -> runs to sign pushes/commits/tags
//   url.*.insteadOf|pushInsteadOf          -> silently rewrites a push target
//   remote.*.uploadpack|receivepack|proxy  -> runs on fetch / push
//   http.* transport keys                  -> see HOSTILE_TRANSPORT_CONFIG_PATTERN
//
// Cockpit cannot prove a hostile driver is absent, so it fails closed before
// any Git operation that could invoke one. The signing programs are refused
// outright because Cockpit never signs anything: `git push` reads
// `push.gpgSign` into a signed-push request even without `--signed`, and the
// signing client then executes `gpg.program` on whatever the repository chose
// — measured locally as `push.gpgsign=true` alone steering push into the
// signed-push code path. SAFE_GIT_PREFIX additionally resets the three
// sign-everything toggles as a second line of defence.
export const HOSTILE_LOCAL_CONFIG_PATTERN =
  '^(filter\\..*\\.(clean|smudge|process)'
  + '|diff\\..*\\.(command|textconv)|diff\\.external'
  + '|merge\\..*\\.driver'
  + '|gpg\\..*program)$';
export const HOSTILE_ANY_SCOPE_CONFIG_PATTERN =
  '^(url\\..*\\.(insteadof|pushinsteadof)|remote\\..*\\.(uploadpack|receivepack|proxy))$';

// The `http.*` / `https.*` family is the transport configuration git consults
// for an http(s) remote, and git reads it from the repository-local scope like
// any other key. The families below can redirect the connection, change who is
// trusted to terminate TLS, weaken that decision, or inject request headers
// into a fetch/push that carries the user's real Git credentials.
//
// Which keys are refused on presence and which on value:
//
//   * `proxy`, `curloptResolve`, `extraHeader`, `cookieFile`, `saveCookies`,
//     `delegation`, `emptyAuth`, `proactiveAuth` and the proxy_ssl_* pair do
//     something to every request that no repository may choose on the user's
//     behalf, whatever the value, so presence alone is enough.
//   * `sslCAInfo`, `sslCAPath`, `sslCert`, `sslKey`, `pinnedPubkey` and
//     `sslCipherList` replace or restrict the trust and cipher set. Legitimate
//     repository-local mTLS and corporate CA pins exist, but this product
//     cannot tell them from a hostile substitution, so they stay refused.
//   * `sslVerify`, `schannelCheckRevoke`, `sslVersion` and `followRedirects`
//     are *hardening* when set to the safe spelling and only dangerous
//     otherwise. Matching the key alone rejected repositories that had
//     explicitly tightened their own transport (`http.sslVerify=true`), so
//     these are value-aware. The boolean ones are judged in two dedicated
//     queries that make git normalise the value (`--bool`, `--bool-or-str`),
//     because the two "unset" spellings are OPPOSITES there:
//
//       * a valueless entry (`[http] sslVerify`) is boolean TRUE,
//       * an explicitly empty value (`[http] sslVerify = `) is boolean FALSE,
//
//     and under `--bool` git reports exactly `true` / `false` for them. A
//     spelling git cannot parse exits fatally, which is the fail-closed
//     behaviour wanted for `maybe`. `followRedirects` also accepts the
//     non-boolean `initial` (git's default), so it is queried with
//     `--bool-or-str`, which passes such values through verbatim.
//
//     All transport queries read the `-z` record format (`key LF value NUL`).
//     The first-space split this replaced was a real bypass: a URL-scoped
//     subsection may itself contain spaces — `[http "https://example.invalid/a b"]`
//     prints the key `http.https://example.invalid/a b.sslverify` — so
//     `sslVerify = false` parsed as key `...a` and value `b.sslverify false`,
//     which matched neither safe spelling and slipped through, while git
//     itself honours the key for the matching percent-encoded URL (measured
//     with get-urlmatch under SAFE_GIT_PREFIX).
//
// Key-only entries stay hostile whatever their value, including an explicit
// empty one: an empty `http.proxy` happens to mean "no proxy", but presence is
// the rule for keys no repository may set on the user's behalf, and making
// per-key empty-value exceptions would be the harder contract to keep straight.
//
// Rejecting is correct rather than rewriting: unlike `remote.<name>.mirror`
// (a benign setting Cockpit can neutralise, see delivery-ops.mjs), a repository
// that disables certificate validation or pins a private CA is a security
// decision the user has to make deliberately, so silencing it would hide a real
// problem. `sslVerify` in particular is commonly set globally by users behind a
// corporate proxy; global and system scope are already discarded for every
// Cockpit Git call (GIT_CONFIG_GLOBAL / GIT_CONFIG_NOSYSTEM in
// safeGitEnvironment), so only a repository-owned setting can reach this
// pattern and the user's own global preference is never affected.
//
// The url-scoped spelling `http.<url>.<key>` overrides the generic key for a
// matching URL and is read from the same scope, so the pattern accepts both.
// `http.postBuffer`, `http.version`, `http.userAgent`, `http.lowSpeedLimit`
// and friends are deliberately left out: they tune transfer performance
// without moving bytes to a different peer, and rejecting them would lock out
// ordinary repositories.
export const HOSTILE_TRANSPORT_CONFIG_PATTERN =
  '^(https?\\.|https?\\..*\\.)'
  + '(proxy|curloptresolve|extraheader|cookiefile|savecookies|delegation'
  + '|emptyauth|proactiveauth|proxysslcainfo|proxysslcert|proxysslkey'
  + '|sslcainfo|sslcapath|sslcert|sslkey|pinnedpubkey|sslcipherlist|sslversion)$';

// Refused when git itself resolves the value to false (verification off,
// revocation checking off), or when git cannot parse the value at all —
// `--bool` makes both cases explicit and keeps valueless (= true) allowed.
export const HOSTILE_TRANSPORT_BOOLEAN_PATTERN =
  '^(https?\\.|https?\\..*\\.)(sslverify|schannelcheckrevoke)$';

// `followRedirects` is an enum that also accepts boolean spellings, so it is
// normalised with `--bool-or-str`: `initial` (git's default) and any boolean
// false stay allowed, everything else — including the valueless form, which is
// boolean true = follow on every request — is refused.
export const HOSTILE_TRANSPORT_REDIRECT_PATTERN =
  '^(https?\\.|https?\\..*\\.)followredirects$';

/** The trailing key component, which is the part that names the setting. */
function transportKeyName(key) {
  return key.slice(key.lastIndexOf('.') + 1).toLowerCase();
}

/**
 * True when a raw (non-boolean) transport entry must block the operation.
 * Key-only entries are hostile whatever their value; `sslVersion` is an enum
 * where only a raised TLS floor is safe, and a valueless or empty sslversion is
 * a nonsense configuration that stays refused.
 */
export function transportEntryIsHostile(key, rawValue) {
  if (transportKeyName(key) === 'sslversion') {
    const normalized = String(rawValue ?? '').trim().toLowerCase();
    return normalized !== 'tlsv1.2' && normalized !== 'tlsv1.3';
  }
  return true;
}

// The `-z` record format is `key LF value NUL`, which keeps keys unambiguous no
// matter what their subsection contains — a URL-scoped subsection with a space
// broke the previous first-space split (see the pattern comment above).
// probe.git() trims stdout, but NUL is not whitespace, so the trailing
// terminator and every interior byte survive; a record without an LF is a
// valueless entry.
function eachTransportRecord(stdout) {
  return stdout.split('\0')
    .filter((record) => record.trim())
    .map((record) => {
      const separator = record.indexOf('\n');
      return separator === -1
        ? { key: record, value: '' }
        : { key: record.slice(0, separator), value: record.slice(separator + 1) };
    });
}

// Ask git to normalise the boolean-ish transport keys instead of parsing raw
// values: with `--bool` the value is always exactly `true` or `false` (the
// valueless form reports true, the explicitly empty form false), and a spelling
// git cannot parse exits fatally — treated as hostile, since git would refuse
// the value later anyway. `--bool-or-str` is the same idea for `followRedirects`,
// whose legal `initial` is not a boolean and passes through as text.
//
// Only an explicit git-resolved `true` passes for the boolean family: any other
// normalised value — `false`, an empty readback, anything unexpected — refuses.
async function normalizedTransportEntriesHostile(cwd, scope, pattern, overrides, { boolOrStr = false } = {}) {
  let result;
  try {
    result = await git(cwd, [
      'config', ...scope, '-z', boolOrStr ? '--bool-or-str' : '--bool', '--get-regexp', pattern,
    ], { ...gitOptions(overrides), acceptExitCodes: [0, 1] });
  } catch {
    return true;
  }
  return eachTransportRecord(result.stdout).some(({ value }) => {
    const normalized = value.trim().toLowerCase();
    if (boolOrStr) return normalized !== 'initial' && normalized !== 'false';
    return normalized !== 'true';
  });
}

// Drivers must be defined in a repository-owned config file. Scoping matters in
// both directions:
//   * `--local` / `--worktree` keep command-line `-c` values (SAFE_GIT_PREFIX
//     passes empty `filter.lfs.*` on every call) and the user's global LFS
//     setup out of the result — an unscoped query matches those and rejects
//     perfectly ordinary repositories.
//   * `--worktree` is a separate scope holding `config.worktree`, which
//     `--local` never reports. It can only be queried when the repository
//     enables `extensions.worktreeConfig`; otherwise git aborts with a fatal
//     error, so the scope is resolved per repository rather than hard-coded.
//   * `--includes` is required because the default for `--get-regexp` is to
//     ignore `include.path` / `includeIf`, where a driver can be hidden.
const BASE_CONFIG_SCOPES = ['--local', '--worktree'];

async function configScopes(cwd, overrides) {
  const scopes = [['--local', '--includes']];
  // Git accepts `true`, `yes`, `on`, `1` and an empty value as boolean true.
  // Comparing against the literal string would miss `1` and `yes`, and the
  // driver in config.worktree would then load unprotected. `--bool` applies
  // git's own normalisation; the include expansion matters because the flag
  // can be set from an included file too.
  const enabled = await git(
    cwd, ['config', '--local', '--includes', '--bool', '--get', 'extensions.worktreeConfig'], gitOptions(overrides),
  );
  if (enabled.stdout.trim() === 'true') scopes.push(['--worktree', '--includes']);
  return scopes;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BUFFER = 2 * 1024 * 1024;

function gitOptions(overrides = {}) {
  return {
    timeoutMs: overrides.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: overrides.maxBuffer ?? DEFAULT_MAX_BUFFER,
    acceptExitCodes: overrides.acceptExitCodes ?? [0, 1],
  };
}

// Only `filter=<driver>` names a driver. A bare `filter` sets the attribute to
// true without naming anything and `-filter` unsets it; both are inert and
// extremely common (`*.png -diff`, `[attr]binary -diff -merge -text`), so
// treating them as hostile would lock benign repositories out entirely.
function hasFilterDriver(content) {
  return content.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return false;
    return trimmed.split(/\s+/).slice(1).some((token) => /^filter=.+/i.test(token));
  });
}

// Git expands a leading `~/` in core.attributesFile; path.resolve does not, so
// without this the source would be missed and the guard silently bypassed.
function resolveConfigPath(cwd, value) {
  return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : path.resolve(cwd, value);
}

async function attributeFileCandidates(cwd, overrides) {
  const listed = await git(
    cwd,
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', '*.gitattributes'],
    gitOptions(overrides),
  );
  const paths = listed.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
    .map((value) => path.resolve(cwd, value));

  // Git reads info/attributes from the common directory (shared by every linked
  // worktree) and, for worktree-scoped state, from the per-worktree admin
  // directory. Both are outside the working tree, so a file scan cannot see
  // either; ask git where they are.
  const [common, worktreeDir] = await Promise.all([
    git(cwd, ['rev-parse', '--git-common-dir'], gitOptions(overrides)),
    git(cwd, ['rev-parse', '--git-dir'], gitOptions(overrides)),
  ]);
  for (const directory of [common.stdout, worktreeDir.stdout]) {
    if (directory) paths.push(path.resolve(cwd, directory, 'info', 'attributes'));
  }

  for (const scope of await configScopes(cwd, overrides)) {
    const custom = await git(cwd, ['config', ...scope, '--get', 'core.attributesFile'], gitOptions(overrides));
    if (custom.stdout) paths.push(resolveConfigPath(cwd, custom.stdout));
  }
  return [...new Set(paths)];
}

async function findFilterAttributeFile(cwd, overrides) {
  for (const candidate of await attributeFileCandidates(cwd, overrides)) {
    let content;
    try {
      content = await readFile(candidate, 'utf8');
    } catch (error) {
      // A source git can read but this process cannot is indistinguishable from
      // one that hides a driver, so fail closed instead of skipping it.
      if (error?.code !== 'ENOENT') return candidate;
      continue;
    }
    if (hasFilterDriver(content)) return candidate;
  }
  return null;
}

function firstKey(stdout) {
  return stdout.split(/\r?\n/).map((line) => line.split(/\s+/)[0]).filter(Boolean)[0];
}

// The `-z` record format keeps the key/value boundary unambiguous (see
// eachTransportRecord); this query only decides presence and the sslVersion
// enum, but it reads the same unambiguous records so a space inside a
// URL-scoped subsection cannot masquerade as a separator.
function hasHostileTransportEntry(stdout) {
  return eachTransportRecord(stdout).some(({ key, value }) => transportEntryIsHostile(key, value));
}

/**
 * Inspect the repository configuration and attribute sources that can make Git
 * execute attacker-chosen commands or redirect a push destination.
 *
 * @returns {Promise<null | {kind: 'filter' | 'remote' | 'transport' | 'attributes'}>}
 */
export async function findHostileRepositoryConfiguration(cwd, overrides = {}) {
  const scopes = await configScopes(cwd, overrides);
  const [driverResults, redirectResult, transportResults, verifyResults, followResults] = await Promise.all([
    Promise.all(scopes.map((scope) => git(
      cwd, ['config', ...scope, '--get-regexp', HOSTILE_LOCAL_CONFIG_PATTERN], gitOptions(overrides),
    ))),
    // A URL rewrite is just as dangerous from any scope. This query is
    // deliberately unscoped because SAFE_GIT_PREFIX passes no `url.*` or
    // `remote.*` key of its own, so it cannot match Cockpit's own -c values.
    git(cwd, ['config', '--includes', '--get-regexp', HOSTILE_ANY_SCOPE_CONFIG_PATTERN], gitOptions(overrides)),
    // Transport settings must be queried per repository-owned scope, for the
    // same reason the filter pattern is: `git config --get-regexp` also reports
    // command-line `-c` values, and SAFE_GIT_PREFIX now passes
    // `http.proxy=` / `http.sslVerify=true` / `http.extraHeader=` on every call
    // to neutralise those generic keys. An unscoped query therefore matched
    // Cockpit's own resets and reported every clean repository as hostile
    // (measured: `git config --list` shows the three -c entries, and the
    // unscoped get-regexp returns them). `--local`/`--worktree` exclude
    // command-line values while still catching repository-owned ones, and the
    // url-scoped `http.<url>.<key>` spelling is read from the same scopes.
    Promise.all(scopes.map((scope) => git(
      cwd, ['config', ...scope, '-z', '--get-regexp', HOSTILE_TRANSPORT_CONFIG_PATTERN], gitOptions(overrides),
    ))),
    // The two boolean checks use the same repository-owned scopes: command-line
    // `-c` values must stay excluded here too, or SAFE_GIT_PREFIX's own
    // `http.sslVerify=true` reset would silence every repository's weakened
    // setting (and, unscoped, be visible to the query).
    Promise.all(scopes.map((scope) => normalizedTransportEntriesHostile(
      cwd, scope, HOSTILE_TRANSPORT_BOOLEAN_PATTERN, overrides,
    ))),
    Promise.all(scopes.map((scope) => normalizedTransportEntriesHostile(
      cwd, scope, HOSTILE_TRANSPORT_REDIRECT_PATTERN, overrides, { boolOrStr: true },
    ))),
  ]);
  if (driverResults.some((result) => firstKey(result.stdout))) return { kind: 'filter' };
  if (firstKey(redirectResult.stdout)) return { kind: 'remote' };
  if (transportResults.some((result) => hasHostileTransportEntry(result.stdout))) return { kind: 'transport' };
  if (verifyResults.some(Boolean) || followResults.some(Boolean)) return { kind: 'transport' };

  const attribute = await findFilterAttributeFile(cwd, overrides);
  if (attribute) return { kind: 'attributes' };
  return null;
}

// `git status` alone already runs clean filters, so a probe of a hostile
// repository executes attacker-chosen commands before any later guard would
// run. Flows that probe and then write must therefore call this before their
// first probe, not merely before their first write.
export const REPOSITORY_CONFIG_ERROR_CODES = {
  filter: 'GIT_FILTER_UNSUPPORTED',
  attributes: 'GIT_FILTER_UNSUPPORTED',
  remote: 'UNSAFE_REMOTE_URL',
  transport: 'UNSAFE_REMOTE_URL',
};

export async function assertRepositoryAllowed(cwd, overrides = {}) {
  const { messages = REPOSITORY_CONFIG_ERROR_CODES, ...gitOverrides } = overrides;
  const hostile = await findHostileRepositoryConfiguration(cwd, gitOverrides);
  if (hostile) throw repositoryConfigurationError(hostile.kind, { messages });
}

// Flows that only observe a path (folder selection, registration, refresh,
// runs) gate BEFORE their first probe. The repository check itself must not
// turn "not a repository yet" into its own error: those paths are owned by the
// probe that follows and already report FOLDER_NOT_CODE_PROJECT / PROBE_FAILED.
// Only a readable repository with hostile config is rejected here.
export async function assertRepositoryAllowedForProbe(cwd, overrides = {}) {
  try {
    await assertRepositoryAllowed(cwd, overrides);
  } catch (error) {
    const stderr = error?.stderr ?? '';
    if (error?.code === 128
      && (/--local can only be used inside a git repository/i.test(stderr)
        || /not a git repository/i.test(stderr))) return;
    throw error;
  }
}

// Existing call sites keep the error codes their contracts and messages already
// publish; only the detection logic is shared.
export function repositoryConfigurationError(kind, { messages }) {
  const detail = {
    filter: 'Git clean/smudge/process filters, including LFS, are not supported.',
    attributes: 'Git clean/smudge/process filters, including LFS, are not supported.',
    remote: 'Remote overrides are not supported.',
    // Names the setting family, never the value: a repository controls both,
    // and this text reaches the UI. Kept accurate for every key in the pattern:
    // forcing a cipher list or a cookie store is neither a redirect nor a
    // switched-off verification, so the wording covers the whole family.
    transport: 'Repository-owned Git transport settings that change where a connection goes, who it trusts, or what it sends are not supported.',
  }[kind];
  return Object.assign(new Error(detail), { code: messages[kind] });
}
