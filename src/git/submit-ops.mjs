import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git, GIT_OBJECT_ID_PATTERN } from './probe.mjs';
import { assertSafePushTarget, checkUnfinishedGitOperations, DELIVERY_CONFIG_ERROR_CODES, mirrorResetArguments } from './delivery-ops.mjs';
import { findHostileRepositoryConfiguration, repositoryConfigurationError } from './repository-policy.mjs';

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
  // The same unfinished-operation definition the delivery preflight uses: an
  // unresolved conflict lives in the index as stage 1/2/3 entries and may leave
  // no marker file behind, and the `git add --all` below would resolve it by
  // staging the conflict markers.
  await checkUnfinishedGitOperations(worktreePath);
  const [stagedEntries, hostile] = await Promise.all([
    git(worktreePath, ['ls-files', '--stage'], options(overrides)),
    findHostileRepositoryConfiguration(worktreePath, overrides),
  ]);
  if (stagedEntries.stdout.split(/\r?\n/).some((line) => line.startsWith('160000 '))) {
    const error = new Error('Submodules are not supported by managed submission yet.');
    error.code = 'SUBMODULE_UNSUPPORTED';
    throw error;
  }
  if (hostile) throw repositoryConfigurationError(hostile.kind, { messages: DELIVERY_CONFIG_ERROR_CODES });
}

export async function stageAllChanges(worktreePath, overrides = {}) {
  await git(worktreePath, ['add', '--all'], options(overrides));
}

export async function ensureLocalCommitIdentity(worktreePath, { globalConfigPath = process.env.GIT_CONFIG_GLOBAL || path.join(os.homedir(), '.gitconfig'), ...overrides } = {}) {
  const gitOptions = { ...options(overrides), acceptExitCodes: [0, 1] };
  const [name, email] = await Promise.all([
    git(worktreePath, ['config', '--local', '--get', 'user.name'], gitOptions),
    git(worktreePath, ['config', '--local', '--get', 'user.email'], gitOptions),
  ]);

  let authorName = name.stdout?.trim();
  let authorEmail = email.stdout?.trim();

  if (!authorName && existsSync(globalConfigPath)) {
    const globalName = await git(worktreePath, ['config', '--file', globalConfigPath, '--no-includes', '--get', 'user.name'], gitOptions);
    authorName = globalName.stdout?.trim();
  }
  if (!authorEmail && existsSync(globalConfigPath)) {
    const globalEmail = await git(worktreePath, ['config', '--file', globalConfigPath, '--no-includes', '--get', 'user.email'], gitOptions);
    authorEmail = globalEmail.stdout?.trim();
  }

  authorName = authorName || process.env.GIT_AUTHOR_NAME || process.env.GIT_COMMITTER_NAME;
  authorEmail = authorEmail || process.env.GIT_AUTHOR_EMAIL || process.env.GIT_COMMITTER_EMAIL;

  if (!authorName || !authorEmail || /[\r\n\0]/.test(authorName) || /[\r\n\0]/.test(authorEmail)) {
    const error = new Error('This repository has no Git author name and email configured.');
    error.code = 'COMMIT_IDENTITY_MISSING';
    throw error;
  }
  return { name: authorName, email: authorEmail };
}

export async function createSubmissionCommit(worktreePath, { summary, commandId, authorName, authorEmail, ...overrides }) {
  const trailer = `UGK-Cockpit-Command: ${commandId}`;
  const config = [];
  if (authorName && authorEmail) {
    config.push('-c', `user.name=${authorName}`, '-c', `user.email=${authorEmail}`);
  }
  await git(
    worktreePath,
    ['commit', '--no-gpg-sign', '-m', summary, '-m', trailer],
    { ...options(overrides), config },
  );
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

function assertCommitId(value, name) {
  if (typeof value !== 'string' || !GIT_OBJECT_ID_PATTERN.test(value)) {
    const error = new Error(`${name} must be a full git object id (40 or 64 hex characters).`);
    error.code = 'INVALID_COMMIT_ID';
    throw error;
  }
}

export async function isCommitDescendant(worktreePath, ancestor, descendant, overrides = {}) {
  // Both ids sit in revision positions of `merge-base --is-ancestor`, where
  // git still parses leading-dash tokens as OPTIONS. Callers always mean full
  // object ids read back from git, so accept exactly that.
  assertCommitId(ancestor, 'ancestor');
  assertCommitId(descendant, 'descendant');
  const result = await git(
    worktreePath,
    ['merge-base', '--is-ancestor', ancestor, descendant],
    { ...options(overrides), acceptExitCodes: [0, 1] },
  );
  return result.exitCode === 0;
}

export async function pushSubmissionBranch(worktreePath, { remote, branch, ...overrides }) {
  await assertSafePushTarget(worktreePath, remote, overrides);
  await git(
    worktreePath,
    [...mirrorResetArguments(remote), 'push', '--set-upstream', remote, `refs/heads/${branch}:refs/heads/${branch}`],
    options(overrides),
  );
}
