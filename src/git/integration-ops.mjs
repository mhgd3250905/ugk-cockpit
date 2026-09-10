import { git } from './probe.mjs';
import { assertSafePushTarget, DELIVERY_CONFIG_ERROR_CODES, mirrorResetArguments } from './delivery-ops.mjs';
import { findHostileRepositoryConfiguration, repositoryConfigurationError } from './repository-policy.mjs';

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
  // A fast-forward updates the working tree, so repository-local smudge filters
  // would run here before any remote is contacted. Fail closed first.
  const hostile = await findHostileRepositoryConfiguration(worktreePath, overrides);
  if (hostile) throw repositoryConfigurationError(hostile.kind, { messages: DELIVERY_CONFIG_ERROR_CODES });
  await git(
    worktreePath,
    ['-c', `core.hooksPath=${EMPTY_HOOKS_PATH}`, 'merge', '--ff-only', sourceCommit],
    options(overrides),
  );
}

export async function pushIntegratedMain(worktreePath, { remote, branch, ...overrides }) {
  await assertSafePushTarget(worktreePath, remote, overrides);
  await git(
    worktreePath,
    [...mirrorResetArguments(remote), 'push', '--set-upstream', remote, `refs/heads/${branch}:refs/heads/${branch}`],
    options(overrides),
  );
}
