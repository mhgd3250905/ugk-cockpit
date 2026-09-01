import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { readDashboard, registerProject } from '../src/core/projects.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-project-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return openCockpitDatabase(path.join(root, 'cockpit.db'));
}

function observation(overrides = {}) {
  return {
    canonicalPath: 'E:\\fixture\\project',
    repositoryIdentity: 'repository-one',
    worktreeIdentity: 'worktree-one',
    observedAt: '2026-09-01T00:00:00.000Z',
    after: { hasChanges: false },
    ...overrides,
  };
}

test('registering a clean unknown project makes it ready on the dashboard', (t) => {
  const db = fixture(t);
  const result = registerProject(db, {
    commandId: 'register-one',
    name: '晨跑助手',
    observation: observation(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'ready');
  const dashboard = readDashboard(db);
  assert.equal(dashboard.length, 1);
  assert.equal(dashboard[0].name, '晨跑助手');
  assert.equal(dashboard[0].statusReason, 'ready_to_start');
  db.close();
});

test('preexisting changes are preserved and surfaced as attention', (t) => {
  const db = fixture(t);
  const result = registerProject(db, {
    commandId: 'register-dirty',
    name: '有改动的项目',
    observation: observation({
      canonicalPath: 'E:\\fixture\\dirty',
      worktreeIdentity: 'worktree-dirty',
      after: { hasChanges: true },
    }),
  });
  assert.equal(result.status, 'attention');
  assert.equal(result.statusReason, 'preexisting_changes');
  assert.equal(db.prepare('SELECT count(*) AS count FROM commands').get().count, 1);
  db.close();
});

test('same command replays and a same-path replacement fails closed', (t) => {
  const db = fixture(t);
  const request = {
    commandId: 'register-replay',
    name: '稳定项目',
    observation: observation(),
  };
  const first = registerProject(db, request);
  assert.deepEqual(registerProject(db, request), first);
  const replaced = registerProject(db, {
    commandId: 'register-replaced',
    name: '冒名项目',
    observation: observation({
      repositoryIdentity: 'repository-two',
      worktreeIdentity: 'worktree-two',
    }),
  });
  assert.equal(replaced.ok, false);
  assert.equal(replaced.code, 'WORKTREE_IDENTITY_CHANGED');
  assert.equal(readDashboard(db).length, 1);
  db.close();
});
