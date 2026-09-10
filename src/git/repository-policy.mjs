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
//
// Cockpit cannot prove a hostile driver is absent, so it fails closed before
// any Git operation that could invoke one.
export const HOSTILE_LOCAL_CONFIG_PATTERN =
  '^(filter\\..*\\.(clean|smudge|process)|diff\\..*\\.(command|textconv))$';
export const HOSTILE_ANY_SCOPE_CONFIG_PATTERN =
  '^(url\\..*\\.(insteadof|pushinsteadof)|remote\\..*\\.(uploadpack|receivepack|proxy))$';

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

/**
 * Inspect the repository configuration and attribute sources that can make Git
 * execute attacker-chosen commands or redirect a push destination.
 *
 * @returns {Promise<null | {kind: 'filter' | 'remote' | 'attributes'}>}
 */
export async function findHostileRepositoryConfiguration(cwd, overrides = {}) {
  const scopes = await configScopes(cwd, overrides);
  const [driverResults, redirectResult] = await Promise.all([
    Promise.all(scopes.map((scope) => git(
      cwd, ['config', ...scope, '--get-regexp', HOSTILE_LOCAL_CONFIG_PATTERN], gitOptions(overrides),
    ))),
    // A URL rewrite is just as dangerous from any scope, and this pattern can
    // never match the command-line LFS entries, so all scopes are queried here.
    git(cwd, ['config', '--includes', '--get-regexp', HOSTILE_ANY_SCOPE_CONFIG_PATTERN], gitOptions(overrides)),
  ]);
  if (driverResults.some((result) => firstKey(result.stdout))) return { kind: 'filter' };
  if (firstKey(redirectResult.stdout)) return { kind: 'remote' };

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
  }[kind];
  return Object.assign(new Error(detail), { code: messages[kind] });
}
