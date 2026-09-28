// 第 30 轮审计（2026-09-28）：dashboard 与项目详情必须对同一项目回答同一个事实。
// 两处都按「取最新一行」挑选：project_observations（observed_at）、历史 runs
// （finished_at）、active assignment（updated_at）。timeline.mjs 的详情侧全部带
// `, id DESC` 总序 tiebreaker（该文件注释自己写明 "keeps the order total"），
// 而 projects.mjs 的 readDashboard 四处只按时间列 DESC——同毫秒并列时
// SQLite 按索引/rowid 顺序返回，两视图可对同一项目给出相反答案。
import assert from 'node:assert/strict';
import test from 'node:test';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { registerProject, refreshProject, readDashboard, worktreeIdFor } from '../src/core/projects.mjs';
import { readProjectDetail } from '../src/core/timeline.mjs';
import { createDevelopmentSpace } from '../src/core/spaces.mjs';
import { createAssignment } from '../src/core/assignments.mjs';

const T0 = '2026-09-28T00:00:00.000Z';
const T0_MS = Date.parse(T0);

function observation(patch = {}) {
  return {
    canonicalPath: 'E:\\ugk-fixtures\\order-30',
    repositoryIdentity: 'repo-order',
    worktreeId: worktreeIdFor('wt-order'),
    worktreeIdentity: 'wt-order',
    observedAt: T0,
    coherence: 'coherent',
    after: {
      head: 'c'.repeat(40),
      branch: 'main',
      hasChanges: false,
      indexFingerprint: 'index-order',
      worktreeFingerprint: 'wt-order',
    },
    ...patch,
  };
}

function fixture(t) {
  const db = openCockpitDatabase(':memory:');
  t.after(() => db.close());
  const registered = registerProject(db, {
    commandId: 'reg-order', name: 'Order Fixture', observation: observation(),
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  return { db, projectId: registered.projectId };
}

test('dashboard and detail pick the same latest observation when observed_at ties', (t) => {
  const { db, projectId } = fixture(t);
  // 同 observed_at 的第二次观测（列序：id DESC 会选到刷新行；无 tiebreaker 时按 rowid 先者）。
  const refreshed = refreshProject(db, {
    commandId: 'aaa-refresh-tie',
    projectId,
    observation: observation({ coherence: 'incoherent', after: { head: 'c'.repeat(40), branch: 'main', hasChanges: true, indexFingerprint: 'x', worktreeFingerprint: 'y' } }),
  });
  assert.equal(refreshed.ok, true, JSON.stringify(refreshed));

  const card = readDashboard(db).find((item) => item.id === projectId);
  const detail = readProjectDetail(db, projectId);
  assert.equal(card.git.coherence, detail.project.git.coherence);
  assert.equal(card.status, detail.project.status);
  assert.equal(card.statusReason, detail.project.statusReason);
});

test('dashboard and detail agree on the active assignment when updated_at ties', (t) => {
  const { db, projectId } = fixture(t);
  const space = createDevelopmentSpace(db, {
    commandId: 'space-order',
    projectId,
    name: 'Order Space',
    branch: 'cockpit/order',
    baseCommit: 'c'.repeat(40),
    worktreeId: worktreeIdFor('wt-order-space'),
    canonicalPath: 'E:\\ugk-fixtures\\order-30-space',
    repositoryIdentity: 'repo-order',
    worktreeIdentity: 'wt-order-space',
  });
  assert.equal(space.ok, true, JSON.stringify(space));

  const first = createAssignment(db, {
    commandId: 'aaa-invite',
    projectId,
    worktreeId: worktreeIdFor('wt-order'),
    agent: 'codex',
    task: 'first invite',
  }, { now: T0_MS });
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = createAssignment(db, {
    commandId: 'zzz-invite',
    projectId,
    worktreeId: worktreeIdFor('wt-order-space'),
    agent: 'cursor',
    task: 'second invite',
  }, { now: T0_MS });
  assert.equal(second.ok, true, JSON.stringify(second));

  const card = readDashboard(db).find((item) => item.id === projectId);
  const detail = readProjectDetail(db, projectId);
  assert.equal(card.pendingAssignment.id, detail.project.pendingAssignment?.id ?? null,
    'dashboard and detail disagree on which pending invitation is the current one');
});

test('dashboard and detail pick the same last finished run when finished_at ties', (t) => {
  const { db, projectId } = fixture(t);
  const row = db.prepare('SELECT worktree_id FROM projects WHERE id = ?').get(projectId);
  db.prepare(`
    INSERT INTO runs (id, worktree_id, lifecycle, agent_claim, goal, revision, created_at, finished_at, mode, health, lease_generation)
    VALUES ('run_cmd_aaa', ?, 'completed', 'codex', 'task a', 1, ?, ?, 'write', 'healthy', 1)
  `).run(row.worktree_id, T0, T0);
  db.prepare(`
    INSERT INTO runs (id, worktree_id, lifecycle, agent_claim, goal, revision, created_at, finished_at, mode, health, lease_generation)
    VALUES ('run_cmd_zzz', ?, 'completed', 'cursor', 'task z', 1, ?, ?, 'write', 'healthy', 1)
  `).run(row.worktree_id, T0, T0);

  const card = readDashboard(db).find((item) => item.id === projectId);
  const detail = readProjectDetail(db, projectId);
  const detailLast = detail.project.lastWork ?? null;
  assert.equal(card.lastWork?.runId ?? null, detailLast?.runId ?? null,
    'dashboard and detail disagree on which finished run is the latest');
});
