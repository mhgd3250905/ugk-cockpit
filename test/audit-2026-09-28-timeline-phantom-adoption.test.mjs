// 第 30 轮审计（2026-09-28）：从未被接手的邀请不得在历史里冒充「接入项目」。
// 关闭工作线会把 session_id 为空、未被接手的 pending 邀请改成 cancelled
// （cancelClosedWorkLineInvitations / removeDevelopmentWorkspace 都是这个语义）。
// 而时间线的准入谓词是 `(a.status != 'pending' OR a.session_id IS NOT NULL OR pe.id IS NOT NULL)`：
// cancelled 行命中第一支，凭空生成一个 kind='init' 的「接入项目」节点；
// readLatestSession 同样把这种行作为候选输出 currentAgent。
// 时间线自己的节点语义注释写明 'init' = "Project adoption & baseline"，
// 而该邀请从未发生——AGENTS.md 要求证明不了的归属不得猜测。
import assert from 'node:assert/strict';
import test from 'node:test';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { registerProject, worktreeIdFor } from '../src/core/projects.mjs';
import { createDevelopmentSpace } from '../src/core/spaces.mjs';
import { createAssignment } from '../src/core/assignments.mjs';
import { setWorkLineClosed } from '../src/core/manual-records.mjs';
import { readProjectTimeline } from '../src/core/timeline.mjs';
import { readWorkLineContexts } from '../src/core/work-line-context.mjs';

const OBSERVED_AT = '2026-09-01T00:00:00.000Z';

function observation(canonicalPath, worktreeIdentity) {
  return {
    canonicalPath,
    repositoryIdentity: 'repo-30',
    worktreeId: worktreeIdFor(worktreeIdentity),
    worktreeIdentity,
    observedAt: OBSERVED_AT,
    coherence: 'coherent',
    after: {
      head: 'a'.repeat(40),
      branch: 'main',
      hasChanges: false,
      indexFingerprint: `index-${worktreeIdentity}`,
      worktreeFingerprint: `wt-${worktreeIdentity}`,
    },
  };
}

function fixture(t) {
  const db = openCockpitDatabase(':memory:');
  t.after(() => db.close());
  const registered = registerProject(db, {
    commandId: 'reg-30',
    name: 'Phantom Fixture',
    observation: observation('E:\\ugk-fixtures\\main-30', 'wt-main-30'),
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  const space = createDevelopmentSpace(db, {
    commandId: 'space-30',
    projectId: registered.projectId,
    name: 'Space 30',
    branch: 'cockpit/space-30',
    baseCommit: 'a'.repeat(40),
    worktreeId: worktreeIdFor('wt-space-30'),
    canonicalPath: 'E:\\ugk-fixtures\\space-30',
    repositoryIdentity: 'repo-30',
    worktreeIdentity: 'wt-space-30',
  });
  assert.equal(space.ok, true, JSON.stringify(space));
  return { db, projectId: registered.projectId, spaceWorktreeId: worktreeIdFor('wt-space-30') };
}

function laneFor(contexts, worktreeId) {
  return contexts.find((lane) => lane.worktreeId === worktreeId) ?? null;
}

test('closing a work line does not invent an adoption node for a never-accepted invitation', (t) => {
  const { db, projectId, spaceWorktreeId } = fixture(t);
  const assignment = createAssignment(db, {
    commandId: 'asg-phantom',
    projectId,
    worktreeId: spaceWorktreeId,
    agent: 'codex',
    task: 'never adopted',
  });
  assert.equal(assignment.ok, true, JSON.stringify(assignment));

  const closed = setWorkLineClosed(db, {
    commandId: 'close-phantom',
    projectId,
    worktreeId: spaceWorktreeId,
    expectedRevision: 0,
    closed: true,
  });
  assert.equal(closed.ok, true, JSON.stringify(closed));

  const timeline = readProjectTimeline(db, projectId, { limit: 50 });
  const phantom = timeline.items.filter((item) => item.id === `init_${assignment.assignmentId}`);
  assert.deepEqual(phantom, [],
    'a cancelled, never-accepted invitation rendered as a kind=init adoption node the history never had');
});

test('a cancelled never-accepted invitation is not reported as the lane currentAgent', (t) => {
  const { db, projectId, spaceWorktreeId } = fixture(t);
  const assignment = createAssignment(db, {
    commandId: 'asg-agent-phantom',
    projectId,
    worktreeId: spaceWorktreeId,
    agent: 'codex',
    task: 'never adopted agent',
  });
  assert.equal(assignment.ok, true, JSON.stringify(assignment));
  const closed = setWorkLineClosed(db, {
    commandId: 'close-agent-phantom',
    projectId,
    worktreeId: spaceWorktreeId,
    expectedRevision: 0,
    closed: true,
  });
  assert.equal(closed.ok, true, JSON.stringify(closed));

  const lane = laneFor(readWorkLineContexts(db, projectId), spaceWorktreeId);
  assert.ok(lane, 'the space lane should still exist');
  assert.equal(lane.currentAgent, null,
    'a never-accepted cancelled invitation was reported as the lane currentAgent');
  assert.equal(lane.assignmentId ?? null, null,
    'the cancelled invitation was still surfaced as the lane assignment');
});

test('an accepted invitation keeps its adoption node and lane attribution', (t) => {
  // 反向界：真的发生过接入的工作线（有会话绑定）必须照旧呈现。
  const { db, projectId, spaceWorktreeId } = fixture(t);
  const assignment = createAssignment(db, {
    commandId: 'asg-real',
    projectId,
    worktreeId: spaceWorktreeId,
    agent: 'codex',
    task: 'really adopted',
  });
  assert.equal(assignment.ok, true, JSON.stringify(assignment));
  db.prepare(`
    UPDATE assignments
    SET status = 'cancelled', session_id = 'session-real', updated_at = ?
    WHERE id = ?
  `).run('2026-09-02T00:00:00.000Z', assignment.assignmentId);

  const timeline = readProjectTimeline(db, projectId, { limit: 50 });
  assert.ok(timeline.items.some((item) => item.id === `init_${assignment.assignmentId}`),
    'a real adoption (session bound, later cancelled) lost its history node');
  const lane = laneFor(readWorkLineContexts(db, projectId), spaceWorktreeId);
  assert.equal(lane.currentAgent, 'codex');
});

test('an invitation carrying an adopted event without a session keeps its node', (t) => {
  // 时间线谓词的 pe 分支：adopted 进度事件同样是“确实发生过”的证明，不得一并裁掉。
  const { db, projectId, spaceWorktreeId } = fixture(t);
  const assignment = createAssignment(db, {
    commandId: 'asg-adopted-event',
    projectId,
    worktreeId: spaceWorktreeId,
    agent: 'cursor',
    task: 'legacy adopted marker',
  });
  assert.equal(assignment.ok, true, JSON.stringify(assignment));
  db.prepare(`
    UPDATE assignments SET status = 'cancelled', updated_at = ? WHERE id = ?
  `).run('2026-09-02T00:00:00.000Z', assignment.assignmentId);
  db.prepare(`
    INSERT INTO progress_events (id, assignment_id, session_id, client_request_id, expected_revision, revision, status, note, created_at)
    VALUES ('pe-adopted-30', ?, 'session-legacy', 'cr-1', 0, 1, 'adopted', 'adopted marker', ?)
  `).run(assignment.assignmentId, '2026-09-02T00:00:00.000Z');

  const timeline = readProjectTimeline(db, projectId, { limit: 50 });
  assert.ok(timeline.items.some((item) => item.id === `init_${assignment.assignmentId}`),
    'the adopted-event evidence branch pruned a real adoption');
});

test('pending invitations that were never closed stay out of the timeline', (t) => {
  // 既有语义（修复前后都必须成立）：还在等待的 pending 邀请不是历史节点。
  const { db, projectId, spaceWorktreeId } = fixture(t);
  const assignment = createAssignment(db, {
    commandId: 'asg-pending',
    projectId,
    worktreeId: spaceWorktreeId,
    agent: 'codex',
    task: 'still waiting',
  });
  assert.equal(assignment.ok, true, JSON.stringify(assignment));
  const timeline = readProjectTimeline(db, projectId, { limit: 50 });
  assert.deepEqual(timeline.items.filter((item) => item.id === `init_${assignment.assignmentId}`), []);
});
