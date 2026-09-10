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
//   url.*.insteadOf|pushInsteadOf          -> silently rewrites a push target
//   remote.*.uploadpack|receivepack|proxy  -> runs on fetch / push
//   http.* transport keys                  -> see HOSTILE_TRANSPORT_CONFIG_PATTERN
//
// Cockpit cannot prove a hostile driver is absent, so it fails closed before
// any Git operation that could invoke one.
export const HOSTILE_LOCAL_CONFIG_PATTERN =
  '^(filter\\..*\\.(clean|smudge|process)|diff\\..*\\.(command|textconv))$';
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
//     these are value-aware: see TRANSPORT_SAFE_VALUES.
//
// An unrecognised value for a value-aware key is treated as hostile. That
// matches git, which fails the operation outright on a bad boolean, so failing
// closed here costs nothing and never silently accepts a weakened setting.
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
  + '|sslcainfo|sslcapath|sslcert|sslkey|pinnedpubkey|sslcipherlist'
  + '|sslverify|sslversion|schannelcheckrevoke|followredirects)$';

// Values that leave a value-aware key at least as strict as git's default. Any
// other value for the same key is refused, including ones git itself rejects.
const TRANSPORT_SAFE_VALUES = new Map([
  ['sslverify', new Set(['true', 'yes', 'on', '1'])],
  ['schannelcheckrevoke', new Set(['true', 'yes', 'on', '1'])],
  // `initial` is git's default: redirects are followed for the first request
  // only, and git drops the Authorization header when the host changes.
  ['followredirects', new Set(['initial', 'false', 'no', 'off', '0', 'none'])],
  ['sslversion', new Set(['tlsv1.2', 'tlsv1.3'])],
]);

/** The trailing key component, which is the part that names the setting. */
function transportKeyName(key) {
  return key.slice(key.lastIndexOf('.') + 1).toLowerCase();
}

/**
 * True when this config entry must block the operation. Key-only entries are
 * always hostile; value-aware entries are hostile unless the value is one of
 * the safe spellings.
 */
export function transportEntryIsHostile(key, rawValue) {
  const safeValues = TRANSPORT_SAFE_VALUES.get(transportKeyName(key));
  if (!safeValues) return true;
  return !safeValues.has(String(rawValue ?? '').trim().toLowerCase());
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

// `git config --get-regexp` prints `key value` with the value taken verbatim, so
// only the first space separates them (an `http.extraHeader` value contains
// spaces of its own). Value-aware entries need the value, not just the key.
function hasHostileTransportEntry(stdout) {
  return stdout.split(/\r?\n/).some((line) => {
    if (!line.trim()) return false;
    const separator = line.indexOf(' ');
    const key = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? '' : line.slice(separator + 1);
    return transportEntryIsHostile(key, value);
  });
}

/**
 * Inspect the repository configuration and attribute sources that can make Git
 * execute attacker-chosen commands or redirect a push destination.
 *
 * @returns {Promise<null | {kind: 'filter' | 'remote' | 'transport' | 'attributes'}>}
 */
export async function findHostileRepositoryConfiguration(cwd, overrides = {}) {
  const scopes = await configScopes(cwd, overrides);
  const [driverResults, redirectResult, transportResults] = await Promise.all([
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
    // The values matter here, so these results are read entry by entry rather
    // than reduced to the first key.
    Promise.all(scopes.map((scope) => git(
      cwd, ['config', ...scope, '--get-regexp', HOSTILE_TRANSPORT_CONFIG_PATTERN], gitOptions(overrides),
    ))),
  ]);
  if (driverResults.some((result) => firstKey(result.stdout))) return { kind: 'filter' };
  if (firstKey(redirectResult.stdout)) return { kind: 'remote' };
  if (transportResults.some((result) => hasHostileTransportEntry(result.stdout))) return { kind: 'transport' };

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
