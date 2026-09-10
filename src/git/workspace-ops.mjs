import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { git, safeGitEnvironment, SAFE_GIT_PREFIX } from './probe.mjs';
import { DELIVERY_CONFIG_ERROR_CODES } from './delivery-ops.mjs';
import { findHostileRepositoryConfiguration, repositoryConfigurationError } from './repository-policy.mjs';

const execFileAsync = promisify(execFile);

// `worktree add` and `switch` both check files out, so a repository-local
// smudge filter — or a filter bound by `.git/info/attributes`, which no working
// tree scan can see — would run with the user's privileges. Creating or reusing
// a managed workspace must therefore fail closed before touching Git.
async function assertWorkspaceRepositoryAllowed(repoPath, overrides = {}) {
  const hostile = await findHostileRepositoryConfiguration(repoPath, overrides);
  if (hostile) throw repositoryConfigurationError(hostile.kind, { messages: DELIVERY_CONFIG_ERROR_CODES });
}

export function generateStableBranchName(opaqueOrProjectId, maybeCommandId) {
  if (typeof opaqueOrProjectId === 'object' && opaqueOrProjectId !== null) {
    const { projectId = '', commandId = '' } = opaqueOrProjectId;
    const opaque = createHash('sha256').update(`${projectId}\0${commandId}`).digest('hex').slice(0, 16);
    return `cockpit/work/${opaque}`;
  }
  if (typeof opaqueOrProjectId === 'string' && typeof maybeCommandId === 'string') {
    const opaque = createHash('sha256').update(`${opaqueOrProjectId}\0${maybeCommandId}`).digest('hex').slice(0, 16);
    return `cockpit/work/${opaque}`;
  }
  if (typeof opaqueOrProjectId === 'string') {
    if (opaqueOrProjectId.startsWith('cockpit/work/')) {
      return opaqueOrProjectId;
    }
    return `cockpit/work/${opaqueOrProjectId}`;
  }
  const seed = randomBytes(8).toString('hex');
  return `cockpit/work/${seed}`;
}

export function isStableWorkspaceBranch(branch) {
  return typeof branch === 'string' && /^cockpit\/work\/[a-zA-Z0-9_-]+$/.test(branch);
}

// baseCommit sits in the trailing revision position of `git worktree add` /
// `git switch`, where git still parses leading-dash tokens as OPTIONS (e.g. a
// "--force" there would be consumed as a flag, not a revision). The callers
// always mean a full object id reported by `git rev-parse HEAD`, so accept
// exactly that and nothing else.
export const GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function assertGitObjectId(baseCommit) {
  if (typeof baseCommit !== 'string' || !GIT_OBJECT_ID_PATTERN.test(baseCommit)) {
    const error = new Error('baseCommit must be a full git object id (40 or 64 hex characters).');
    error.code = 'INVALID_BASE_COMMIT';
    throw error;
  }
}

export async function checkBranchExists(repoPath, branchName, { timeoutMs = 5000, maxBuffer = 1024 * 1024 } = {}) {
  const result = await git(
    repoPath,
    ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`],
    { timeoutMs, maxBuffer, acceptExitCodes: [0, 1] },
  );
  if (result.exitCode === 0) {
    return result.stdout.length > 0;
  }
  if (result.exitCode === 1) {
    return false;
  }
  const error = new Error(`Git rev-parse exited with code ${result.exitCode}`);
  error.code = 'GIT_ERROR';
  throw error;
}

export async function listGitWorktrees(repoPath, { timeoutMs = 5000, maxBuffer = 2 * 1024 * 1024 } = {}) {
  const result = await git(repoPath, ['worktree', 'list', '--porcelain'], { timeoutMs, maxBuffer });
  const raw = result.stdout;
  const blocks = raw.split(/\r?\n\r?\n/).map((b) => b.trim()).filter(Boolean);
  const worktrees = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const entry = {};
    for (const line of lines) {
      if (line.startsWith('worktree ')) entry.worktree = line.slice('worktree '.length).trim();
      else if (line.startsWith('HEAD ')) entry.head = line.slice('HEAD '.length).trim();
      else if (line.startsWith('branch ')) entry.branch = line.slice('branch '.length).trim();
      else if (line === 'bare') entry.bare = true;
      else if (line === 'detached') entry.detached = true;
    }
    if (entry.worktree) worktrees.push(entry);
  }
  return worktrees;
}

export async function createGitWorktree(repoPath, {
  targetPath,
  branch,
  baseCommit,
  timeoutMs = 15000,
  maxBuffer = 2 * 1024 * 1024,
}) {
  if (!targetPath) {
    const error = new Error('targetPath is required.');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  if (!branch) {
    const error = new Error('branch is required.');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  if (!baseCommit) {
    const error = new Error('baseCommit is required.');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  assertGitObjectId(baseCommit);

  await assertWorkspaceRepositoryAllowed(repoPath);
  try {
    const result = await execFileAsync(
      'git',
      [...SAFE_GIT_PREFIX, 'worktree', 'add', '-b', branch, targetPath, baseCommit],
      {
        cwd: repoPath,
        timeout: timeoutMs,
        maxBuffer,
        windowsHide: true,
        shell: false,
        encoding: 'utf8',
        env: safeGitEnvironment(),
      },
    );
    return { ok: true, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() };
  } catch (error) {
    const gitError = new Error(`Failed to create git worktree: ${error.message}`, { cause: error });
    gitError.code = 'GIT_WORKTREE_ADD_FAILED';
    gitError.stderr = error.stderr;
    gitError.stdout = error.stdout;
    gitError.exitCode = error.code;
    throw gitError;
  }
}

export async function switchGitWorktreeToNewBranch(worktreePath, {
  branch,
  baseCommit,
  timeoutMs = 15_000,
  maxBuffer = 2 * 1024 * 1024,
}) {
  if (!branch) {
    const error = new Error('branch is required.');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  if (!baseCommit) {
    const error = new Error('baseCommit is required.');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  assertGitObjectId(baseCommit);

  await assertWorkspaceRepositoryAllowed(worktreePath);
  try {
    const result = await execFileAsync(
      'git',
      [...SAFE_GIT_PREFIX, 'switch', '-c', branch, baseCommit],
      {
        cwd: worktreePath,
        timeout: timeoutMs,
        maxBuffer,
        windowsHide: true,
        shell: false,
        encoding: 'utf8',
        env: safeGitEnvironment(),
      },
    );
    return { ok: true, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() };
  } catch (error) {
    const gitError = new Error(`Failed to start a fresh workspace branch: ${error.message}`, { cause: error });
    gitError.code = 'GIT_WORKTREE_SWITCH_FAILED';
    gitError.stderr = error.stderr;
    gitError.stdout = error.stdout;
    gitError.exitCode = error.code;
    throw gitError;
  }
}

export async function removeGitWorktree(repoPath, {
  targetPath,
  timeoutMs = 15_000,
  maxBuffer = 2 * 1024 * 1024,
}) {
  if (!targetPath) {
    const error = new Error('targetPath is required.');
    error.code = 'INVALID_REQUEST';
    throw error;
  }

  try {
    const result = await execFileAsync(
      'git',
      [...SAFE_GIT_PREFIX, 'worktree', 'remove', '--', targetPath],
      {
        cwd: repoPath,
        timeout: timeoutMs,
        maxBuffer,
        windowsHide: true,
        shell: false,
        encoding: 'utf8',
        env: safeGitEnvironment(),
      },
    );
    return { ok: true, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() };
  } catch (error) {
    const gitError = new Error(`Failed to remove development workspace: ${error.message}`, { cause: error });
    gitError.code = 'GIT_WORKTREE_REMOVE_FAILED';
    gitError.stderr = error.stderr;
    gitError.stdout = error.stdout;
    gitError.exitCode = error.code;
    throw gitError;
  }
}
