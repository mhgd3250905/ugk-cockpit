import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCockpitDatabase } from '../src/core/database.mjs';
import {
  acceptAssignment,
  createAssignment,
  recordProgress,
} from '../src/core/assignments.mjs';
import { readDashboard } from '../src/core/projects.mjs';
import { startWriteRun } from '../src/core/runs.mjs';
import {
  createRelay,
  readLatestActiveRelay,
  resumeRelay,
} from '../src/core/relays.mjs';
import { createServiceHandlers } from '../src/mcp/service-client.mjs';
import { TOOLS, dispatchMessage } from '../src/mcp/stdio-protocol.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-relay-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openCockpitDatabase(path.join(root, 'cockpit.db'));
  const at = new Date().toISOString();
  db.prepare(`
    INSERT INTO worktrees (
      id, canonical_path, repository_identity, identity_fingerprint, created_at
    ) VALUES ('worktree-relay', 'E:\\fixture\\relay', 'repo-relay', 'identity-relay', ?)
  `).run(at);
  db.prepare(`
    INSERT INTO projects (
      id, name, stage, worktree_id, status, status_reason,
      last_observed_at, created_at, updated_at, authorized_root
    ) VALUES ('project-relay', 'Relay fixture', 'development',
      'worktree-relay', 'ready', 'ready_to_start', ?, ?, ?, 'E:\\fixture\\relay')
  `).run(at, at, at);
  return db;
}

const relayFields = {
  nextSessionFocus: '继续验证换会话后的同一工作上下文',
  summary: '已经完成接力状态机',
  currentState: '代码仍由当前 active 会话持有写入权限',
  completedItems: ['持久化接力记录'],
  pendingItems: ['由下一会话继续'],
  decisions: ['不创建第二个 assignment'],
  artifactRefs: ['src/core/relays.mjs'],
  risks: [],
  suggestedSkills: ['cockpit-relay'],
};

function activeSession(db) {
  const assignment = createAssignment(db, {
    commandId: 'relay-assignment-create',
    assignmentId: 'assignment-relay',
    projectId: 'project-relay',
    agentId: 'Codex',
    taskId: 'relay task',
    scope: { mode: 'write' },
    dispatchCode: 'relay-dispatch-code',
  });
  const accepted = acceptAssignment(db, {
    dispatchCode: assignment.dispatchCode,
    clientRequestId: 'relay-accept',
    sessionId: 'session-relay',
  });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  const started = startWriteRun(db, {
    commandId: 'relay-run-start',
    runId: 'session-relay',
    worktreeId: 'worktree-relay',
    canonicalPath: 'E:\\fixture\\relay',
    repositoryIdentity: 'repo-relay',
    worktreeIdentity: 'identity-relay',
    agentClaim: 'Codex',
    goal: 'relay task',
    baseline: {
      head: 'head-relay',
      branch: 'main',
      indexFingerprint: 'index-relay',
      worktreeFingerprint: 'worktree-relay',
      repositoryIdentity: 'repo-relay',
      worktreeIdentity: 'identity-relay',
      headRelation: 'same',
      coherence: 'coherent',
    },
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  return recordProgress(db, {
    sessionId: 'session-relay',
    clientRequestId: 'relay-progress',
    expectedRevision: 1,
    status: 'working',
    note: '已经有一个有效检查点',
  });
}

test('relay advances the same active Run/assignment, stores only a code hash, and resumes once', (t) => {
  const db = fixture(t);
  const progress = activeSession(db);
  assert.equal(progress.revision, 2);

  const prepared = createRelay(db, {
    sessionId: 'session-relay',
    clientRequestId: 'relay-create',
    expectedRevision: progress.revision,
    continueCode: 'relay-secret-code',
    ttlMs: 60_000,
    ...relayFields,
  }, { clock: 1_800_000_000_000 });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  assert.equal(prepared.relayPrepared, true);
  assert.equal(prepared.status, 'awaiting_resume');
  assert.equal(prepared.revision, 3);
  assert.equal(prepared.sessionId, 'session-relay');
  assert.equal(typeof prepared.relayId, 'string');
  assert.equal(prepared.continueCode, 'relay-secret-code');

  const state = db.prepare(`
    SELECT runs.lifecycle AS run_lifecycle, runs.revision AS run_revision,
           assignments.status AS assignment_status, assignments.revision AS assignment_revision,
           write_leases.run_id, relays.state, relays.code_hash
    FROM runs
    JOIN assignments ON assignments.session_id = runs.id
    JOIN write_leases ON write_leases.run_id = runs.id
    JOIN relays ON relays.session_id = runs.id
    WHERE runs.id = 'session-relay'
  `).get();
  assert.equal(state.run_lifecycle, 'active');
  assert.equal(state.assignment_status, 'active');
  assert.equal(state.run_revision, 3);
  assert.equal(state.assignment_revision, 3);
  assert.equal(state.run_id, 'session-relay');
  assert.equal(state.state, 'active');
  assert.equal(JSON.stringify(state).includes('relay-secret-code'), false);
  assert.equal(db.prepare(`
    SELECT count(*) AS count FROM commands
    WHERE request_json LIKE '%relay-secret-code%' OR response_json LIKE '%relay-secret-code%'
  `).get().count, 0);
  assert.equal(db.prepare('SELECT count(*) AS count FROM handoff_receipts').get().count, 0);

  const preparedRetry = createRelay(db, {
    sessionId: 'session-relay',
    clientRequestId: 'relay-create',
    expectedRevision: progress.revision,
    continueCode: 'relay-secret-code',
    ttlMs: 60_000,
    ...relayFields,
  }, { clock: 1_800_000_000_001 });
  assert.deepEqual(preparedRetry, prepared);
  assert.throws(() => createRelay(db, {
    sessionId: 'session-relay',
    clientRequestId: 'relay-create',
    expectedRevision: progress.revision,
    continueCode: 'relay-secret-code',
    ttlMs: 60_000,
    ...relayFields,
    summary: '同一个请求号不能改写接力内容',
  }, { clock: 1_800_000_000_001 }), { code: 'COMMAND_CONFLICT' });

  const dashboard = readDashboard(db)[0];
  assert.equal(dashboard.status, 'active');
  assert.equal(dashboard.statusReason, 'relay_waiting');
  assert.equal(dashboard.activeRun.id, 'session-relay');
  assert.equal(dashboard.activeRelay.relayId, prepared.relayId);

  const resumed = resumeRelay(db, {
    continueCode: prepared.continueCode,
    clientRequestId: 'relay-resume',
    workingDirectory: 'E:\\fixture\\relay',
  }, { clock: 1_800_000_000_001 });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(resumed.relayAccepted, true);
  assert.equal(resumed.status, 'active');
  assert.equal(resumed.sessionId, prepared.sessionId);
  assert.equal(resumed.relayId, prepared.relayId);
  assert.equal(resumed.revision, 4);
  assert.equal(resumed.relay.summary, relayFields.summary);
  assert.equal(resumed.context.run.revision, 4);

  assert.deepEqual(resumeRelay(db, {
    continueCode: prepared.continueCode,
    clientRequestId: 'relay-resume',
    workingDirectory: 'E:\\fixture\\relay',
  }, { clock: 1_800_000_000_002 }), resumed);
  assert.deepEqual(createRelay(db, {
    sessionId: 'session-relay',
    clientRequestId: 'relay-create',
    expectedRevision: progress.revision,
    continueCode: 'relay-secret-code',
    ttlMs: 60_000,
    ...relayFields,
  }, { clock: 1_800_000_000_002 }), prepared);
  const replayedByOtherRequest = resumeRelay(db, {
    continueCode: prepared.continueCode,
    clientRequestId: 'relay-resume-other',
    workingDirectory: 'E:\\fixture\\relay',
  }, { clock: 1_800_000_000_002 });
  assert.equal(replayedByOtherRequest.code, 'RELAY_ALREADY_ACCEPTED');

  const finalState = db.prepare(`
    SELECT runs.lifecycle AS run_lifecycle, runs.revision AS run_revision,
           assignments.status AS assignment_status, assignments.revision AS assignment_revision,
           relays.state, relays.accepted_revision
    FROM runs
    JOIN assignments ON assignments.session_id = runs.id
    JOIN relays ON relays.session_id = runs.id
    WHERE runs.id = 'session-relay'
  `).get();
  assert.equal(finalState.run_lifecycle, 'active');
  assert.equal(finalState.assignment_status, 'active');
  assert.equal(finalState.run_revision, 4);
  assert.equal(finalState.assignment_revision, 4);
  assert.equal(finalState.state, 'accepted');
  assert.equal(finalState.accepted_revision, 4);
  assert.equal(db.prepare('SELECT count(*) AS count FROM write_leases').get().count, 1);
  db.close();
});

test('expired relays stop blocking a new create and stay hidden from active reads', (t) => {
  const db = fixture(t);
  const progress = activeSession(db);
  const issuedAt = Date.now();
  const first = createRelay(db, {
    sessionId: 'session-relay',
    clientRequestId: 'relay-expired-create',
    expectedRevision: progress.revision,
    continueCode: 'relay-expired-create-code',
    ttlMs: 60_000,
    ...relayFields,
  }, { clock: issuedAt });
  assert.equal(first.ok, true, JSON.stringify(first));

  db.prepare('UPDATE relays SET expires_at = ? WHERE id = ?')
    .run(issuedAt - 1, first.relayId);
  assert.equal(readLatestActiveRelay(db, 'session-relay'), null);
  const dashboardBeforeNewCreate = readDashboard(db)[0];
  assert.equal(dashboardBeforeNewCreate.status, 'active');
  assert.equal(dashboardBeforeNewCreate.statusReason, 'active_work');
  assert.equal(dashboardBeforeNewCreate.activeRelay, null);

  // The original create is still idempotent after natural expiry: its
  // committed command journal rebuilds the same prepared response and code.
  assert.deepEqual(createRelay(db, {
    sessionId: 'session-relay',
    clientRequestId: 'relay-expired-create',
    expectedRevision: progress.revision,
    continueCode: 'relay-expired-create-code',
    ttlMs: 60_000,
    ...relayFields,
  }, { clock: issuedAt + 120_000 }), first);

  const second = createRelay(db, {
    sessionId: 'session-relay',
    clientRequestId: 'relay-new-after-expiry',
    expectedRevision: first.revision,
    continueCode: 'relay-new-code',
    ttlMs: 60_000,
    ...relayFields,
  }, { clock: issuedAt + 120_000 });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.revision, first.revision + 1);
  assert.equal(db.prepare('SELECT state FROM relays WHERE id = ?').get(first.relayId).state, 'expired');
  assert.equal(db.prepare('SELECT state FROM relays WHERE id = ?').get(second.relayId).state, 'active');
  assert.equal(readLatestActiveRelay(db, 'session-relay').relayId, second.relayId);
  db.close();
});

test('resume rejects a mismatched working directory and expires without consuming early', (t) => {
  const db = fixture(t);
  const progress = activeSession(db);
  const prepared = createRelay(db, {
    sessionId: 'session-relay',
    clientRequestId: 'relay-expiry',
    expectedRevision: progress.revision,
    continueCode: 'relay-expiring-code',
    ttlMs: 10,
    ...relayFields,
  }, { clock: 1_800_000_000_000 });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));

  const mismatch = resumeRelay(db, {
    continueCode: prepared.continueCode,
    clientRequestId: 'relay-wrong-cwd',
    workingDirectory: 'E:\\fixture\\other',
  }, { clock: 1_800_000_000_001 });
  assert.equal(mismatch.code, 'RELAY_BINDING_MISMATCH');
  assert.equal(db.prepare('SELECT state FROM relays').get().state, 'active');

  const expired = resumeRelay(db, {
    continueCode: prepared.continueCode,
    clientRequestId: 'relay-expired',
    workingDirectory: 'E:\\fixture\\relay',
  }, { clock: 1_800_000_000_011 });
  assert.equal(expired.code, 'RELAY_EXPIRED');
  assert.equal(db.prepare('SELECT state FROM relays').get().state, 'expired');
  assert.equal(db.prepare('SELECT revision FROM runs').get().revision, 3);
  db.close();
});

test('stdio exposes strict relay/resume schemas and service-client forwards the cwd only for resume', async () => {
  const relayTool = TOOLS.find((tool) => tool.name === 'ugk_work_relay');
  const resumeTool = TOOLS.find((tool) => tool.name === 'ugk_work_resume');
  assert.ok(relayTool);
  assert.ok(resumeTool);
  assert.deepEqual(relayTool.inputSchema.required, [
    'sessionId',
    'clientRequestId',
    'expectedRevision',
    'nextSessionFocus',
    'summary',
    'currentState',
    'completedItems',
    'pendingItems',
    'decisions',
    'artifactRefs',
    'risks',
    'suggestedSkills',
  ]);
  assert.deepEqual(resumeTool.inputSchema.required, ['continueCode', 'clientRequestId']);
  assert.equal(relayTool.inputSchema.additionalProperties, false);
  assert.equal(resumeTool.inputSchema.additionalProperties, false);

  const relayArgs = {
    sessionId: 'session-stdio-relay',
    clientRequestId: 'stdio-relay-request',
    expectedRevision: 3,
    ...relayFields,
  };
  let seenRelay;
  const relayResponse = await dispatchMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'ugk_work_relay', arguments: relayArgs },
  }, {
    handlers: {
      ugk_work_relay: async (args) => {
        seenRelay = args;
        return { relayPrepared: true, status: 'awaiting_resume' };
      },
    },
  });
  assert.deepEqual(seenRelay, relayArgs);
  assert.equal(JSON.parse(relayResponse.result.content[0].text).relayPrepared, true);

  const calls = [];
  const handlers = createServiceHandlers({
    token: 'x'.repeat(32),
    workingDirectory: 'E:\\fixture\\relay',
    fetchImpl: async (url, options) => {
      calls.push({ url: url.toString(), options });
      return new Response(JSON.stringify({
        relayAccepted: true,
        status: 'active',
        sessionId: 'session-stdio-relay',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  await handlers.ugk_work_resume({
    continueCode: 'continue-code',
    clientRequestId: 'stdio-resume-request',
  });
  assert.equal(calls[0].url, 'http://127.0.0.1:41737/api/v1/mcp/work/resume');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    continueCode: 'continue-code',
    clientRequestId: 'stdio-resume-request',
    mcpWorkingDirectory: 'E:\\fixture\\relay',
  });
});
