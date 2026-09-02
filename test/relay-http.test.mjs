import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { registerProject } from '../src/core/projects.mjs';
import { probeGitWorktree } from '../src/git/probe.mjs';
import { createCockpitHttpServer } from '../src/service/http-server.mjs';

const TOKEN = 'relay-http-test-token-that-is-long-enough';

async function post(service, pathname, body) {
  return fetch(`http://${service.host}:${service.port}${pathname}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('HTTP relay/resume keeps one active session and exposes relay_waiting in the dashboard', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-relay-http-'));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  writeFileSync(path.join(root, 'README.md'), '# relay fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', [
    '-c', 'user.name=UGK Test',
    '-c', 'user.email=ugk@example.invalid',
    'commit', '--quiet', '-m', 'fixture',
  ], { cwd: root });
  const dbPath = path.join(root, 'cockpit.db');
  const observation = await probeGitWorktree(root);
  const db = openCockpitDatabase(dbPath);
  const project = registerProject(db, {
    commandId: 'register-relay-http-fixture',
    name: 'HTTP relay fixture',
    authorizedRoot: root,
    observation,
  });
  db.close();

  const service = await createCockpitHttpServer({ dbPath, token: TOKEN });
  t.after(async () => {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  });

  const assignmentResponse = await post(
    service,
    `/api/v1/projects/${project.projectId}/assignments`,
    { clientRequestId: 'relay-http-assignment', agent: 'Codex', mode: 'init', task: '验证 relay HTTP 闭环' },
  );
  assert.equal(assignmentResponse.status, 201, await assignmentResponse.clone().text());
  const assignment = await assignmentResponse.json();
  const initCode = assignment.message.match(/initCode: "([^\"]+)"/)?.[1];
  assert.ok(initCode);

  const initResponse = await post(service, '/api/v1/mcp/work/init', {
    initCode,
    clientRequestId: 'relay-http-init',
    currentTask: '验证 relay HTTP 闭环',
    currentState: '已接入，准备换会话',
    mcpWorkingDirectory: root,
  });
  assert.equal(initResponse.status, 200, await initResponse.clone().text());
  const initialized = await initResponse.json();

  const relayBody = {
    sessionId: initialized.sessionId,
    clientRequestId: 'relay-http-create',
    expectedRevision: initialized.revision,
    nextSessionFocus: '继续同一 HTTP 工作会话',
    summary: '已准备接力',
    currentState: '原会话仍 active 并持有写入权限',
    completedItems: ['接通 HTTP relay'],
    pendingItems: ['由新会话继续'],
    decisions: ['不重新 init'],
    artifactRefs: ['src/core/relays.mjs'],
    risks: [],
    suggestedSkills: ['cockpit-relay'],
  };
  const relayResponse = await post(service, '/api/v1/mcp/work/relay', relayBody);
  assert.equal(relayResponse.status, 200, await relayResponse.clone().text());
  const prepared = await relayResponse.json();
  assert.equal(prepared.relayPrepared, true);
  assert.equal(prepared.status, 'awaiting_resume');
  assert.equal(prepared.revision, initialized.revision + 1);
  assert.ok(prepared.continueCode);

  // The HTTP payload does not carry the secret.  A retry after a lost
  // response deterministically derives the same code from the service token.
  const relayRetry = await post(service, '/api/v1/mcp/work/relay', relayBody);
  assert.equal(relayRetry.status, 200, await relayRetry.clone().text());
  assert.deepEqual(await relayRetry.json(), prepared);

  const relayConflict = await post(service, '/api/v1/mcp/work/relay', {
    ...relayBody,
    summary: '同一个请求号不能改写接力内容',
  });
  assert.equal(relayConflict.status, 409, await relayConflict.clone().text());
  assert.equal((await relayConflict.json()).code, 'COMMAND_CONFLICT');

  for (const field of ['relayId', 'commandId', 'expiresAt', 'ttlMs']) {
    const invalid = await post(service, '/api/v1/mcp/work/relay', {
      ...relayBody,
      clientRequestId: `relay-http-invalid-${field}`,
      [field]: field === 'ttlMs' ? 60_000 : 'not-allowed',
    });
    assert.equal(invalid.status, 400, `${field} must be rejected`);
    assert.equal((await invalid.json()).code, 'INVALID_REQUEST');
  }

  const dashboard = await (await fetch(
    `http://${service.host}:${service.port}/api/v1/dashboard`,
    { headers: { authorization: `Bearer ${TOKEN}` } },
  )).json();
  assert.equal(dashboard.projects[0].status, 'active');
  assert.equal(dashboard.projects[0].statusReason, 'relay_waiting');
  assert.equal(dashboard.projects[0].activeRelay.relayId, prepared.relayId);

  const resumeBody = {
    continueCode: prepared.continueCode,
    clientRequestId: 'relay-http-resume',
    mcpWorkingDirectory: root,
  };
  for (const field of ['relayId', 'commandId', 'expiresAt', 'ttlMs']) {
    const invalid = await post(service, '/api/v1/mcp/work/resume', {
      ...resumeBody,
      clientRequestId: `relay-http-resume-invalid-${field}`,
      [field]: field === 'ttlMs' ? 60_000 : 'not-allowed',
    });
    assert.equal(invalid.status, 400, `${field} must be rejected`);
    assert.equal((await invalid.json()).code, 'INVALID_REQUEST');
  }

  const resumeResponse = await post(service, '/api/v1/mcp/work/resume', resumeBody);
  assert.equal(resumeResponse.status, 200, await resumeResponse.clone().text());
  const resumed = await resumeResponse.json();
  assert.equal(resumed.relayAccepted, true);
  assert.equal(resumed.status, 'active');
  assert.equal(resumed.sessionId, initialized.sessionId);
  assert.equal(resumed.relayId, prepared.relayId);
  assert.equal(resumed.revision, prepared.revision + 1);
  assert.equal(resumed.relay.summary, '已准备接力');

  const replay = await post(service, '/api/v1/mcp/work/resume', {
    continueCode: prepared.continueCode,
    clientRequestId: 'relay-http-resume',
    mcpWorkingDirectory: root,
  });
  assert.equal(replay.status, 200, await replay.clone().text());
  assert.deepEqual(await replay.json(), resumed);

  const state = openCockpitDatabase(dbPath, { migrate: false });
  const row = state.prepare(`
    SELECT runs.lifecycle AS run_lifecycle, runs.revision AS run_revision,
           assignments.status AS assignment_status, assignments.revision AS assignment_revision,
           relays.state, relays.code_hash
    FROM runs
    JOIN assignments ON assignments.session_id = runs.id
    JOIN relays ON relays.session_id = runs.id
    WHERE runs.id = ?
  `).get(initialized.sessionId);
  assert.equal(row.run_lifecycle, 'active');
  assert.equal(row.assignment_status, 'active');
  assert.equal(row.run_revision, resumed.revision);
  assert.equal(row.assignment_revision, resumed.revision);
  assert.equal(row.state, 'accepted');
  assert.equal(JSON.stringify(row).includes(prepared.continueCode), false);
  assert.equal(state.prepare('SELECT count(*) AS count FROM write_leases').get().count, 1);
  state.close();
});
