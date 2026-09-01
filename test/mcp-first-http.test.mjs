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

test('existing Agent initializes the registered project, continues, and hands off', async (t) => {
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
  writeFileSync(path.join(root, 'WIP.md'), 'half-finished work\n');
  const assignmentResponse = await post(
    service,
    `/api/v1/projects/${project.projectId}/assignments`,
    { clientRequestId: 'create-assignment-1', agent: 'Codex', mode: 'init', task: '' },
  );
  assert.equal(assignmentResponse.status, 201, await assignmentResponse.clone().text());
  const assignment = await assignmentResponse.json();
  const initCode = assignment.message.match(/initCode: "([^"]+)"/)?.[1];
  assert.ok(initCode);
  assert.equal(assignment.message.includes(root), false);
  assert.equal(assignment.message.includes(TOKEN), false);
  const pendingDashboard = await (await fetch(
    `http://${service.host}:${service.port}/api/v1/dashboard`,
    { headers: { authorization: `Bearer ${TOKEN}` } },
  )).json();
  assert.equal(pendingDashboard.projects[0].statusReason, 'assignment_waiting');
  assert.equal(pendingDashboard.projects[0].activeRun, null);

  const initResponse = await post(service, '/api/v1/mcp/work/init', {
    initCode,
    clientRequestId: 'init-1',
    currentTask: '验证 MCP init 闭环',
    currentState: '核心功能完成一半，继续开发',
    mcpWorkingDirectory: root,
  });
  assert.equal(initResponse.status, 200, await initResponse.clone().text());
  const initialized = await initResponse.json();
  assert.equal(initialized.status, 'active');
  assert.equal(initialized.revision, 2);
  assert.equal(initialized.preexistingChangesPreserved, true);

  const progressResponse = await post(service, '/api/v1/mcp/work/progress', {
    sessionId: initialized.sessionId,
    clientRequestId: 'progress-1',
    expectedRevision: 2,
    status: 'working',
    note: '协议与状态机已经接通',
  });
  assert.equal(progressResponse.status, 200, await progressResponse.clone().text());
  const progress = await progressResponse.json();
  assert.equal(progress.revision, 3);

  const finishResponse = await post(service, '/api/v1/mcp/work/handoff', {
    sessionId: initialized.sessionId,
    clientRequestId: 'handoff-1',
    expectedRevision: 3,
    outcome: 'completed',
    nextSessionFocus: '等待用户安排下一项开发任务',
    summary: 'MCP 闭环通过',
    currentState: '交接工具、等待态和开始工作工具已经接通',
    completedItems: ['完成标准交接手册生成'],
    pendingItems: ['由用户体验工作台'],
    decisions: ['等待态不获取写入权限'],
    artifactRefs: ['src/core/handoffs.mjs'],
    risks: [],
    suggestedSkills: ['handoff'],
    acknowledgements: [],
  });
  assert.equal(finishResponse.status, 200, await finishResponse.clone().text());
  const finished = await finishResponse.json();
  assert.equal(finished.cockpitVerified, true);
  assert.equal(finished.revision, 4);

  const dashboardResponse = await fetch(
    `http://${service.host}:${service.port}/api/v1/dashboard`,
    { headers: { authorization: `Bearer ${TOKEN}` } },
  );
  const dashboard = await dashboardResponse.json();
  assert.equal(dashboard.projects[0].activeWork, null);
  assert.equal(dashboard.projects[0].lastWork.summary, 'MCP 闭环通过');
  assert.equal(dashboard.projects[0].lastWork.nextStep, '等待用户安排下一项开发任务');
  assert.equal(dashboard.projects[0].lastHandoffManual.summary, 'MCP 闭环通过');

  const standbyResponse = await post(
    service,
    `/api/v1/projects/${project.projectId}/assignments`,
    { clientRequestId: 'create-assignment-2', agent: 'Codex', mode: 'handoff', task: '' },
  );
  assert.equal(standbyResponse.status, 201, await standbyResponse.clone().text());
  const standby = await standbyResponse.json();
  const standbyCode = standby.message.match(/dispatchCode: "([^"]+)"/)?.[1];
  assert.ok(standbyCode);

  const standbyAcceptResponse = await post(service, '/api/v1/mcp/work/accept', {
    dispatchCode: standbyCode,
    clientRequestId: 'accept-2',
  });
  assert.equal(standbyAcceptResponse.status, 200, await standbyAcceptResponse.clone().text());
  const waiting = await standbyAcceptResponse.json();
  assert.equal(waiting.status, 'waiting_for_instruction');
  assert.equal(waiting.revision, 1);
  assert.equal(waiting.latestHandoff.summary, 'MCP 闭环通过');
  assert.match(waiting.latestHandoff.bodyMarkdown, /# Handoff/);

  const waitingDashboard = await (await fetch(
    `http://${service.host}:${service.port}/api/v1/dashboard`,
    { headers: { authorization: `Bearer ${TOKEN}` } },
  )).json();
  assert.equal(waitingDashboard.projects[0].statusReason, 'agent_waiting');
  assert.equal(waitingDashboard.projects[0].activeRun, null);

  const beginResponse = await post(service, '/api/v1/mcp/work/begin', {
    sessionId: waiting.sessionId,
    clientRequestId: 'begin-2',
    expectedRevision: 1,
    task: '按用户的新安排开始开发',
  });
  assert.equal(beginResponse.status, 200, await beginResponse.clone().text());
  const begun = await beginResponse.json();
  assert.equal(begun.status, 'active');
  assert.equal(begun.task, '按用户的新安排开始开发');

  const verified = openCockpitDatabase(dbPath, { migrate: false });
  const storedHash = verified.prepare('SELECT code_hash FROM dispatch_grants').get().code_hash;
  assert.equal(storedHash.includes(initCode), false);
  assert.equal(verified.prepare('SELECT COUNT(*) AS count FROM progress_events').get().count, 3);
  assert.equal(verified.prepare('SELECT COUNT(*) AS count FROM handoffs').get().count, 1);
  verified.close();
});
