import { git } from './probe.mjs';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 2 * 1024 * 1024;

function options(overrides = {}) {
  return {
    timeoutMs: overrides.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: overrides.maxBuffer ?? DEFAULT_MAX_BUFFER,
  };
}

export async function listGitRemotes(worktreePath, overrides = {}) {
  const result = await git(worktreePath, ['remote'], options(overrides));
  return result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
}

export function choosePushRemote(remotes) {
  if (remotes.includes('origin')) return 'origin';
  if (remotes.length === 1) return remotes[0];
  const error = new Error(remotes.length === 0
    ? 'No Git remote is configured.'
    : 'More than one Git remote is configured and none is named origin.');
  error.code = remotes.length === 0 ? 'PUSH_REMOTE_MISSING' : 'PUSH_REMOTE_AMBIGUOUS';
  throw error;
}

export async function hasUncommittedChanges(worktreePath, overrides = {}) {
  const result = await git(worktreePath, ['status', '--porcelain=v1', '-z'], options(overrides));
  return result.stdout.length > 0;
}

export async function rejectUnsupportedSubmitFeatures(worktreePath, overrides = {}) {
  const gitOptions = { ...options(overrides), acceptExitCodes: [0, 1] };
  const [stagedEntries, localFilters, attributeFilters] = await Promise.all([
    git(worktreePath, ['ls-files', '--stage'], options(overrides)),
    git(worktreePath, ['config', '--local', '--get-regexp', '^filter\\..*\\.(clean|process)$'], gitOptions),
    git(
      worktreePath,
      ['grep', '--untracked', '-I', '-n', '-E', 'filter[[:space:]]*=', '--', '*.gitattributes'],
      gitOptions,
    ),
  ]);
  if (stagedEntries.stdout.split(/\r?\n/).some((line) => line.startsWith('160000 '))) {
    const error = new Error('Submodules are not supported by managed submission yet.');
    error.code = 'SUBMODULE_UNSUPPORTED';
    throw error;
  }
  if (localFilters.stdout || attributeFilters.stdout) {
    const error = new Error('Git clean/process filters, including LFS, are not supported by managed submission yet.');
    error.code = 'GIT_FILTER_UNSUPPORTED';
    throw error;
  }
}

export async function stageAllChanges(worktreePath, overrides = {}) {
  await git(worktreePath, ['add', '--all'], options(overrides));
}

export async function ensureLocalCommitIdentity(worktreePath, overrides = {}) {
  const gitOptions = { ...options(overrides), acceptExitCodes: [0, 1] };
  const [name, email] = await Promise.all([
    git(worktreePath, ['config', '--local', '--get', 'user.name'], gitOptions),
    git(worktreePath, ['config', '--local', '--get', 'user.email'], gitOptions),
  ]);
  if (!name.stdout || !email.stdout) {
    const error = new Error('This repository has no local Git author name and email configured.');
    error.code = 'COMMIT_IDENTITY_MISSING';
    throw error;
  }
  return { name: name.stdout, email: email.stdout };
}

export async function createSubmissionCommit(worktreePath, { summary, commandId, ...overrides }) {
  const trailer = `UGK-Cockpit-Command: ${commandId}`;
  await git(worktreePath, ['commit', '--no-gpg-sign', '-m', summary, '-m', trailer], options(overrides));
}

export async function readHeadMetadata(worktreePath, overrides = {}) {
  const result = await git(
    worktreePath,
    ['log', '-1', '--format=%H%x00%P%x00%B'],
    options(overrides),
  );
  const [head = '', parentsText = '', ...bodyParts] = result.stdout.split('\0');
  return {
    head: head.trim(),
    parents: parentsText.trim().split(/\s+/).filter(Boolean),
    body: bodyParts.join('\0').trim(),
  };
}

export function isRecoverableSubmissionCommit(metadata, { commandId, startHead }) {
  return metadata.parents.length === 1
    && metadata.parents[0] === startHead
    && metadata.body.split(/\r?\n/).some((line) => line.trim() === `UGK-Cockpit-Command: ${commandId}`);
}

export async function isCommitDescendant(worktreePath, ancestor, descendant, overrides = {}) {
  const result = await git(
    worktreePath,
    ['merge-base', '--is-ancestor', ancestor, descendant],
    { ...options(overrides), acceptExitCodes: [0, 1] },
  );
  return result.exitCode === 0;
}

export async function pushSubmissionBranch(worktreePath, { remote, branch, ...overrides }) {
  await git(
    worktreePath,
    ['push', '--set-upstream', remote, `refs/heads/${branch}:refs/heads/${branch}`],
    options(overrides),
  );
}
