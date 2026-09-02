import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCockpitDatabase } from '../src/core/database.mjs';
import {
  acceptAssignment,
  appendProgressEvent,
  completeAssignment,
  createAssignment,
  issueDispatchGrant,
  readDispatchContext,
  readSessionContext,
  reassignPendingAssignment,
  recordProgress,
  revokeAssignment,
  revokeDispatchGrant,
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

test('structured progress records summary, details, and git evidence with idempotency', (t) => {
  const db = fixture(t, 'structured-progress');
  const project = db.prepare('SELECT id FROM projects LIMIT 1').get();
  const created = createAssignment(db, {
    assignmentId: 'assign-structured-1',
    projectId: project.id,
    agentId: 'Codex',
    taskId: 'Build structured progress',
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const accepted = acceptAssignment(db, {
    dispatchCode: created.dispatchCode,
    clientRequestId: 'req-accept-structured',
    sessionId: 'run-1',
  });
  assert.equal(accepted.ok, true);

  // 1. Structured progress with summary and details
  const prog1 = appendProgressEvent(db, {
    sessionId: accepted.sessionId,
    clientRequestId: 'prog-req-1',
    expectedRevision: 1,
    status: 'working',
    summary: '完成数据层设计与迁移',
    details: ['字段 summary nullable', 'details_json 默认 []', '支持 git_head/branch 字段'],
    gitHead: 'abcdef1234567890abcdef1234567890abcdef12',
    gitBranch: 'feature/structured-progress',
    gitCoherence: 'coherent',
    gitObservedAt: '2026-09-02T10:00:00.000Z',
  });
  assert.equal(prog1.ok, true);
  assert.equal(prog1.revision, 2);
  assert.equal(prog1.summary, '完成数据层设计与迁移');
  assert.deepEqual(prog1.details, ['字段 summary nullable', 'details_json 默认 []', '支持 git_head/branch 字段']);
  assert.equal(prog1.git.branch, 'feature/structured-progress');
  assert.equal(prog1.git.shortHead, 'abcdef1');
  assert.equal(prog1.git.coherence, 'coherent');

  // 2. Idempotent replay of same request returns original event and same revision
  const replay1 = appendProgressEvent(db, {
    sessionId: accepted.sessionId,
    clientRequestId: 'prog-req-1',
    expectedRevision: 1,
    status: 'working',
    summary: '完成数据层设计与迁移',
    details: ['字段 summary nullable', 'details_json 默认 []', '支持 git_head/branch 字段'],
    // Even if git probe returns different head during replay, replay succeeds without conflict
    gitHead: '9999991234567890abcdef1234567890abcdef12',
    gitBranch: 'feature/other',
  });
  assert.equal(replay1.ok, true);
  assert.equal(replay1.eventId, prog1.eventId);
  assert.equal(replay1.revision, 2);
  assert.equal(replay1.git.branch, 'feature/structured-progress');
  assert.equal(replay1.git.shortHead, 'abcdef1');

  // 3. Conflict when replaying same clientRequestId with modified summary
  assert.throws(
    () => appendProgressEvent(db, {
      sessionId: accepted.sessionId,
      clientRequestId: 'prog-req-1',
      expectedRevision: 1,
      status: 'working',
      summary: '修改过的不同摘要',
    }),
    (err) => err.code === 'COMMAND_CONFLICT' || err.code === 'PROGRESS_REQUEST_CONFLICT',
  );

  // 4. Legacy note-only progress continues to work
  const prog2 = appendProgressEvent(db, {
    sessionId: accepted.sessionId,
    clientRequestId: 'prog-req-2',
    expectedRevision: 2,
    status: 'working',
    note: 'Legacy note only progress event',
  });
  assert.equal(prog2.ok, true);
  assert.equal(prog2.revision, 3);
  assert.equal(prog2.note, 'Legacy note only progress event');
  assert.equal(prog2.summary, null);
  assert.deepEqual(prog2.details, []);
  assert.equal(prog2.git, null);

  // 5. Validation failures
  // Missing both summary and note
  const invalidEmpty = appendProgressEvent(db, {
    sessionId: accepted.sessionId,
    clientRequestId: 'prog-req-invalid-1',
    expectedRevision: 3,
    status: 'working',
  });
  assert.equal(invalidEmpty.ok, false);
  assert.equal(invalidEmpty.code, 'INVALID_REQUEST');

  // Summary too long (> 160)
  const invalidLongSummary = appendProgressEvent(db, {
    sessionId: accepted.sessionId,
    clientRequestId: 'prog-req-invalid-2',
    expectedRevision: 3,
    status: 'working',
    summary: 'A'.repeat(161),
  });
  assert.equal(invalidLongSummary.ok, false);
  assert.equal(invalidLongSummary.code, 'INVALID_REQUEST');

  // Too many details items (> 8)
  const invalidTooManyDetails = appendProgressEvent(db, {
    sessionId: accepted.sessionId,
    clientRequestId: 'prog-req-invalid-3',
    expectedRevision: 3,
    status: 'working',
    summary: 'Valid summary',
    details: Array(9).fill('Detail item'),
  });
  assert.equal(invalidTooManyDetails.ok, false);
  assert.equal(invalidTooManyDetails.code, 'INVALID_REQUEST');

  // Details item too long (> 500)
  const invalidLongDetail = appendProgressEvent(db, {
    sessionId: accepted.sessionId,
    clientRequestId: 'prog-req-invalid-4',
    expectedRevision: 3,
    status: 'working',
    summary: 'Valid summary',
    details: ['B'.repeat(501)],
  });
  assert.equal(invalidLongDetail.ok, false);
  assert.equal(invalidLongDetail.code, 'INVALID_REQUEST');

  // Details item empty
  const invalidEmptyDetail = appendProgressEvent(db, {
    sessionId: accepted.sessionId,
    clientRequestId: 'prog-req-invalid-5',
    expectedRevision: 3,
    status: 'working',
    summary: 'Valid summary',
    details: ['   '],
  });
  assert.equal(invalidEmptyDetail.ok, false);
  assert.equal(invalidEmptyDetail.code, 'INVALID_REQUEST');

  db.close();
});

test('createAssignment binds to development space worktree and rejects cross-project or archived spaces', (t) => {
  const db = fixture(t);
  const now = new Date().toISOString();

  // Create another project
  db.prepare(`
    INSERT INTO worktrees (id, canonical_path, repository_identity, identity_fingerprint, created_at)
    VALUES ('worktree-other', 'E:\\fixture\\other', 'repo-other', 'identity-other', ?)
  `).run(now);
  db.prepare(`
    INSERT INTO projects (id, name, stage, worktree_id, status, status_reason, last_observed_at, created_at, updated_at, authorized_root)
    VALUES ('project-other', 'Other project', 'development', 'worktree-other', 'ready', 'ready_to_start', ?, ?, ?, 'E:\\fixture\\other')
  `).run(now, now, now);

  // Create development spaces for project-assignment
  db.prepare(`
    INSERT INTO worktrees (id, canonical_path, repository_identity, identity_fingerprint, created_at)
    VALUES ('worktree-space-active', 'E:\\fixture\\space-active', 'repo-assignment', 'identity-space-active', ?)
  `).run(now);
  db.prepare(`
    INSERT INTO development_spaces (id, project_id, worktree_id, name, branch, base_commit, status, status_reason, created_at, updated_at)
    VALUES ('space-active', 'project-assignment', 'worktree-space-active', 'feature-1', 'ugk/feature-1', 'commit-1', 'ready', 'ready_to_start', ?, ?)
  `).run(now, now);

  db.prepare(`
    INSERT INTO worktrees (id, canonical_path, repository_identity, identity_fingerprint, created_at)
    VALUES ('worktree-space-archived', 'E:\\fixture\\space-archived', 'repo-assignment', 'identity-space-archived', ?)
  `).run(now);
  db.prepare(`
    INSERT INTO development_spaces (id, project_id, worktree_id, name, branch, base_commit, status, status_reason, created_at, updated_at)
    VALUES ('space-archived', 'project-assignment', 'worktree-space-archived', 'feature-archived', 'ugk/feature-archived', 'commit-1', 'archived', 'archived', ?, ?)
  `).run(now, now);

  // Create development space for project-other
  db.prepare(`
    INSERT INTO worktrees (id, canonical_path, repository_identity, identity_fingerprint, created_at)
    VALUES ('worktree-space-other', 'E:\\fixture\\space-other', 'repo-other', 'identity-space-other', ?)
  `).run(now);
  db.prepare(`
    INSERT INTO development_spaces (id, project_id, worktree_id, name, branch, base_commit, status, status_reason, created_at, updated_at)
    VALUES ('space-other', 'project-other', 'worktree-space-other', 'feature-other', 'ugk/feature-other', 'commit-other', 'ready', 'ready_to_start', ?, ?)
  `).run(now, now);

  // 1. Success creating assignment with spaceId
  const spaceResult = createAssignment(db, {
    commandId: 'assignment-create-space',
    assignmentId: 'assignment-space-1',
    projectId: 'project-assignment',
    spaceId: 'space-active',
    agentId: 'agent-one',
    taskId: 'space-task-one',
    scope: { root: 'src', mode: 'write' },
    dispatchCode: 'space-dispatch-code-1',
    ttlMs: 60_000,
  }, { clock });
  assert.equal(spaceResult.ok, true, JSON.stringify(spaceResult));
  assert.equal(spaceResult.spaceId, 'space-active');
  assert.equal(spaceResult.worktreeId, 'worktree-space-active');
  assert.equal(spaceResult.canonicalPath, 'E:\\fixture\\space-active');

  const context = readDispatchContext(db, { dispatchCode: 'space-dispatch-code-1' }, { clock });
  assert.equal(context.ok, true);
  assert.equal(context.spaceId, 'space-active');
  assert.equal(context.worktreeId, 'worktree-space-active');

  // 2. Accept space assignment and check session context
  const accepted = acceptAssignment(db, {
    dispatchCode: 'space-dispatch-code-1',
    clientRequestId: 'accept-space-1',
  }, { clock });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.spaceId, 'space-active');
  assert.equal(accepted.worktreeId, 'worktree-space-active');

  const sessionContext = readSessionContext(db, accepted.sessionId);
  assert.equal(sessionContext.ok, true);
  assert.equal(sessionContext.spaceId, 'space-active');
  assert.equal(sessionContext.worktreeId, 'worktree-space-active');

  // 3. Success creating assignment with worktreeId of space
  const worktreeResult = createAssignment(db, {
    commandId: 'assignment-create-worktree',
    assignmentId: 'assignment-space-2',
    projectId: 'project-assignment',
    worktreeId: 'worktree-space-active',
    agentId: 'agent-one',
    taskId: 'space-task-two',
    scope: { mode: 'write' },
    dispatchCode: 'space-dispatch-code-2',
  }, { clock });
  assert.equal(worktreeResult.ok, true);
  assert.equal(worktreeResult.spaceId, 'space-active');
  assert.equal(worktreeResult.worktreeId, 'worktree-space-active');

  // 4. Reject cross-project spaceId
  const crossSpace = createAssignment(db, {
    commandId: 'assignment-cross-space',
    assignmentId: 'assignment-cross-1',
    projectId: 'project-assignment',
    spaceId: 'space-other',
    agentId: 'agent-one',
    taskId: 'cross-task',
    scope: { mode: 'write' },
  });
  assert.equal(crossSpace.ok, false);
  assert.equal(crossSpace.code, 'WORKTREE_BINDING_MISMATCH');

  // 5. Reject cross-project worktreeId
  const crossWorktree = createAssignment(db, {
    commandId: 'assignment-cross-worktree',
    assignmentId: 'assignment-cross-2',
    projectId: 'project-assignment',
    worktreeId: 'worktree-other',
    agentId: 'agent-one',
    taskId: 'cross-task',
    scope: { mode: 'write' },
  });
  assert.equal(crossWorktree.ok, false);
  assert.equal(crossWorktree.code, 'WORKTREE_BINDING_MISMATCH');

  // 6. Reject archived spaceId
  const archivedSpace = createAssignment(db, {
    commandId: 'assignment-archived-space',
    assignmentId: 'assignment-archived-1',
    projectId: 'project-assignment',
    spaceId: 'space-archived',
    agentId: 'agent-one',
    taskId: 'archived-task',
    scope: { mode: 'write' },
  });
  assert.equal(archivedSpace.ok, false);
  assert.equal(archivedSpace.code, 'WORKTREE_BINDING_MISMATCH');

  // 7. Reject unknown worktreeId
  const unknownWorktree = createAssignment(db, {
    commandId: 'assignment-unknown-worktree',
    assignmentId: 'assignment-unknown-1',
    projectId: 'project-assignment',
    worktreeId: 'worktree-unknown',
    agentId: 'agent-one',
    taskId: 'unknown-task',
    scope: { mode: 'write' },
  });
  assert.equal(unknownWorktree.ok, false);
  assert.equal(unknownWorktree.code, 'WORKTREE_BINDING_MISMATCH');

  // 8. Without spaceId or worktreeId, defaults to main project worktree
  const defaultResult = createAssignment(db, {
    commandId: 'assignment-default-main',
    assignmentId: 'assignment-main-1',
    projectId: 'project-assignment',
    agentId: 'agent-one',
    taskId: 'main-task',
    scope: { mode: 'write' },
    dispatchCode: 'main-dispatch-code',
  }, { clock });
  assert.equal(defaultResult.ok, true);
  assert.equal(defaultResult.worktreeId, 'worktree-assignment');
  assert.equal(defaultResult.canonicalPath, 'E:\\fixture\\assignment');

  db.close();
});
