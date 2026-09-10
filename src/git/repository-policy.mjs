import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { git } from './probe.mjs';

// Repository-local configuration is attacker-controlled whenever Cockpit is
// pointed at a repository it did not author. Git reads classes of settings that
// turn ordinary operations into command execution or redirect a destination:
//
//   filter.<driver>.clean|smudge|process   -> runs on `git add` / checkout
//   diff.<driver>.command|textconv         -> runs on `git diff` / `log -p`
//   url.*.insteadOf|pushInsteadOf          -> silently rewrites a push target
//   remote.*.uploadpack|receivepack|proxy  -> runs on fetch / push
//
// The first two only fire through a driver that the local config defines, so
// that query is scoped to `--local`. A URL rewrite is just as dangerous coming
// from any scope — the original delivery check deliberately queried every scope,
// and narrowing it would let a global pushInsteadOf redirect a push that the URL
// validator never sees.
export const HOSTILE_LOCAL_CONFIG_PATTERN =
  '^(filter\\..*\\.(clean|smudge|process)|diff\\..*\\.(command|textconv))$';
export const HOSTILE_ANY_SCOPE_CONFIG_PATTERN =
  '^(url\\..*\\.(insteadof|pushinsteadof)|remote\\..*\\.(uploadpack|receivepack|proxy))$';

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

  // In a linked worktree git only reads `$GIT_COMMON_DIR/info/attributes`, not
  // the per-worktree admin directory, so the common dir is the path to check.
  const common = await git(cwd, ['rev-parse', '--git-common-dir'], gitOptions(overrides));
  if (common.stdout) paths.push(path.resolve(cwd, common.stdout, 'info', 'attributes'));

  const custom = await git(cwd, ['config', '--local', '--get', 'core.attributesFile'], gitOptions(overrides));
  if (custom.stdout) paths.push(resolveConfigPath(cwd, custom.stdout));
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
  const [localKeys, anyScopeKeys] = await Promise.all([
    git(cwd, ['config', '--local', '--get-regexp', HOSTILE_LOCAL_CONFIG_PATTERN], gitOptions(overrides)),
    git(cwd, ['config', '--get-regexp', HOSTILE_ANY_SCOPE_CONFIG_PATTERN], gitOptions(overrides)),
  ]);
  if (firstKey(localKeys.stdout)) return { kind: 'filter' };
  if (firstKey(anyScopeKeys.stdout)) return { kind: 'remote' };

  const attribute = await findFilterAttributeFile(cwd, overrides);
  if (attribute) return { kind: 'attributes' };
  return null;
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
