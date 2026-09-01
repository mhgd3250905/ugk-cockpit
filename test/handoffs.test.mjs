import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCockpitDatabase, SUPPORTED_SCHEMA_VERSION } from '../src/core/database.mjs';
import {
  acceptAssignment,
  createAssignment,
  recordProgress,
} from '../src/core/assignments.mjs';
import {
  createHandoff,
  readHandoff,
  readLatestHandoff,
  renderHandoffMarkdown,
} from '../src/core/handoffs.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-handoff-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openCockpitDatabase(path.join(root, 'cockpit.db'));
  const at = '2026-09-02T00:00:00.000Z';
  db.prepare(`
    INSERT INTO worktrees (
      id, canonical_path, repository_identity, identity_fingerprint, created_at
    ) VALUES ('worktree-handoff', 'E:\\fixture\\handoff', 'repo-handoff', 'identity-handoff', ?)
  `).run(at);
  db.prepare(`
    INSERT INTO projects (
      id, name, stage, worktree_id, status, status_reason,
      last_observed_at, created_at, updated_at
    ) VALUES ('project-handoff', 'Handoff fixture', 'development',
      'worktree-handoff', 'ready', 'ready_to_start', ?, ?, ?)
  `).run(at, at, at);
  return db;
}

function acceptedFixture(t) {
  const db = fixture(t);
  const created = createAssignment(db, {
    commandId: 'handoff-assignment-create',
    assignmentId: 'assignment-handoff',
    projectId: 'project-handoff',
    agentId: 'agent-handoff',
    taskId: 'task-handoff',
    scope: { mode: 'write' },
    dispatchCode: 'handoff-dispatch-code',
  }, { clock: () => Date.parse('2026-09-02T00:00:00.000Z') });
  assert.equal(created.ok, true, JSON.stringify(created));
  const accepted = acceptAssignment(db, {
    dispatchCode: created.dispatchCode,
    clientRequestId: 'handoff-accept',
    sessionId: 'session-handoff',
  }, { clock: () => Date.parse('2026-09-02T00:00:00.000Z') });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  return db;
}

const handoffFields = {
  nextSessionFocus: '验证收尾状态',
  summary: '已完成 MCP 接线',
  currentState: 'blocked',
  completedItems: ['定义边界', '接通服务端调用'],
  pendingItems: ['运行真实项目验收'],
  decisions: [{ decision: '保留本地 SQLite', rationale: '无需新增依赖' }],
  artifactRefs: ['ref://commit/abc123', 'ticket:UGK-42'],
  risks: ['真实仓库仍需只读检查'],
  suggestedSkills: ['review', 'qa'],
};

test('schema 9 creates append-only handoffs and renders a stable standard manual', (t) => {
  const db = acceptedFixture(t);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SUPPORTED_SCHEMA_VERSION);
  assert.equal(
    db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'handoffs'").get().count,
    1,
  );
  const result = createHandoff(db, {
    sessionId: 'session-handoff',
    clientRequestId: 'handoff-1',
    expectedRevision: 1,
    ...handoffFields,
  }, { clock: () => Date.parse('2026-09-02T00:01:00.000Z') });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.sequence, 1);
  assert.equal(result.bodyMarkdown, renderHandoffMarkdown(handoffFields));
  assert.match(result.bodyMarkdown, /## Next session focus/);
  assert.match(result.bodyMarkdown, /ref:\/\/commit\/abc123/);
  assert.equal(result.bodyMarkdown.includes('dispatch-code'), false);
  assert.equal(db.prepare('SELECT count(*) AS count FROM handoffs').get().count, 1);
  db.close();
});

test('same client request is idempotent, stale revisions are fenced, and latest is ordered', (t) => {
  const db = acceptedFixture(t);
  const firstRequest = {
    sessionId: 'session-handoff',
    clientRequestId: 'handoff-1',
    expectedRevision: 1,
    ...handoffFields,
  };
  const first = createHandoff(db, firstRequest, { clock: 1_788_297_660_000 });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.deepEqual(createHandoff(db, firstRequest, { clock: 1_788_297_660_000 }), first);

  const progress = recordProgress(db, {
    sessionId: 'session-handoff',
    clientRequestId: 'handoff-progress',
    expectedRevision: 1,
    status: 'working',
    note: '继续处理',
  }, { clock: 1_788_297_660_001 });
  assert.equal(progress.ok, true, JSON.stringify(progress));
  const stale = createHandoff(db, {
    ...firstRequest,
    clientRequestId: 'handoff-stale',
  }, { clock: 1_788_297_660_002 });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'HANDOFF_REVISION_CONFLICT');

  const second = createHandoff(db, {
    ...handoffFields,
    sessionId: 'session-handoff',
    clientRequestId: 'handoff-2',
    expectedRevision: 2,
    summary: '更新后的交接',
  }, { clock: 1_788_297_660_003 });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.sequence, 2);
  assert.equal(readHandoff(db, first.id).sequence, 1);
  assert.equal(readLatestHandoff(db, 'project-handoff').id, second.id);
  assert.equal(db.prepare('SELECT count(*) AS count FROM handoffs').get().count, 2);
  db.close();
});
