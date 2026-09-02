import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  openCockpitDatabase,
  SUPPORTED_SCHEMA_VERSION,
} from '../src/core/database.mjs';
import { EmptyFolderGrantStore } from '../src/core/folder-grants.mjs';
import {
  authorizeEmptyDirectory,
} from '../src/core/path-guard.mjs';
import {
  createDevelopmentWorkspace,
  createWorkspace,
  listDevelopmentWorkspaces,
  readDevelopmentWorkspace,
} from '../src/core/workspaces.mjs';
import {
  checkBranchExists,
  createGitWorktree,
  generateStableBranchName,
  isStableWorkspaceBranch,
} from '../src/git/workspace-ops.mjs';
import {
  probeGitWorktree,
  safeGitEnvironment,
  SAFE_GIT_PREFIX,
} from '../src/git/probe.mjs';
import { acquireRepositoryLock } from '../src/core/integrations.mjs';

const execFileAsync = promisify(execFile);

async function runGit(cwd, args) {
  return execFileAsync('git', [...SAFE_GIT_PREFIX, ...args], {
    cwd,
    windowsHide: true,
    shell: false,
    encoding: 'utf8',
    env: safeGitEnvironment(),
  });
}

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-workspaces-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openCockpitDatabase(path.join(root, 'cockpit.db'));
  const at = '2026-09-02T00:00:00.000Z';

  const repoDir = path.join(root, 'main-repo');
  mkdirSync(repoDir, { recursive: true });

  db.prepare(`
    INSERT INTO worktrees (
      id, canonical_path, repository_identity, identity_fingerprint, created_at
    ) VALUES ('wt-main', ?, 'repo-id-alpha', 'fp-main', ?)
  `).run(repoDir, at);

  db.prepare(`
    INSERT INTO projects (
      id, name, stage, worktree_id, status, status_reason,
      last_observed_at, created_at, updated_at, repository_identity, authorized_root
    ) VALUES ('proj-1', 'Cockpit Project', 'development',
      'wt-main', 'ready', 'ready_to_start', ?, ?, ?, 'repo-id-alpha', ?)
  `).run(at, at, at, repoDir);

  return { root, db, repoDir };
}

function mockObservation({
  head = 'commit-head-111',
  branch = 'main',
  repositoryIdentity = 'repo-id-alpha',
  worktreeIdentity = null,
  canonicalPath = null,
  hasChanges = false,
  coherence = 'coherent',
} = {}) {
  return (targetPath) => ({
    canonicalPath: canonicalPath ?? targetPath,
    repositoryIdentity,
    worktreeIdentity: worktreeIdentity ?? (targetPath.includes('main') ? 'fp-main' : `fp-${path.basename(targetPath)}`),
    coherence,
    after: {
      head,
      branch,
      hasChanges,
      indexFingerprint: 'idx-fp',
      worktreeFingerprint: 'wt-fp',
    },
    before: {
      head,
      branch,
      hasChanges,
      indexFingerprint: 'idx-fp',
      worktreeFingerprint: 'wt-fp',
    },
    observedAt: '2026-09-02T00:00:00.000Z',
  });
}

async function realGitFixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-real-git-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const db = openCockpitDatabase(path.join(root, 'cockpit.db'));
  const repoDir = path.join(root, 'real-main-repo');
  mkdirSync(repoDir, { recursive: true });

  await runGit(repoDir, ['init', '-b', 'main']);
  await runGit(repoDir, ['config', 'user.name', 'Test User']);
  await runGit(repoDir, ['config', 'user.email', 'test@example.com']);

  writeFileSync(path.join(repoDir, 'README.md'), '# Main Repo\n');
  await runGit(repoDir, ['add', 'README.md']);
  await runGit(repoDir, ['commit', '-m', 'Initial commit']);

  const observation = await probeGitWorktree(repoDir);
  const headSha = observation.after.head;
  const at = new Date().toISOString();

  db.prepare(`
    INSERT INTO worktrees (
      id, canonical_path, repository_identity, identity_fingerprint, created_at
    ) VALUES ('wt-main', ?, ?, ?, ?)
  `).run(observation.canonicalPath, observation.repositoryIdentity, observation.worktreeIdentity, at);

  db.prepare(`
    INSERT INTO projects (
      id, name, stage, worktree_id, status, status_reason,
      last_observed_at, created_at, updated_at, repository_identity, authorized_root
    ) VALUES ('proj-real-1', 'Real Git Project', 'development',
      'wt-main', 'ready', 'ready_to_start', ?, ?, ?, ?, ?)
  `).run(at, at, at, observation.repositoryIdentity, observation.canonicalPath);

  return { root, db, repoDir, headSha, observation };
}

test('normal development workspace creation binds grant, creates branch worktree, and registers development space', async (t) => {
  const { root, db, repoDir } = fixture(t);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SUPPORTED_SCHEMA_VERSION);

  // 1. Create an empty directory
  const emptyTarget = path.join(root, 'space-target-1');
  mkdirSync(emptyTarget);

  // 2. Authorize empty directory and issue grant
  const binding = authorizeEmptyDirectory(emptyTarget);
  const grantStore = new EmptyFolderGrantStore({ db });
  const grant = grantStore.issue(binding, 'principal-user-1');
  assert.equal(grant.canonicalPath, binding.candidateReal);

  let gitWorktreeCreated = false;
  let createdWorktreeArgs = null;

  const mockGitCreate = async (cwd, args) => {
    gitWorktreeCreated = true;
    createdWorktreeArgs = args;
    return { ok: true, stdout: '' };
  };

  const probe = async (target) => {
    if (target === repoDir) {
      return (mockObservation({ head: 'commit-base-aaa', branch: 'main', canonicalPath: repoDir }))(target);
    }
    if (!gitWorktreeCreated) {
      const err = new Error('Not a git repository');
      err.code = 128;
      throw err;
    }
    return (mockObservation({
      head: 'commit-base-aaa',
      branch: createdWorktreeArgs?.branch ?? 'cockpit/work/test',
      canonicalPath: target,
      worktreeIdentity: 'fp-space-target-1',
    }))(target);
  };

  // 3. Create workspace
  const res = await createDevelopmentWorkspace(db, {
    commandId: 'cmd-create-ws-1',
    projectId: 'proj-1',
    name: 'feat-payment',
    grantId: grant.grantId,
    principalHash: 'principal-user-1',
    expectedBaseHead: 'commit-base-aaa',
  }, {
    probe,
    createGitWorktree: mockGitCreate,
    checkBranchExists: async () => false,
  });

  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(gitWorktreeCreated, true);
  assert.ok(isStableWorkspaceBranch(res.branch));
  assert.equal(res.branch, generateStableBranchName('proj-1', 'cmd-create-ws-1'));
  assert.equal(res.baseCommit, 'commit-base-aaa');
  assert.equal(res.repositoryIdentity, 'repo-id-alpha');
  assert.equal(res.status, 'ready');

  // 4. Verify DB records
  const grantRow = db.prepare('SELECT * FROM empty_folder_grants WHERE id = ?').get(grant.grantId);
  assert.equal(grantRow.state, 'consumed');
  assert.equal(grantRow.claimed_by_command, 'cmd-create-ws-1');

  const spaceRow = db.prepare('SELECT * FROM development_spaces WHERE id = ?').get(res.spaceId);
  assert.ok(spaceRow);
  assert.equal(spaceRow.name, 'feat-payment');
  assert.equal(spaceRow.branch, res.branch);
  assert.equal(spaceRow.base_commit, 'commit-base-aaa');

  // 5. Verify repository lock was released
  const lockRow = db.prepare('SELECT * FROM repository_locks WHERE repository_identity = ?').get('repo-id-alpha');
  assert.equal(lockRow, undefined);

  // 6. Read back through readDevelopmentWorkspace
  const readBack = readDevelopmentWorkspace(db, res.spaceId);
  assert.equal(readBack.name, 'feat-payment');
  assert.equal(readBack.projectId, 'proj-1');

  const list = listDevelopmentWorkspaces(db, { projectId: 'proj-1' });
  assert.equal(list.length, 1);

  db.close();
});

test('BASE_HEAD_STALE: creation fails closed if repository current HEAD differs from expectedBaseHead', async (t) => {
  const { root, db, repoDir } = fixture(t);

  const emptyTarget = path.join(root, 'space-stale-head');
  mkdirSync(emptyTarget);
  const binding = authorizeEmptyDirectory(emptyTarget);
  const grantStore = new EmptyFolderGrantStore({ db });
  const grant = grantStore.issue(binding, 'principal-user-1');

  let gitWorktreeCalled = false;
  const probe = async (target) => {
    if (target === repoDir) {
      return (mockObservation({ head: 'actual-new-head-999', canonicalPath: repoDir }))(target);
    }
    const err = new Error('Not a git repository');
    err.code = 128;
    throw err;
  };

  const res = await createDevelopmentWorkspace(db, {
    commandId: 'cmd-create-stale',
    projectId: 'proj-1',
    name: 'stale-test',
    grantId: grant.grantId,
    principalHash: 'principal-user-1',
    expectedBaseHead: 'old-expected-head-111',
  }, {
    probe,
    createGitWorktree: async () => { gitWorktreeCalled = true; },
  });

  assert.equal(res.ok, false);
  assert.equal(res.code, 'BASE_HEAD_STALE');
  assert.equal(gitWorktreeCalled, false);

  // Grant was unclaim'd on pre-side-effects failure
  const grantRow = db.prepare('SELECT * FROM empty_folder_grants WHERE id = ?').get(grant.grantId);
  assert.equal(grantRow.state, 'active');
  assert.equal(grantRow.claimed_by_command, null);

  // No space created
  const spaces = db.prepare('SELECT count(*) AS count FROM development_spaces').get().count;
  assert.equal(spaces, 0);

  // Lock released
  assert.equal(db.prepare('SELECT * FROM repository_locks WHERE repository_identity = ?').get('repo-id-alpha'), undefined);

  db.close();
});

test('DIRECTORY_NOT_EMPTY: rejects non-empty directory at authorization and revalidation', async (t) => {
  const { root, db, repoDir } = fixture(t);

  const dirtyTarget = path.join(root, 'space-non-empty');
  mkdirSync(dirtyTarget);
  writeFileSync(path.join(dirtyTarget, 'existing-file.txt'), 'content');

  // authorizeEmptyDirectory must throw DIRECTORY_NOT_EMPTY
  assert.throws(
    () => authorizeEmptyDirectory(dirtyTarget),
    (err) => err.code === 'DIRECTORY_NOT_EMPTY',
  );

  // If a directory becomes non-empty after grant is issued
  const emptyTarget = path.join(root, 'space-became-dirty');
  mkdirSync(emptyTarget);
  const binding = authorizeEmptyDirectory(emptyTarget);
  const grantStore = new EmptyFolderGrantStore({ db });
  const grant = grantStore.issue(binding, 'principal-user-1');

  // Put a file in the directory after grant issuance
  writeFileSync(path.join(emptyTarget, 'sneaky.txt'), 'surprise');

  let gitWorktreeCalled = false;
  const probe = async (target) => {
    if (target === repoDir) return (mockObservation({ head: 'head-1', canonicalPath: repoDir }))(target);
    const err = new Error('Not a git repository');
    err.code = 128;
    throw err;
  };

  const res = await createDevelopmentWorkspace(db, {
    commandId: 'cmd-became-dirty',
    projectId: 'proj-1',
    grantId: grant.grantId,
    principalHash: 'principal-user-1',
    expectedBaseHead: 'head-1',
  }, {
    probe,
    createGitWorktree: async () => { gitWorktreeCalled = true; },
  });

  assert.equal(res.ok, false);
  assert.equal(res.code, 'DIRECTORY_NOT_EMPTY');
  assert.equal(gitWorktreeCalled, false);

  db.close();
});

test('DIRECTORY_IDENTITY_CHANGED: fails if directory is replaced between grant and creation', async (t) => {
  const { root, db, repoDir } = fixture(t);

  const targetPath = path.join(root, 'space-replaced');
  mkdirSync(targetPath);
  const binding = authorizeEmptyDirectory(targetPath);
  const grantStore = new EmptyFolderGrantStore({ db });
  const grant = grantStore.issue(binding, 'principal-user-1');

  // Change file_identity in DB to simulate directory replacement
  db.prepare("UPDATE empty_folder_grants SET file_identity = 'different-identity-hash' WHERE id = ?").run(grant.grantId);

  let gitWorktreeCalled = false;
  const probe = async (target) => {
    if (target === repoDir) return (mockObservation({ head: 'head-1', canonicalPath: repoDir }))(target);
    const err = new Error('Not a git repository');
    err.code = 128;
    throw err;
  };

  const res = await createDevelopmentWorkspace(db, {
    commandId: 'cmd-identity-changed',
    projectId: 'proj-1',
    grantId: grant.grantId,
    principalHash: 'principal-user-1',
    expectedBaseHead: 'head-1',
  }, {
    probe,
    createGitWorktree: async () => { gitWorktreeCalled = true; },
  });

  assert.equal(res.ok, false);
  assert.equal(res.code, 'DIRECTORY_IDENTITY_CHANGED');
  assert.equal(gitWorktreeCalled, false);

  db.close();
});

test('WORKTREE_PATH_OVERLAP: rejects a target nested inside the main worktree', async (t) => {
  const { db, repoDir } = fixture(t);
  const targetPath = path.join(repoDir, 'nested-space');
  mkdirSync(targetPath);
  const binding = authorizeEmptyDirectory(targetPath);
  const grantStore = new EmptyFolderGrantStore({ db });
  const grant = grantStore.issue(binding, 'principal-overlap');
  let gitWorktreeCalled = false;

  const result = await createDevelopmentWorkspace(db, {
    commandId: 'cmd-overlap',
    projectId: 'proj-1',
    grantId: grant.grantId,
    principalHash: 'principal-overlap',
    expectedBaseHead: 'head-overlap',
  }, {
    probe: async (target) => mockObservation({
      head: 'head-overlap',
      canonicalPath: target,
    })(target),
    createGitWorktree: async () => { gitWorktreeCalled = true; },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'WORKTREE_PATH_OVERLAP');
  assert.equal(gitWorktreeCalled, false);
  assert.equal(grantStore.read(grant.grantId).state, 'active');
  db.close();
});

test('idempotent replay of same commandId returns identical result without duplicate worktree creation', async (t) => {
  const { root, db, repoDir } = fixture(t);

  const targetPath = path.join(root, 'space-idempotent');
  mkdirSync(targetPath);
  const binding = authorizeEmptyDirectory(targetPath);
  const grantStore = new EmptyFolderGrantStore({ db });
  const grant = grantStore.issue(binding, 'principal-1');

  let createCount = 0;
  let gitWorktreeCreated = false;
  const mockGitCreate = async () => {
    createCount += 1;
    gitWorktreeCreated = true;
    return { ok: true, stdout: '' };
  };

  const branchName = 'cockpit/work/idempotent-test';
  const probe = async (target) => {
    if (target === repoDir) return (mockObservation({ head: 'head-idem', canonicalPath: repoDir }))(target);
    if (!gitWorktreeCreated) {
      const err = new Error('Not a git repository');
      err.code = 128;
      throw err;
    }
    return (mockObservation({ head: 'head-idem', branch: branchName, canonicalPath: target }))(target);
  };

  const request = {
    commandId: 'cmd-idem-1',
    projectId: 'proj-1',
    name: 'idempotent-space',
    branch: branchName,
    grantId: grant.grantId,
    principalHash: 'principal-1',
    expectedBaseHead: 'head-idem',
  };

  const res1 = await createDevelopmentWorkspace(db, request, {
    probe,
    createGitWorktree: mockGitCreate,
    checkBranchExists: async () => false,
  });

  assert.equal(res1.ok, true, JSON.stringify(res1));
  assert.equal(createCount, 1);

  // Second execution with same commandId
  const res2 = await createDevelopmentWorkspace(db, request, {
    probe,
    createGitWorktree: mockGitCreate,
    checkBranchExists: async () => false,
  });

  assert.equal(res2.ok, true);
  assert.equal(res2.spaceId, res1.spaceId);
  assert.equal(createCount, 1, 'git worktree must not be invoked on command replay');

  const countSpaces = db.prepare('SELECT count(*) AS count FROM development_spaces WHERE project_id = ?').get('proj-1').count;
  assert.equal(countSpaces, 1);

  db.close();
});

test('crash recovery: worktree already created in Git recovers cleanly when database write was interrupted', async (t) => {
  const { root, db, repoDir } = fixture(t);

  const targetPath = path.join(root, 'space-crash-recovered');
  mkdirSync(targetPath);
  const binding = authorizeEmptyDirectory(targetPath);
  const grantStore = new EmptyFolderGrantStore({ db });
  const grant = grantStore.issue(binding, 'principal-1');

  const branchName = 'cockpit/work/recovered-branch';
  const probe = async (target) => {
    if (target === repoDir) return (mockObservation({ head: 'head-crash', canonicalPath: repoDir }))(target);
    // Target is already a fully formed clean worktree with matching parameters
    return (mockObservation({
      head: 'head-crash',
      branch: branchName,
      repositoryIdentity: 'repo-id-alpha',
      worktreeIdentity: 'fp-crash-recovered',
      canonicalPath: target,
      hasChanges: false,
      coherence: 'coherent',
    }))(target);
  };

  let gitCreateInvoked = false;
  const res = await createDevelopmentWorkspace(db, {
    commandId: 'cmd-crash-retry',
    projectId: 'proj-1',
    name: 'recovered-space',
    branch: branchName,
    grantId: grant.grantId,
    principalHash: 'principal-1',
    expectedBaseHead: 'head-crash',
  }, {
    probe,
    createGitWorktree: async () => { gitCreateInvoked = true; },
  });

  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.statusReason, 'recovered_after_crash');
  assert.equal(gitCreateInvoked, false, 'Should recognize existing worktree and not re-run git worktree add');

  const space = db.prepare('SELECT * FROM development_spaces WHERE id = ?').get(res.spaceId);
  assert.ok(space);
  assert.equal(space.branch, branchName);

  db.close();
});

test('transient target probe failure with a Git marker keeps the command recoverable', async (t) => {
  const { root, db, repoDir } = fixture(t);
  const targetPath = path.join(root, 'space-probe-retry');
  mkdirSync(targetPath);
  const binding = authorizeEmptyDirectory(targetPath);
  const grantStore = new EmptyFolderGrantStore({ db });
  const grant = grantStore.issue(binding, 'principal-retry');
  writeFileSync(path.join(targetPath, '.git'), 'gitdir: simulated');

  const branch = generateStableBranchName('proj-1', 'cmd-probe-retry');
  let targetProbeFails = true;
  const probe = async (target) => {
    if (target === repoDir) {
      return mockObservation({ head: 'head-retry', canonicalPath: repoDir })(target);
    }
    if (targetProbeFails) throw new Error('transient probe failure');
    return mockObservation({
      head: 'head-retry',
      branch,
      canonicalPath: targetPath,
      worktreeIdentity: 'fp-probe-retry',
    })(target);
  };
  const request = {
    commandId: 'cmd-probe-retry',
    projectId: 'proj-1',
    grantId: grant.grantId,
    principalHash: 'principal-retry',
    expectedBaseHead: 'head-retry',
  };

  const first = await createDevelopmentWorkspace(db, request, { probe });
  assert.equal(first.ok, false);
  assert.equal(first.code, 'WORKTREE_RECOVERY_UNCERTAIN');
  assert.equal(first.retryable, true);
  assert.equal(db.prepare('SELECT state FROM commands WHERE id = ?').get(request.commandId).state, 'received');
  assert.equal(grantStore.read(grant.grantId).state, 'claimed');

  targetProbeFails = false;
  const second = await createDevelopmentWorkspace(db, request, { probe });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.statusReason, 'recovered_after_crash');
  assert.equal(grantStore.read(grant.grantId).state, 'consumed');
  db.close();
});

test('WORKTREE_RECOVERY_UNCERTAIN: target path has conflicting or dirty worktree and fails closed without deleting files', async (t) => {
  const { root, db, repoDir } = fixture(t);

  const targetPath = path.join(root, 'space-conflict');
  mkdirSync(targetPath);
  const binding = authorizeEmptyDirectory(targetPath);
  const grantStore = new EmptyFolderGrantStore({ db });
  const grant = grantStore.issue(binding, 'principal-1');

  // Probe returns a dirty worktree or different repository identity
  const probe = async (target) => {
    if (target === repoDir) return (mockObservation({ head: 'head-conflict', canonicalPath: repoDir }))(target);
    return (mockObservation({
      head: 'head-conflict',
      branch: 'cockpit/work/some-other-branch',
      repositoryIdentity: 'repo-id-FOREIGN',
      canonicalPath: target,
      hasChanges: true,
      coherence: 'coherent',
    }))(target);
  };

  const res = await createDevelopmentWorkspace(db, {
    commandId: 'cmd-conflict-target',
    projectId: 'proj-1',
    name: 'conflict-space',
    branch: 'cockpit/work/my-branch',
    grantId: grant.grantId,
    principalHash: 'principal-1',
    expectedBaseHead: 'head-conflict',
  }, {
    probe,
  });

  assert.equal(res.ok, false);
  assert.equal(res.code, 'WORKTREE_RECOVERY_UNCERTAIN');
  assert.equal(res.humanActionRequired, true);

  // Command must stay in 'received' state to allow recovery inspection
  const cmd = db.prepare('SELECT state FROM commands WHERE id = ?').get('cmd-conflict-target');
  assert.equal(cmd.state, 'received');

  db.close();
});

test('REPOSITORY_LOCKED: fails if repository is locked by another operation and leaves command received', async (t) => {
  const { root, db, repoDir } = fixture(t);

  const targetPath = path.join(root, 'space-locked');
  mkdirSync(targetPath);
  const binding = authorizeEmptyDirectory(targetPath);
  const grantStore = new EmptyFolderGrantStore({ db });
  const grant = grantStore.issue(binding, 'principal-1');

  // Acquire active lock for other holder
  acquireRepositoryLock(db, {
    repositoryIdentity: 'repo-id-alpha',
    holder: 'active-integrator',
    operation: 'merge_submission',
    ttlMs: 60_000,
  });

  const probe = async (target) => {
    if (target === repoDir) return (mockObservation({ head: 'head-1', canonicalPath: repoDir }))(target);
    const err = new Error('Not a git repository');
    err.code = 128;
    throw err;
  };

  const res = await createDevelopmentWorkspace(db, {
    commandId: 'cmd-locked',
    projectId: 'proj-1',
    grantId: grant.grantId,
    principalHash: 'principal-1',
    expectedBaseHead: 'head-1',
  }, {
    probe,
  });

  assert.equal(res.ok, false);
  assert.equal(res.code, 'REPOSITORY_LOCKED');
  assert.equal(res.holder, 'active-integrator');

  // Lock contention is retryable and must NOT permanently fail the command
  const cmd = db.prepare('SELECT state FROM commands WHERE id = ?').get('cmd-locked');
  assert.equal(cmd.state, 'received');

  db.close();
});

test('BRANCH_ALREADY_EXISTS: fails if branch exists in repository and target is empty', async (t) => {
  const { root, db, repoDir } = fixture(t);

  const targetPath = path.join(root, 'space-branch-conflict');
  mkdirSync(targetPath);
  const binding = authorizeEmptyDirectory(targetPath);
  const grantStore = new EmptyFolderGrantStore({ db });
  const grant = grantStore.issue(binding, 'principal-1');

  const probe = async (target) => {
    if (target === repoDir) return (mockObservation({ head: 'head-1', canonicalPath: repoDir }))(target);
    const err = new Error('Not a git repository');
    err.code = 128;
    throw err;
  };

  const res = await createDevelopmentWorkspace(db, {
    commandId: 'cmd-branch-exists',
    projectId: 'proj-1',
    branch: 'cockpit/work/existing-branch',
    grantId: grant.grantId,
    principalHash: 'principal-1',
    expectedBaseHead: 'head-1',
  }, {
    probe,
    checkBranchExists: async () => true,
  });

  assert.equal(res.ok, false);
  assert.equal(res.code, 'BRANCH_ALREADY_EXISTS');

  db.close();
});

test('request validation: commandId, grantId, principalHash, expectedBaseHead, baseCommit, and branch format', async (t) => {
  const { root, db } = fixture(t);

  // Missing commandId
  const res1 = await createDevelopmentWorkspace(db, {
    projectId: 'proj-1',
    grantId: 'g-1',
    principalHash: 'p-1',
    expectedBaseHead: 'h-1',
  });
  assert.equal(res1.ok, false);
  assert.equal(res1.code, 'INVALID_REQUEST');

  // Missing grantId (attempting targetPath bypass)
  const res2 = await createDevelopmentWorkspace(db, {
    commandId: 'cmd-bypass-1',
    projectId: 'proj-1',
    targetPath: 'C:\\arbitrary\\path',
    principalHash: 'p-1',
    expectedBaseHead: 'h-1',
  });
  assert.equal(res2.ok, false);
  assert.equal(res2.code, 'INVALID_REQUEST');

  // Missing principalHash
  const res3 = await createDevelopmentWorkspace(db, {
    commandId: 'cmd-no-p',
    projectId: 'proj-1',
    grantId: 'g-1',
    expectedBaseHead: 'h-1',
  });
  assert.equal(res3.ok, false);
  assert.equal(res3.code, 'INVALID_REQUEST');

  // baseCommit differs from expectedBaseHead
  const res4 = await createDevelopmentWorkspace(db, {
    commandId: 'cmd-mismatch-base',
    projectId: 'proj-1',
    grantId: 'g-1',
    principalHash: 'p-1',
    expectedBaseHead: 'h-1',
    baseCommit: 'different-head',
  });
  assert.equal(res4.ok, false);
  assert.equal(res4.code, 'INVALID_REQUEST');

  // Invalid custom branch format
  const res5 = await createDevelopmentWorkspace(db, {
    commandId: 'cmd-bad-branch',
    projectId: 'proj-1',
    grantId: 'g-1',
    principalHash: 'p-1',
    expectedBaseHead: 'h-1',
    branch: 'feat/my-custom-branch',
  });
  assert.equal(res5.ok, false);
  assert.equal(res5.code, 'INVALID_REQUEST');

  db.close();
});

test('folder grant store: active expired is rejected, claimed grant allows recovery even if expired, safe unclaim', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-grant-test-'));
  const db = openCockpitDatabase(path.join(root, 'cockpit.db'));
  let currentTime = 1000;
  const store = new EmptyFolderGrantStore({ db, clock: () => currentTime, ttlMs: 5000 });

  const grant = store.issue({
    folderPath: 'C:\\test\\path',
    canonicalPath: 'C:\\test\\path',
    fileIdentity: 'fp-1',
  }, 'p-hash-1');

  // Claim once with cmd-1
  const claimed = store.claim(grant.grantId, 'cmd-1', 'p-hash-1');
  assert.equal(claimed.state, 'claimed');
  assert.equal(claimed.claimed_by_command, 'cmd-1');

  // Advance time past TTL (1000 + 5000 = 6000)
  currentTime = 10000;

  // Claim again with same cmd-1 even though TTL has passed: must SUCCEED for crash recovery
  const recovered = store.claim(grant.grantId, 'cmd-1', 'p-hash-1');
  assert.equal(recovered.state, 'claimed');

  // Claim with another command: must fail FOLDER_GRANT_IN_USE
  assert.throws(
    () => store.claim(grant.grantId, 'cmd-2', 'p-hash-1'),
    (err) => err.code === 'FOLDER_GRANT_IN_USE',
  );

  // Unclaim resets state to active and clears claimed_by_command
  const unclaimRes = store.unclaim(grant.grantId, 'cmd-1');
  assert.equal(unclaimRes, true);

  // Since time is 10000 and TTL expired, active grant is now rejected with FOLDER_GRANT_EXPIRED
  assert.throws(
    () => store.claim(grant.grantId, 'cmd-3', 'p-hash-1'),
    (err) => err.code === 'FOLDER_GRANT_EXPIRED',
  );

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('main probe: verifies canonical path, repository identity, worktree identity, and coherence', async (t) => {
  const { root, db, repoDir } = fixture(t);

  const emptyTarget = path.join(root, 'space-main-probe-test');
  mkdirSync(emptyTarget);
  const binding = authorizeEmptyDirectory(emptyTarget);
  const grantStore = new EmptyFolderGrantStore({ db });
  const grant = grantStore.issue(binding, 'p-1');

  // Incoherent main worktree
  const incoherentProbe = async () => mockObservation({
    head: 'h-1',
    coherence: 'incoherent',
    worktreeIdentity: 'fp-main',
    canonicalPath: repoDir,
  })(repoDir);

  const res1 = await createDevelopmentWorkspace(db, {
    commandId: 'cmd-incoherent-main',
    projectId: 'proj-1',
    grantId: grant.grantId,
    principalHash: 'p-1',
    expectedBaseHead: 'h-1',
  }, { probe: incoherentProbe });

  assert.equal(res1.ok, false);
  assert.equal(res1.code, 'MAIN_WORKTREE_INCOHERENT');

  // Mismatched repository identity
  const wrongRepoProbe = async () => mockObservation({
    head: 'h-1',
    repositoryIdentity: 'repo-different',
    worktreeIdentity: 'fp-main',
    canonicalPath: repoDir,
  })(repoDir);

  const res2 = await createDevelopmentWorkspace(db, {
    commandId: 'cmd-wrong-repo',
    projectId: 'proj-1',
    grantId: grant.grantId,
    principalHash: 'p-1',
    expectedBaseHead: 'h-1',
  }, { probe: wrongRepoProbe });

  assert.equal(res2.ok, false);
  assert.equal(res2.code, 'REPOSITORY_IDENTITY_MISMATCH');

  db.close();
});

test('checkBranchExists: throws on unexpected git errors and differentiates exit code 0 vs 1', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-chkbranch-'));
  const repoDir = path.join(root, 'chk-repo');
  mkdirSync(repoDir, { recursive: true });

  await runGit(repoDir, ['init', '-b', 'main']);
  await runGit(repoDir, ['config', 'user.name', 'Test']);
  await runGit(repoDir, ['config', 'user.email', 'test@example.com']);
  writeFileSync(path.join(repoDir, 'file.txt'), 'hello');
  await runGit(repoDir, ['add', 'file.txt']);
  await runGit(repoDir, ['commit', '-m', 'init']);

  // Branch 'main' exists
  const exists = await checkBranchExists(repoDir, 'main');
  assert.equal(exists, true);

  // Branch 'nonexistent' does not exist
  const notExists = await checkBranchExists(repoDir, 'nonexistent');
  assert.equal(notExists, false);

  // Non-git directory throws error instead of returning false
  const nonGitDir = path.join(root, 'not-a-git-dir');
  mkdirSync(nonGitDir, { recursive: true });
  await assert.rejects(
    () => checkBranchExists(nonGitDir, 'main'),
  );

  rmSync(root, { recursive: true, force: true });
});

test('stable branch name generator creates cockpit/work/<opaque> format deterministically', () => {
  const branch1 = generateStableBranchName();
  assert.ok(isStableWorkspaceBranch(branch1));
  assert.ok(branch1.startsWith('cockpit/work/'));

  const branch2 = generateStableBranchName('custom_opaque_123');
  assert.equal(branch2, 'cockpit/work/custom_opaque_123');
  assert.ok(isStableWorkspaceBranch(branch2));

  // Deterministic branch generation from projectId + commandId
  const branchD1 = generateStableBranchName('proj-1', 'cmd-1');
  const branchD2 = generateStableBranchName('proj-1', 'cmd-1');
  assert.equal(branchD1, branchD2);
  assert.ok(isStableWorkspaceBranch(branchD1));

  assert.equal(isStableWorkspaceBranch('feature/human-name'), false);
  assert.equal(isStableWorkspaceBranch('main'), false);
});

test('REAL GIT: workspace creation, deterministic branch, idempotent replay, and crash recovery', async (t) => {
  const { root, db, repoDir, headSha, observation } = await realGitFixture(t);

  // 1. Real workspace creation
  const target1 = path.join(root, 'real-workspace-1');
  mkdirSync(target1);
  const binding1 = authorizeEmptyDirectory(target1);
  const grantStore = new EmptyFolderGrantStore({ db });
  const grant1 = grantStore.issue(binding1, 'principal-real-1');

  const res1 = await createDevelopmentWorkspace(db, {
    commandId: 'cmd-real-create-1',
    projectId: 'proj-real-1',
    name: 'feature-real-ws',
    grantId: grant1.grantId,
    principalHash: 'principal-real-1',
    expectedBaseHead: headSha,
  });

  assert.equal(res1.ok, true, JSON.stringify(res1));
  assert.ok(isStableWorkspaceBranch(res1.branch));
  assert.equal(res1.branch, generateStableBranchName('proj-real-1', 'cmd-real-create-1'));
  assert.equal(res1.baseCommit, headSha);
  assert.equal(res1.repositoryIdentity, observation.repositoryIdentity);
  assert.equal(res1.status, 'ready');

  // Verify real probe of the new worktree
  const newProbe = await probeGitWorktree(target1);
  assert.equal(newProbe.repositoryIdentity, observation.repositoryIdentity);
  assert.equal(newProbe.after.branch, res1.branch);
  assert.equal(newProbe.after.head, headSha);
  assert.equal(newProbe.coherence, 'coherent');
  assert.equal(newProbe.after.hasChanges, false);

  // Verify grant consumed
  const grantRow1 = db.prepare('SELECT * FROM empty_folder_grants WHERE id = ?').get(grant1.grantId);
  assert.equal(grantRow1.state, 'consumed');
  assert.equal(grantRow1.claimed_by_command, 'cmd-real-create-1');

  // 2. Real idempotent replay
  const replayRes = await createDevelopmentWorkspace(db, {
    commandId: 'cmd-real-create-1',
    projectId: 'proj-real-1',
    name: 'feature-real-ws',
    grantId: grant1.grantId,
    principalHash: 'principal-real-1',
    expectedBaseHead: headSha,
  });

  assert.equal(replayRes.ok, true);
  assert.equal(replayRes.spaceId, res1.spaceId);

  // 3. Real Git crash recovery
  // Scenario: Worktree is already created by git in target2, but process crashes before DB registration
  const target2 = path.join(root, 'real-workspace-crash');
  mkdirSync(target2);
  const binding2 = authorizeEmptyDirectory(target2);
  const grant2 = grantStore.issue(binding2, 'principal-real-1');

  const crashBranch = generateStableBranchName('proj-real-1', 'cmd-real-crash-1');
  await createGitWorktree(repoDir, {
    targetPath: target2,
    branch: crashBranch,
    baseCommit: headSha,
  });

  const crashRes = await createDevelopmentWorkspace(db, {
    commandId: 'cmd-real-crash-1',
    projectId: 'proj-real-1',
    name: 'recovered-real-space',
    grantId: grant2.grantId,
    principalHash: 'principal-real-1',
    expectedBaseHead: headSha,
  });

  assert.equal(crashRes.ok, true, JSON.stringify(crashRes));
  assert.equal(crashRes.statusReason, 'recovered_after_crash');
  assert.equal(crashRes.branch, crashBranch);

  const grantRow2 = db.prepare('SELECT * FROM empty_folder_grants WHERE id = ?').get(grant2.grantId);
  assert.equal(grantRow2.state, 'consumed');

  const space2 = db.prepare('SELECT * FROM development_spaces WHERE id = ?').get(crashRes.spaceId);
  assert.ok(space2);
  assert.equal(space2.branch, crashBranch);

  db.close();
});
