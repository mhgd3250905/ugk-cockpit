import { git } from './probe.mjs';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 2 * 1024 * 1024;
const EMPTY_HOOKS_PATH = process.platform === 'win32' ? 'NUL' : '/dev/null';

function options(overrides = {}) {
  return {
    timeoutMs: overrides.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: overrides.maxBuffer ?? DEFAULT_MAX_BUFFER,
  };
}

export async function fastForwardMain(worktreePath, sourceCommit, overrides = {}) {
  await git(
    worktreePath,
    ['-c', `core.hooksPath=${EMPTY_HOOKS_PATH}`, 'merge', '--ff-only', sourceCommit],
    options(overrides),
  );
}

export async function pushIntegratedMain(worktreePath, { remote, branch, ...overrides }) {
  await git(
    worktreePath,
    ['push', '--set-upstream', remote, `refs/heads/${branch}:refs/heads/${branch}`],
    options(overrides),
  );
}
