import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCockpitDatabase } from '../src/core/database.mjs';
import {
  acceptAssignment,
  completeAssignment,
  createAssignment,
  readDispatchContext,
  readSessionContext,
  recordProgress,
  revokeAssignment,
} from '../src/core/assignments.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-assignment-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openCockpitDatabase(path.join(root, 'cockpit.db'));
  db.prepare(`
    INSERT INTO worktrees (
      id, canonical_path, repository_identity, identity_fingerprint, created_at
    ) VALUES ('worktree-assignment', 'E:\\fixture\\assignment', 'repo-assignment', 'identity-assignment', ?)
  `).run(new Date().toISOString());
  db.prepare(`
    INSERT INTO projects (
      id, name, stage, worktree_id, status, status_reason,
      last_observed_at, created_at, updated_at, authorized_root
    ) VALUES ('project-assignment', 'Assignment fixture', 'development',
      'worktree-assignment', 'ready', 'ready_to_start', ?, ?, ?, 'E:\\fixture\\assignment')
  `).run(...Array.from({ length: 3 }, () => new Date().toISOString()));
  return db;
}

function clock() {
  return 1_800_000_000_000;
}

test('create returns a one-time code while only its SHA-256 digest is stored', (t) => {
  const db = fixture(t);
  const result = createAssignment(db, {
    commandId: 'assignment-create-hash',
    assignmentId: 'assignment-hash',
    projectId: 'project-assignment',
    agentId: 'agent-one',
    taskId: 'task-one',
    scope: { root: 'src', mode: 'write' },
    dispatchCode: 'secret-dispatch-code',
    ttlMs: 60_000,
  }, { clock });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.dispatchCode, 'secret-dispatch-code');
  const grant = db.prepare('SELECT * FROM dispatch_grants').get();
  assert.equal(
    grant.code_hash,
    createHash('sha256').update('secret-dispatch-code').digest('hex'),
  );
  assert.equal(JSON.stringify(grant).includes('secret-dispatch-code'), false);
  assert.deepEqual(readDispatchContext(db, { dispatchCode: result.dispatchCode }, { clock }), {
    ok: true,
    grantId: result.grantId,
    assignmentId: 'assignment-hash',
    projectId: 'project-assignment',
    worktreeId: 'worktree-assignment',
    canonicalPath: 'E:\\fixture\\assignment',
    repositoryIdentity: 'repo-assignment',
    worktreeIdentity: 'identity-assignment',
    agentId: 'agent-one',
    taskId: 'task-one',
    scope: { mode: 'write', root: 'src' },
    codeHash: grant.code_hash,
    state: 'active',
    expiresAt: clock() + 60_000,
    expiresAtIso: new Date(clock() + 60_000).toISOString(),
    createdAt: new Date(clock()).toISOString(),
    acceptedAt: null,
    acceptedSessionId: null,
    acceptedClientRequestId: null,
    revokedAt: null,
    accepted: false,
  });
  db.close();
});

test('accept is idempotent, binds the session, and fences stale progress', (t) => {
  const db = fixture(t);
  const created = createAssignment(db, {
    commandId: 'assignment-create-accept',
    assignmentId: 'assignment-accept',
    projectId: 'project-assignment',
    agentId: 'agent-one',
    taskId: 'task-one',
    scope: { root: 'src' },
    dispatchCode: 'accept-code',
  }, { clock });
  const request = {
    dispatchCode: created.dispatchCode,
    clientRequestId: 'accept-request',
    sessionId: 'session-one',
  };
  const accepted = acceptAssignment(db, request, { clock });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(accepted.revision, 1);
  assert.deepEqual(acceptAssignment(db, request, { clock }), accepted);
  const competing = acceptAssignment(db, {
    dispatchCode: created.dispatchCode,
    clientRequestId: 'accept-competing',
    sessionId: 'session-two',
  }, { clock });
  assert.equal(competing.ok, false);
  assert.equal(competing.code, 'DISPATCH_GRANT_ALREADY_ACCEPTED');

  const first = recordProgress(db, {
    sessionId: 'session-one',
    clientRequestId: 'progress-one',
    expectedRevision: 1,
    status: 'working',
    note: 'started',
  }, { clock });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.revision, 2);
  assert.deepEqual(recordProgress(db, {
    sessionId: 'session-one',
    clientRequestId: 'progress-one',
    expectedRevision: 1,
    status: 'working',
    note: 'started',
  }, { clock }), first);
  const stale = recordProgress(db, {
    sessionId: 'session-one',
    clientRequestId: 'progress-stale',
    expectedRevision: 1,
    status: 'working',
    note: 'stale',
  }, { clock });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'ASSIGNMENT_REVISION_CONFLICT');
  assert.equal(db.prepare('SELECT count(*) AS count FROM progress_events').get().count, 1);
  assert.equal(readSessionContext(db, 'session-one').revision, 2);

  const finished = completeAssignment(db, {
    sessionId: 'session-one',
    clientRequestId: 'finish-one',
    expectedRevision: 2,
    outcome: 'completed',
    summary: 'done',
    nextStep: 'handoff',
  }, { clock });
  assert.equal(finished.ok, true, JSON.stringify(finished));
  assert.equal(finished.revision, 3);
  assert.equal(readSessionContext(db, 'session-one').status, 'completed');
  db.close();
});

test('expired and revoked dispatch codes cannot be accepted', (t) => {
  const db = fixture(t);
  const expired = createAssignment(db, {
    commandId: 'assignment-create-expired',
    assignmentId: 'assignment-expired',
    projectId: 'project-assignment',
    agentId: 'agent-one',
    taskId: 'task-expired',
    dispatchCode: 'expired-code',
    ttlMs: 10,
  }, { clock: () => clock() - 100 });
  const expiredResult = acceptAssignment(db, {
    dispatchCode: expired.dispatchCode,
    clientRequestId: 'expired-accept',
  }, { clock });
  assert.equal(expiredResult.code, 'DISPATCH_GRANT_EXPIRED');

  const revoked = createAssignment(db, {
    commandId: 'assignment-create-revoked',
    assignmentId: 'assignment-revoked',
    projectId: 'project-assignment',
    agentId: 'agent-one',
    taskId: 'task-revoked',
    dispatchCode: 'revoked-code',
  }, { clock });
  assert.equal(revokeAssignment(db, { dispatchCode: revoked.dispatchCode }, { clock }).ok, true);
  const revokedResult = acceptAssignment(db, {
    dispatchCode: revoked.dispatchCode,
    clientRequestId: 'revoked-accept',
  }, { clock });
  assert.equal(revokedResult.code, 'DISPATCH_GRANT_REVOKED');
  db.close();
});

test('progress rejects terminal statuses while handoff can reconcile a matching legacy terminal assignment', (t) => {
  const db = fixture(t);
  const created = createAssignment(db, {
    commandId: 'assignment-create-terminal-progress',
    assignmentId: 'assignment-terminal-progress',
    projectId: 'project-assignment',
    agentId: 'agent-one',
    taskId: 'task-one',
    scope: { mode: 'write' },
    dispatchCode: 'terminal-progress-code',
  }, { clock });
  const accepted = acceptAssignment(db, {
    dispatchCode: created.dispatchCode,
    clientRequestId: 'terminal-progress-accept',
    sessionId: 'terminal-progress-session',
  }, { clock });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));

  const terminalProgress = recordProgress(db, {
    sessionId: accepted.sessionId,
    clientRequestId: 'terminal-progress-event',
    expectedRevision: accepted.revision,
    status: 'completed',
    note: '旧客户端错误地用 progress 结束工作',
  }, { clock });
  assert.equal(terminalProgress.ok, false);
  assert.equal(terminalProgress.code, 'INVALID_REQUEST');
  assert.equal(readSessionContext(db, accepted.sessionId).status, 'accepted');
  assert.equal(readSessionContext(db, accepted.sessionId).revision, accepted.revision);

  db.prepare(`
    UPDATE assignments SET status = 'completed'
    WHERE id = ? AND revision = ?
  `).run(accepted.assignmentId, accepted.revision);
  const reconciled = completeAssignment(db, {
    sessionId: accepted.sessionId,
    clientRequestId: 'terminal-progress-handoff',
    expectedRevision: accepted.revision,
    outcome: 'completed',
    summary: '通过 handoff 收束旧状态',
  }, {
    allowTerminalReconciliation: true,
    clock,
  });
  assert.equal(reconciled.ok, true, JSON.stringify(reconciled));
  assert.equal(reconciled.revision, accepted.revision + 1);
  assert.equal(readSessionContext(db, accepted.sessionId).status, 'completed');
  assert.equal(readSessionContext(db, accepted.sessionId).revision, accepted.revision + 1);

  const mismatched = completeAssignment(db, {
    sessionId: accepted.sessionId,
    clientRequestId: 'terminal-progress-mismatched',
    expectedRevision: reconciled.revision,
    outcome: 'blocked',
    summary: '不应覆盖旧 terminal 状态',
  }, {
    allowTerminalReconciliation: true,
    clock,
  });
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.code, 'ASSIGNMENT_NOT_ACTIVE');
  db.close();
});
