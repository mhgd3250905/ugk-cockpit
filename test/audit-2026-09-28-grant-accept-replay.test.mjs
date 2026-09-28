// 第 30 轮审计（2026-09-28）：已消费凭证的幂等重放不得被判成过期。
// acceptDispatchGrant 把「过期守卫」排在「已接受守卫」之前：凭证被接受后，
// expires_at 只是签发期限——行状态已是 accepted、会话已绑定。此后同一逻辑请求
// 用新 commandId 重试（宿主丢回执后的自然恢复动作）会落进过期分支，返回
// DISPATCH_GRANT_EXPIRED，而持久状态仍是有效的 accepted 会话。
// 同族的 relays（createRelay）自己写明了正确语义：true retry 即使在 relay
// 已被接手或已过期之后也必须能重建原 prepared 回执。
import assert from 'node:assert/strict';
import test from 'node:test';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { registerProject, worktreeIdFor } from '../src/core/projects.mjs';
import { createAssignment, acceptAssignment } from '../src/core/assignments.mjs';

const T0 = Date.parse('2026-09-28T00:00:00.000Z');
const OBSERVED_AT = new Date(T0).toISOString();

function observation() {
  return {
    canonicalPath: 'E:\\ugk-fixtures\\replay-30',
    repositoryIdentity: 'repo-replay',
    worktreeId: worktreeIdFor('wt-replay'),
    worktreeIdentity: 'wt-replay',
    observedAt: OBSERVED_AT,
    coherence: 'coherent',
    after: {
      head: 'b'.repeat(40),
      branch: 'main',
      hasChanges: false,
      indexFingerprint: 'index-replay',
      worktreeFingerprint: 'wt-replay',
    },
  };
}

function dispatchFixture(t) {
  const db = openCockpitDatabase(':memory:');
  t.after(() => db.close());
  const registered = registerProject(db, {
    commandId: 'reg-replay', name: 'Replay Fixture', observation: observation(),
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  const assignment = createAssignment(db, {
    commandId: 'asg-replay',
    projectId: registered.projectId,
    worktreeId: worktreeIdFor('wt-replay'),
    agent: 'codex',
    task: 'replay guard',
    ttlMs: 60_000,
    dispatchCode: 'CODE-REPLAY',
  }, { now: T0 });
  assert.equal(assignment.ok, true, JSON.stringify(assignment));
  return { db, projectId: registered.projectId, assignment };
}

test('replaying an accepted grant after its issue TTL rebuilds the original success', (t) => {
  const { db, assignment } = dispatchFixture(t);
  const first = acceptAssignment(db, {
    dispatchCode: 'CODE-REPLAY',
    clientRequestId: 'cr-replay-1',
    sessionId: 'session-replay',
  }, { now: T0 + 1_000 });
  assert.equal(first.ok, true, JSON.stringify(first));

  const retry = acceptAssignment(db, {
    commandId: 'cmd-replay-after-ttl',
    dispatchCode: 'CODE-REPLAY',
    clientRequestId: 'cr-replay-1',
    sessionId: 'session-replay',
  }, { now: T0 + 7 * 60 * 1_000 });
  // 修复前实测：ok:false / DISPATCH_GRANT_EXPIRED，而 assignments 仍是有效的
  // accepted 会话——回执与持久状态相反，宿主被告知凭证失效可能重新 init。
  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.equal(retry.alreadyAccepted, true);
  assert.equal(retry.assignmentId, assignment.assignmentId);
  assert.equal(retry.sessionId, 'session-replay');

  const grant = db.prepare('SELECT state FROM dispatch_grants WHERE assignment_id = ?')
    .get(assignment.assignmentId);
  assert.equal(grant.state, 'accepted');
});

test('a grant that was never accepted still expires (protection, both directions)', (t) => {
  const { db } = dispatchFixture(t);
  const late = acceptAssignment(db, {
    commandId: 'cmd-late-first',
    dispatchCode: 'CODE-REPLAY',
    clientRequestId: 'cr-too-late',
    sessionId: 'session-late',
  }, { now: T0 + 7 * 60 * 1_000 });
  assert.equal(late.ok, false);
  assert.equal(late.code, 'DISPATCH_GRANT_EXPIRED');
});

test('revocation keeps precedence over the accepted replay branch', (t) => {
  const { db, assignment } = dispatchFixture(t);
  const first = acceptAssignment(db, {
    dispatchCode: 'CODE-REPLAY',
    clientRequestId: 'cr-revoke-order',
    sessionId: 'session-revoked',
  }, { now: T0 + 1_000 });
  assert.equal(first.ok, true, JSON.stringify(first));
  db.prepare("UPDATE dispatch_grants SET state = 'revoked' WHERE assignment_id = ?")
    .run(assignment.assignmentId);
  const after = acceptAssignment(db, {
    commandId: 'cmd-after-revoke',
    dispatchCode: 'CODE-REPLAY',
    clientRequestId: 'cr-revoke-order',
    sessionId: 'session-revoked',
  }, { now: T0 + 7 * 60 * 1_000 });
  assert.equal(after.ok, false);
  assert.equal(after.code, 'DISPATCH_GRANT_REVOKED');
});

test('a different logical request after acceptance is already-accepted, not expired', (t) => {
  const { db, assignment } = dispatchFixture(t);
  const first = acceptAssignment(db, {
    dispatchCode: 'CODE-REPLAY',
    clientRequestId: 'cr-A',
    sessionId: 'session-A',
  }, { now: T0 + 1_000 });
  assert.equal(first.ok, true, JSON.stringify(first));
  const rival = acceptAssignment(db, {
    commandId: 'cmd-rival',
    dispatchCode: 'CODE-REPLAY',
    clientRequestId: 'cr-B',
    sessionId: 'session-B',
  }, { now: T0 + 7 * 60 * 1_000 });
  assert.equal(rival.ok, false);
  assert.equal(rival.code, 'DISPATCH_GRANT_ALREADY_ACCEPTED');
  assert.equal(rival.assignmentId, assignment.assignmentId);
});
