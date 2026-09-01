import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCockpitDatabase } from '../src/core/database.mjs';
import {
  readDashboard,
  refreshProject,
  registerProject,
  worktreeIdFor,
} from '../src/core/projects.mjs';
import { finishRun, startWriteRun } from '../src/core/runs.mjs';

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
    coherence: 'coherent',
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

test('a worktree known before Project registration is safely adopted', (t) => {
  const db = fixture(t);
  const observed = observation();
  db.prepare(`
    INSERT INTO worktrees (
      id, canonical_path, repository_identity, identity_fingerprint, created_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    worktreeIdFor(observed.worktreeIdentity),
    observed.canonicalPath,
    observed.repositoryIdentity,
    observed.worktreeIdentity,
    observed.observedAt,
  );
  const result = registerProject(db, {
    commandId: 'adopt-known-worktree',
    name: '已有代码位置',
    observation: observed,
  });
  assert.equal(result.ok, true);
  assert.equal(readDashboard(db).length, 1);
  db.close();
});

test('registering the same project again reports that it already exists', (t) => {
  const db = fixture(t);
  const observed = observation();
  registerProject(db, {
    commandId: 'register-original',
    name: '已经存在',
    observation: observed,
  });

  const duplicate = registerProject(db, {
    commandId: 'register-duplicate',
    name: '不会覆盖原名称',
    observation: observed,
  });

  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.alreadyExists, true);
  assert.equal(duplicate.name, '已经存在');
  assert.equal(readDashboard(db).length, 1);
  db.close();
});

test('refresh updates the human project status without changing project identity', (t) => {
  const db = fixture(t);
  const registered = registerProject(db, {
    commandId: 'register-refreshable',
    name: '可刷新项目',
    observation: observation(),
  });

  const refreshed = refreshProject(db, {
    commandId: 'refresh-dirty',
    projectId: registered.projectId,
    observation: observation({
      observedAt: '2026-09-01T01:00:00.000Z',
      after: { hasChanges: true },
    }),
  });

  assert.equal(refreshed.status, 'attention');
  assert.equal(refreshed.statusReason, 'preexisting_changes');
  assert.equal(readDashboard(db)[0].lastObservedAt, '2026-09-01T01:00:00.000Z');
  assert.deepEqual(refreshProject(db, {
    commandId: 'refresh-dirty',
    projectId: registered.projectId,
    observation: observation({
      observedAt: '2026-09-01T01:00:00.000Z',
      after: { hasChanges: true },
    }),
  }), refreshed);
  db.close();
});

test('dashboard surfaces the active Agent and latest handoff', (t) => {
  const db = fixture(t);
  const observed = observation();
  registerProject(db, {
    commandId: 'register-run-project',
    name: '接手项目',
    observation: observed,
  });
  const started = startWriteRun(db, {
    commandId: 'start-dashboard-run',
    worktreeId: worktreeIdFor(observed.worktreeIdentity),
    canonicalPath: observed.canonicalPath,
    repositoryIdentity: observed.repositoryIdentity,
    worktreeIdentity: observed.worktreeIdentity,
    agentClaim: 'Codex',
    goal: '完成首页接线',
    baseline: {
      repositoryIdentity: observed.repositoryIdentity,
      worktreeIdentity: observed.worktreeIdentity,
      coherence: 'coherent',
    },
  });
  let dashboard = readDashboard(db);
  assert.equal(dashboard[0].statusReason, 'active_work');
  assert.equal(dashboard[0].activeRun.agentClaim, 'Codex');
  assert.equal(dashboard[0].activeRun.revision, started.revision);

  const finished = finishRun(db, {
    commandId: 'finish-dashboard-run',
    runId: started.runId,
    expectedRevision: started.revision,
    leaseGeneration: started.leaseGeneration,
    outcome: 'completed',
    summary: '首页已经接通',
    nextStep: '验证真实项目',
    finalSnapshot: {
      head: null,
      branch: null,
      indexFingerprint: null,
      worktreeFingerprint: null,
      repositoryIdentity: observed.repositoryIdentity,
      worktreeIdentity: observed.worktreeIdentity,
      coherence: 'coherent',
    },
  });
  assert.equal(finished.ok, true, JSON.stringify(finished));
  dashboard = readDashboard(db);
  assert.equal(dashboard[0].activeRun, null);
  assert.equal(dashboard[0].lastHandoff.agentClaim, 'Codex');
  assert.equal(dashboard[0].lastHandoff.summary, '首页已经接通');
  assert.equal(dashboard[0].lastHandoff.nextStep, '验证真实项目');
  db.close();
});
