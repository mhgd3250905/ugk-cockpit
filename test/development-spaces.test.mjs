import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  openCockpitDatabase,
  SUPPORTED_SCHEMA_VERSION,
} from '../src/core/database.mjs';
import {
  archiveDevelopmentSpace,
  createDevelopmentSpace,
  listDevelopmentSpaces,
  readDevelopmentSpace,
  readDevelopmentSpaceByWorktree,
  spaceIdFor,
  updateDevelopmentSpaceStatus,
  VALID_SPACE_STATUSES,
} from '../src/core/spaces.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-spaces-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openCockpitDatabase(path.join(root, 'cockpit.db'));
  const at = '2026-09-02T00:00:00.000Z';

  // Seed primary project worktree & project
  db.prepare(`
    INSERT INTO worktrees (
      id, canonical_path, repository_identity, identity_fingerprint, created_at
    ) VALUES ('wt-main', 'E:\\repos\\my-app', 'repo-my-app', 'fp-main', ?)
  `).run(at);

  db.prepare(`
    INSERT INTO projects (
      id, name, stage, worktree_id, status, status_reason,
      last_observed_at, created_at, updated_at, repository_identity, authorized_root
    ) VALUES ('proj-1', 'My Application', 'development',
      'wt-main', 'ready', 'ready_to_start', ?, ?, ?, 'repo-my-app', 'E:\\repos\\my-app')
  `).run(at, at, at);

  return db;
}

test('development space creation binds project and worktree with initial revision 0', (t) => {
  const db = fixture(t);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SUPPORTED_SCHEMA_VERSION);

  // Register space worktree first
  db.prepare(`
    INSERT INTO worktrees (
      id, canonical_path, repository_identity, identity_fingerprint, created_at
    ) VALUES ('wt-space-1', 'E:\\repos\\my-app--feat-login', 'repo-my-app', 'fp-feat-login', '2026-09-02T01:00:00.000Z')
  `).run();

  const res = createDevelopmentSpace(db, {
    projectId: 'proj-1',
    name: 'feat-login',
    branch: 'feature/login',
    baseCommit: 'a1b2c3d4e5f6',
    worktreeId: 'wt-space-1',
  }, { clock: () => Date.parse('2026-09-02T01:00:00.000Z') });

  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.projectId, 'proj-1');
  assert.equal(res.name, 'feat-login');
  assert.equal(res.branch, 'feature/login');
  assert.equal(res.baseCommit, 'a1b2c3d4e5f6');
  assert.equal(res.worktreeId, 'wt-space-1');
  assert.equal(res.status, 'ready');
  assert.equal(res.revision, 0);
  assert.equal(res.canonicalPath, 'E:\\repos\\my-app--feat-login');
  assert.equal(res.repositoryIdentity, 'repo-my-app');
  assert.equal(res.archivedAt, null);

  // Read back
  const space = readDevelopmentSpace(db, res.spaceId);
  assert.ok(space);
  assert.equal(space.name, 'feat-login');
  assert.equal(space.projectName, 'My Application');
  assert.equal(space.canonicalPath, 'E:\\repos\\my-app--feat-login');

  // Read by worktree
  const spaceByWt = readDevelopmentSpaceByWorktree(db, 'wt-space-1');
  assert.equal(spaceByWt?.id, res.spaceId);

  db.close();
});

test('development space enforces worktree uniqueness across spaces', (t) => {
  const db = fixture(t);

  db.prepare(`
    INSERT INTO worktrees (
      id, canonical_path, repository_identity, identity_fingerprint, created_at
    ) VALUES ('wt-shared', 'E:\\repos\\my-app--shared', 'repo-my-app', 'fp-shared', '2026-09-02T01:00:00.000Z')
  `).run();

  const first = createDevelopmentSpace(db, {
    projectId: 'proj-1',
    name: 'space-alpha',
    branch: 'feature/alpha',
    baseCommit: '111111111111',
    worktreeId: 'wt-shared',
  });
  assert.equal(first.ok, true);

  // Attempt to create second space referencing the same worktree must fail
  const second = createDevelopmentSpace(db, {
    projectId: 'proj-1',
    name: 'space-beta',
    branch: 'feature/beta',
    baseCommit: '222222222222',
    worktreeId: 'wt-shared',
  });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'WORKTREE_ALREADY_IN_USE');

  db.close();
});

test('revision CAS enforces optimistic concurrency for space status updates', (t) => {
  const db = fixture(t);

  db.prepare(`
    INSERT INTO worktrees (
      id, canonical_path, repository_identity, identity_fingerprint, created_at
    ) VALUES ('wt-cas', 'E:\\repos\\my-app--cas', 'repo-my-app', 'fp-cas', '2026-09-02T01:00:00.000Z')
  `).run();

  const created = createDevelopmentSpace(db, {
    projectId: 'proj-1',
    name: 'space-cas',
    branch: 'feature/cas',
    baseCommit: '333333333333',
    worktreeId: 'wt-cas',
  });
  assert.equal(created.ok, true);
  assert.equal(created.revision, 0);

  // Stale expectedRevision must fail
  const staleUpdate = updateDevelopmentSpaceStatus(db, {
    spaceId: created.spaceId,
    expectedRevision: 99,
    status: 'active',
    statusReason: 'agent_started',
  });
  assert.equal(staleUpdate.ok, false);
  assert.equal(staleUpdate.code, 'REVISION_CONFLICT');
  assert.equal(staleUpdate.currentRevision, 0);

  // Correct expectedRevision succeeds and increments revision
  const validUpdate1 = updateDevelopmentSpaceStatus(db, {
    spaceId: created.spaceId,
    expectedRevision: 0,
    status: 'active',
    statusReason: 'agent_started',
  }, { clock: () => Date.parse('2026-09-02T02:00:00.000Z') });
  assert.equal(validUpdate1.ok, true);
  assert.equal(validUpdate1.revision, 1);
  assert.equal(validUpdate1.status, 'active');

  // Next update with revision 1 -> 2
  const validUpdate2 = updateDevelopmentSpaceStatus(db, {
    spaceId: created.spaceId,
    expectedRevision: 1,
    status: 'integrating',
    statusReason: 'submission_created',
  }, { clock: () => Date.parse('2026-09-02T03:00:00.000Z') });
  assert.equal(validUpdate2.ok, true);
  assert.equal(validUpdate2.revision, 2);
  assert.equal(validUpdate2.status, 'integrating');

  // Archive with revision 2 -> 3
  const archived = archiveDevelopmentSpace(db, {
    spaceId: created.spaceId,
    expectedRevision: 2,
    statusReason: 'feature_merged',
  }, { clock: () => Date.parse('2026-09-02T04:00:00.000Z') });
  assert.equal(archived.ok, true);
  assert.equal(archived.revision, 3);
  assert.equal(archived.status, 'archived');
  assert.equal(archived.archivedAt, '2026-09-02T04:00:00.000Z');

  db.close();
});

test('development space status validation rejects disallowed states', (t) => {
  const db = fixture(t);

  db.prepare(`
    INSERT INTO worktrees (
      id, canonical_path, repository_identity, identity_fingerprint, created_at
    ) VALUES ('wt-val', 'E:\\repos\\my-app--val', 'repo-my-app', 'fp-val', '2026-09-02T01:00:00.000Z')
  `).run();

  const invalidCreate = createDevelopmentSpace(db, {
    projectId: 'proj-1',
    name: 'space-val',
    branch: 'feature/val',
    baseCommit: '444444444444',
    worktreeId: 'wt-val',
    status: 'non_existent_status',
  });
  assert.equal(invalidCreate.ok, false);
  assert.equal(invalidCreate.code, 'INVALID_STATUS');

  const validCreate = createDevelopmentSpace(db, {
    projectId: 'proj-1',
    name: 'space-val',
    branch: 'feature/val',
    baseCommit: '444444444444',
    worktreeId: 'wt-val',
    status: 'ready',
  });
  assert.equal(validCreate.ok, true);

  const invalidUpdate = updateDevelopmentSpaceStatus(db, {
    spaceId: validCreate.spaceId,
    expectedRevision: 0,
    status: 'invalid_status_transition',
  });
  assert.equal(invalidUpdate.ok, false);
  assert.equal(invalidUpdate.code, 'INVALID_STATUS');

  db.close();
});

test('listDevelopmentSpaces supports filtering by project and status', (t) => {
  const db = fixture(t);

  // Create two spaces
  db.prepare(`
    INSERT INTO worktrees (
      id, canonical_path, repository_identity, identity_fingerprint, created_at
    ) VALUES
      ('wt-s1', 'E:\\repos\\s1', 'repo-my-app', 'fp-s1', '2026-09-02T01:00:00.000Z'),
      ('wt-s2', 'E:\\repos\\s2', 'repo-my-app', 'fp-s2', '2026-09-02T01:00:00.000Z')
  `).run();

  createDevelopmentSpace(db, {
    projectId: 'proj-1',
    name: 'space-1',
    branch: 'feat/1',
    baseCommit: 'c1',
    worktreeId: 'wt-s1',
    status: 'ready',
  });

  createDevelopmentSpace(db, {
    projectId: 'proj-1',
    name: 'space-2',
    branch: 'feat/2',
    baseCommit: 'c2',
    worktreeId: 'wt-s2',
    status: 'busy',
  });

  const all = listDevelopmentSpaces(db, { projectId: 'proj-1' });
  assert.equal(all.length, 2);

  const busyOnly = listDevelopmentSpaces(db, { projectId: 'proj-1', status: 'busy' });
  assert.equal(busyOnly.length, 1);
  assert.equal(busyOnly[0].name, 'space-2');

  const readyOnly = listDevelopmentSpaces(db, { projectId: 'proj-1', status: 'ready' });
  assert.equal(readyOnly.length, 1);
  assert.equal(readyOnly[0].name, 'space-1');

  db.close();
});

test('createDevelopmentSpace allows multiple same-name and unnamed spaces with distinct worktrees', (t) => {
  const db = fixture(t);

  db.prepare(`
    INSERT INTO worktrees (
      id, canonical_path, repository_identity, identity_fingerprint, created_at
    ) VALUES
      ('wt-dup-1', 'E:\\repos\\my-app--dup-1', 'repo-my-app', 'fp-dup-1', '2026-09-02T01:00:00.000Z'),
      ('wt-dup-2', 'E:\\repos\\my-app--dup-2', 'repo-my-app', 'fp-dup-2', '2026-09-02T01:00:00.000Z'),
      ('wt-unnamed', 'E:\\repos\\my-app--unnamed', 'repo-my-app', 'fp-unnamed', '2026-09-02T01:00:00.000Z')
  `).run();

  // Create two spaces with same name 'duplicate-name'
  const space1 = createDevelopmentSpace(db, {
    projectId: 'proj-1',
    name: 'duplicate-name',
    branch: 'feature/dup-1',
    baseCommit: 'commit-1',
    worktreeId: 'wt-dup-1',
  });
  assert.equal(space1.ok, true);

  const space2 = createDevelopmentSpace(db, {
    projectId: 'proj-1',
    name: 'duplicate-name',
    branch: 'feature/dup-2',
    baseCommit: 'commit-2',
    worktreeId: 'wt-dup-2',
  });
  assert.equal(space2.ok, true);
  assert.notEqual(space1.spaceId, space2.spaceId);
  assert.equal(space1.name, 'duplicate-name');
  assert.equal(space2.name, 'duplicate-name');

  // Create an unnamed space (no name provided)
  const unnamedSpace = createDevelopmentSpace(db, {
    projectId: 'proj-1',
    branch: 'feature/unnamed',
    baseCommit: 'commit-3',
    worktreeId: 'wt-unnamed',
  });
  assert.equal(unnamedSpace.ok, true);
  assert.equal(unnamedSpace.name, '');

  db.close();
});

test('createDevelopmentSpace rejects worktree with mismatched repository_identity', (t) => {
  const db = fixture(t);

  db.prepare(`
    INSERT INTO worktrees (
      id, canonical_path, repository_identity, identity_fingerprint, created_at
    ) VALUES ('wt-foreign', 'E:\\repos\\other-app--feat', 'repo-other-app', 'fp-other', '2026-09-02T01:00:00.000Z')
  `).run();

  const res = createDevelopmentSpace(db, {
    projectId: 'proj-1',
    name: 'feat-foreign',
    branch: 'feature/foreign',
    baseCommit: 'commit-foreign',
    worktreeId: 'wt-foreign',
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'REPOSITORY_IDENTITY_MISMATCH');

  db.close();
});

test('development space supports expanded statuses', (t) => {
  const db = fixture(t);

  db.prepare(`
    INSERT INTO worktrees (
      id, canonical_path, repository_identity, identity_fingerprint, created_at
    ) VALUES ('wt-expanded', 'E:\\repos\\my-app--expanded', 'repo-my-app', 'fp-exp', '2026-09-02T01:00:00.000Z')
  `).run();

  const created = createDevelopmentSpace(db, {
    projectId: 'proj-1',
    name: 'expanded-test',
    branch: 'feature/expanded',
    baseCommit: 'commit-exp',
    worktreeId: 'wt-expanded',
    status: 'awaiting_review',
  });
  assert.equal(created.ok, true);
  assert.equal(created.status, 'awaiting_review');

  const u1 = updateDevelopmentSpaceStatus(db, {
    spaceId: created.spaceId,
    expectedRevision: 0,
    status: 'attention',
  });
  assert.equal(u1.ok, true);
  assert.equal(u1.status, 'attention');

  const u2 = updateDevelopmentSpaceStatus(db, {
    spaceId: created.spaceId,
    expectedRevision: 1,
    status: 'missing',
  });
  assert.equal(u2.ok, true);
  assert.equal(u2.status, 'missing');

  const u3 = updateDevelopmentSpaceStatus(db, {
    spaceId: created.spaceId,
    expectedRevision: 2,
    status: 'cleanup_ready',
  });
  assert.equal(u3.ok, true);
  assert.equal(u3.status, 'cleanup_ready');

  db.close();
});

test('createDevelopmentSpace is idempotent when replaying with commandId', (t) => {
  const db = fixture(t);

  db.prepare(`
    INSERT INTO worktrees (
      id, canonical_path, repository_identity, identity_fingerprint, created_at
    ) VALUES ('wt-cmd', 'E:\\repos\\my-app--cmd', 'repo-my-app', 'fp-cmd', '2026-09-02T01:00:00.000Z')
  `).run();

  const req = {
    commandId: 'cmd-space-create-1',
    projectId: 'proj-1',
    name: 'space-idempotent',
    branch: 'feature/idempotent',
    baseCommit: '555555555555',
    worktreeId: 'wt-cmd',
  };

  const res1 = createDevelopmentSpace(db, req);
  assert.equal(res1.ok, true);

  const res2 = createDevelopmentSpace(db, req);
  assert.equal(res2.ok, true);
  assert.equal(res2.spaceId, res1.spaceId);

  // Command table records committed command
  const cmd = db.prepare("SELECT * FROM commands WHERE id = 'cmd-space-create-1'").get();
  assert.equal(cmd.state, 'committed');

  db.close();
});


