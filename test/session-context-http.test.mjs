import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { registerProject } from '../src/core/projects.mjs';
import { probeGitWorktree } from '../src/git/probe.mjs';
import { createServiceHandlers } from '../src/mcp/service-client.mjs';
import { createCockpitHttpServer } from '../src/service/http-server.mjs';

const TOKEN = 'session-context-http-test-token-that-is-long-enough';

async function post(service, pathname, body) {
  return fetch(`http://${service.host}:${service.port}${pathname}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function relayFields() {
  return {
    nextSessionFocus: '继续验证上下文恢复',
    summary: '已验证只读查询',
    currentState: '当前会话仍 active',
    completedItems: ['新增 context 查询'],
    pendingItems: ['由下一聊天继续'],
    decisions: ['查询不改变平台状态'],
    artifactRefs: ['src/service/http-server.mjs'],
    risks: [],
    suggestedSkills: ['cockpit-relay'],
  };
}

test('MCP work context recovers latest revision without changing platform state and fences relay generations', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-session-context-'));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  writeFileSync(path.join(root, 'README.md'), '# context fixture\n');
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
    commandId: 'register-session-context-fixture',
    name: 'Session context fixture',
    authorizedRoot: root,
    observation,
  });
  db.close();

  const service = await createCockpitHttpServer({ dbPath, token: TOKEN });
  t.after(async () => {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  });

  const assignmentResponse = await post(service, `/api/v1/projects/${project.projectId}/assignments`, {
    clientRequestId: 'session-context-assignment',
    agent: 'Codex',
    mode: 'init',
    task: '验证 session context',
  });
  assert.equal(assignmentResponse.status, 201, await assignmentResponse.clone().text());
  const assignment = await assignmentResponse.json();
  const initCode = assignment.message.match(/initCode: "([^\"]+)"/)?.[1];
  assert.ok(initCode);

  const bridgeBaseUrl = `http://${service.host}:${service.port}`;
  const oldBridge = createServiceHandlers({
    token: TOKEN,
    baseUrl: bridgeBaseUrl,
    workingDirectory: root,
  });
  const newBridge = createServiceHandlers({
    token: TOKEN,
    baseUrl: bridgeBaseUrl,
    workingDirectory: root,
  });
  const initialized = await oldBridge.ugk_work_init({
    initCode,
    clientRequestId: 'session-context-init',
    currentTask: '验证 session context',
    currentState: '已接入',
  });
  assert.equal(initialized.ok, true);
  assert.equal(typeof initialized.worktreeId, 'string');

  const state = openCockpitDatabase(dbPath, { migrate: false });
  const snapshot = () => ({
    session: state.prepare(`
      SELECT runs.revision AS run_revision,
             runs.last_heartbeat_at AS run_heartbeat,
             assignments.revision AS assignment_revision,
             assignments.last_heartbeat_at AS assignment_heartbeat
      FROM runs
      JOIN assignments ON assignments.session_id = runs.id
      WHERE runs.id = ?
    `).get(initialized.sessionId),
    leases: state.prepare('SELECT * FROM write_leases ORDER BY worktree_id').all(),
    commandCount: state.prepare('SELECT count(*) AS count FROM commands').get().count,
    progressCount: state.prepare('SELECT count(*) AS count FROM progress_events').get().count,
  });

  const beforeContext = snapshot();
  const rememberedContext = await oldBridge.ugk_work_context({});
  assert.equal(rememberedContext.status, 'active');
  assert.equal(rememberedContext.bindingStatus, 'bound');
  assert.equal(rememberedContext.canContinue, true);
  assert.equal(rememberedContext.sessionId, initialized.sessionId);
  assert.equal(rememberedContext.revision, initialized.revision);
  assert.deepEqual(snapshot(), beforeContext);

  const unboundResponse = await post(service, '/api/v1/mcp/work/context', {
    mcpWorkingDirectory: root,
  });
  assert.equal(unboundResponse.status, 200, await unboundResponse.clone().text());
  const unbound = await unboundResponse.json();
  assert.equal(unbound.ok, true);
  assert.equal(unbound.status, 'active');
  assert.equal(unbound.canContinue, false);
  assert.equal(unbound.requiresUserConfirmation, true);
  assert.equal(unbound.bindingStatus, 'unbound');
  assert.equal(unbound.sessionId, initialized.sessionId);
  assert.equal(unbound.revision, initialized.revision);
  assert.equal(unbound.candidates[0].projectName, 'Session context fixture');
  assert.equal(unbound.candidates[0].agent, 'Codex');
  assert.equal(unbound.candidates[0].task, '验证 session context');
  assert.equal(unbound.impact.includes('没有修改'), true);
  assert.equal(typeof unbound.required_action, 'string');
  assert.equal(unbound.next_command, null);
  assert.deepEqual(unbound.warnings, []);
  assert.deepEqual(snapshot(), beforeContext);

  const confirmationBridge = createServiceHandlers({
    token: TOKEN,
    baseUrl: bridgeBaseUrl,
    workingDirectory: root,
  });
  const confirmed = await confirmationBridge.ugk_work_context({
    confirmSessionId: unbound.sessionId,
    expectedRevision: unbound.revision,
  });
  assert.equal(confirmed.canContinue, true);
  assert.equal(confirmed.bindingEstablished, true);
  assert.equal(confirmed.bindingStatus, 'bound');
  assert.equal(confirmed.binding.relayId, null);
  const rememberedConfirmation = await confirmationBridge.ugk_work_context({});
  assert.equal(rememberedConfirmation.canContinue, true);
  assert.equal(rememberedConfirmation.requiresUserConfirmation, false);
  assert.equal(rememberedConfirmation.sessionId, initialized.sessionId);
  assert.deepEqual(snapshot(), beforeContext);

  const progressResponse = await post(service, '/api/v1/mcp/work/progress', {
    sessionId: initialized.sessionId,
    clientRequestId: 'session-context-progress',
    expectedRevision: initialized.revision,
    status: 'working',
    summary: '更新 context 回归检查点',
  });
  assert.equal(progressResponse.status, 200, await progressResponse.clone().text());
  const progressed = await progressResponse.json();
  assert.equal(progressed.revision, initialized.revision + 1);
  const afterProgress = snapshot();

  const bound = await oldBridge.ugk_work_context({});
  assert.equal(bound.canContinue, true);
  assert.equal(bound.bindingStatus, 'bound');
  assert.equal(bound.sessionId, initialized.sessionId);
  assert.equal(bound.revision, progressed.revision);
  assert.deepEqual(snapshot(), afterProgress);

  const prepared = await oldBridge.ugk_work_relay({
    sessionId: initialized.sessionId,
    clientRequestId: 'session-context-relay',
    expectedRevision: progressed.revision,
    ...relayFields(),
  });

  const waiting = await oldBridge.ugk_work_context({});
  assert.equal(waiting.status, 'awaiting_resume');
  assert.equal(waiting.canContinue, false);
  assert.equal(waiting.requiresUserConfirmation, false);

  const resumed = await newBridge.ugk_work_resume({
    continueCode: prepared.continueCode,
    clientRequestId: 'session-context-resume',
  });

  const stale = await oldBridge.ugk_work_context({});
  assert.equal(stale.status, 'active');
  assert.equal(stale.bindingStatus, 'stale');
  assert.equal(stale.canContinue, false);
  assert.equal(stale.requiresUserConfirmation, false);

  const current = await newBridge.ugk_work_context({});
  assert.equal(current.status, 'active');
  assert.equal(current.bindingStatus, 'bound');
  assert.equal(current.canContinue, true);
  assert.equal(current.revision, resumed.revision);

  state.close();
});

test('context confirmation rejects a stale revision without binding or DB writes', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-session-context-stale-'));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  writeFileSync(path.join(root, 'README.md'), '# stale context fixture\n');
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
    commandId: 'register-session-context-stale-fixture',
    name: 'Stale context fixture',
    authorizedRoot: root,
    observation,
  });
  db.close();
  const service = await createCockpitHttpServer({ dbPath, token: TOKEN });
  t.after(async () => {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  });

  const assignmentResponse = await post(service, `/api/v1/projects/${project.projectId}/assignments`, {
    clientRequestId: 'stale-context-assignment', agent: 'Codex', mode: 'init', task: '确认 revision 变化',
  });
  const assignment = await assignmentResponse.json();
  const initCode = assignment.message.match(/initCode: "([^\"]+)"/)?.[1];
  const initResponse = await post(service, '/api/v1/mcp/work/init', {
    initCode, clientRequestId: 'stale-context-init', currentTask: '确认 revision 变化',
    currentState: '已接入', mcpWorkingDirectory: root,
  });
  const initialized = await initResponse.json();
  const contextResponse = await post(service, '/api/v1/mcp/work/context', { mcpWorkingDirectory: root });
  const context = await contextResponse.json();
  const before = openCockpitDatabase(dbPath, { migrate: false });
  const beforeCounts = before.prepare(`
    SELECT (SELECT count(*) FROM commands) AS commands,
           (SELECT count(*) FROM write_leases) AS leases,
           (SELECT revision FROM runs WHERE id = ?) AS revision
  `).get(initialized.sessionId);
  before.close();

  const progressResponse = await post(service, '/api/v1/mcp/work/progress', {
    sessionId: initialized.sessionId, clientRequestId: 'stale-context-progress',
    expectedRevision: context.revision, status: 'working', summary: '使确认 revision 过期',
  });
  assert.equal(progressResponse.status, 200, await progressResponse.clone().text());

  const rejected = await post(service, '/api/v1/mcp/work/context', {
    mcpWorkingDirectory: root,
    confirmSessionId: context.sessionId,
    expectedRevision: context.revision,
  });
  assert.equal(rejected.status, 409, await rejected.clone().text());
  const rejectedBody = await rejected.json();
  assert.equal(rejectedBody.code, 'SESSION_CONTEXT_CONFIRMATION_STALE');
  assert.equal(rejectedBody.canContinue, false);
  assert.equal(rejectedBody.requiresUserConfirmation, true);

  const after = openCockpitDatabase(dbPath, { migrate: false });
  const afterCounts = after.prepare(`
    SELECT (SELECT count(*) FROM commands) AS commands,
           (SELECT count(*) FROM write_leases) AS leases,
           (SELECT revision FROM runs WHERE id = ?) AS revision
  `).get(initialized.sessionId);
  after.close();
  assert.equal(afterCounts.commands, beforeCounts.commands + 1); // progress only
  assert.equal(afterCounts.leases, beforeCounts.leases);
  assert.equal(afterCounts.revision, beforeCounts.revision + 1);
});
