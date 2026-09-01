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

const TOKEN = 'mcp-first-test-token-that-is-long-enough';

async function post(service, pathname, body) {
  return fetch(`http://${service.host}:${service.port}${pathname}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('assignment message -> MCP accept -> progress -> finish -> dashboard', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-mcp-first-'));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=UGK Test', '-c', 'user.email=ugk@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { cwd: root });
  const dbPath = path.join(root, 'cockpit.db');
  const observation = await probeGitWorktree(root);
  const db = openCockpitDatabase(dbPath);
  const project = registerProject(db, {
    commandId: 'register-mcp-fixture',
    name: 'MCP fixture',
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
    { clientRequestId: 'create-assignment-1', agent: 'Codex', task: '验证 MCP 闭环' },
  );
  assert.equal(assignmentResponse.status, 201, await assignmentResponse.clone().text());
  const assignment = await assignmentResponse.json();
  const dispatchCode = assignment.message.match(/dispatchCode: "([^"]+)"/)?.[1];
  assert.ok(dispatchCode);
  assert.equal(assignment.message.includes(root), false);
  assert.equal(assignment.message.includes(TOKEN), false);
  const pendingDashboard = await (await fetch(
    `http://${service.host}:${service.port}/api/v1/dashboard`,
    { headers: { authorization: `Bearer ${TOKEN}` } },
  )).json();
  assert.equal(pendingDashboard.projects[0].statusReason, 'assignment_waiting');
  assert.equal(pendingDashboard.projects[0].activeRun, null);

  const acceptResponse = await post(service, '/api/v1/mcp/work/accept', {
    dispatchCode,
    clientRequestId: 'accept-1',
  });
  assert.equal(acceptResponse.status, 200, await acceptResponse.clone().text());
  const accepted = await acceptResponse.json();
  assert.equal(accepted.revision, 1);

  const progressResponse = await post(service, '/api/v1/mcp/work/progress', {
    sessionId: accepted.sessionId,
    clientRequestId: 'progress-1',
    expectedRevision: 1,
    status: 'working',
    note: '协议与状态机已经接通',
  });
  assert.equal(progressResponse.status, 200, await progressResponse.clone().text());
  const progress = await progressResponse.json();
  assert.equal(progress.revision, 2);

  const finishResponse = await post(service, '/api/v1/mcp/work/finish', {
    sessionId: accepted.sessionId,
    clientRequestId: 'finish-1',
    expectedRevision: 2,
    outcome: 'completed',
    summary: 'MCP 闭环通过',
    nextStep: '打开网页体验',
  });
  assert.equal(finishResponse.status, 200, await finishResponse.clone().text());
  const finished = await finishResponse.json();
  assert.equal(finished.cockpitVerified, true);
  assert.equal(finished.revision, 3);

  const dashboardResponse = await fetch(
    `http://${service.host}:${service.port}/api/v1/dashboard`,
    { headers: { authorization: `Bearer ${TOKEN}` } },
  );
  const dashboard = await dashboardResponse.json();
  assert.equal(dashboard.projects[0].activeWork, null);
  assert.equal(dashboard.projects[0].lastWork.summary, 'MCP 闭环通过');
  assert.equal(dashboard.projects[0].lastWork.nextStep, '打开网页体验');

  const verified = openCockpitDatabase(dbPath, { migrate: false });
  const storedHash = verified.prepare('SELECT code_hash FROM dispatch_grants').get().code_hash;
  assert.equal(storedHash.includes(dispatchCode), false);
  assert.equal(verified.prepare('SELECT COUNT(*) AS count FROM progress_events').get().count, 2);
  verified.close();
});
