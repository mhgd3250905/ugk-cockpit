import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { git, safeGitEnvironment, SAFE_GIT_PREFIX } from './probe.mjs';

const execFileAsync = promisify(execFile);

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
