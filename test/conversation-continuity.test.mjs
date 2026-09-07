import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { registerProject } from '../src/core/projects.mjs';
import { probeGitWorktree } from '../src/git/probe.mjs';
import { conversationKey } from '../src/mcp/conversation-identity.mjs';
import { createServiceHandlers } from '../src/mcp/service-client.mjs';
import { createMcpServer, dispatchMessage, TOOLS } from '../src/mcp/stdio-protocol.mjs';
import { createCockpitHttpServer } from '../src/service/http-server.mjs';
import { createDiagnosticLogger } from '../src/service/diagnostics.mjs';

const TOKEN = 'conversation-continuity-service-token-'.padEnd(48, 'x');

function fixtureRoot() {
  return mkdtempSync(path.join(os.tmpdir(), 'ugk-conversation-continuity-'));
}

function initGit(root) {
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  writeFileSync(path.join(root, 'README.md'), '# continuity fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', [
    '-c', 'user.name=UGK Test', '-c', 'user.email=ugk@example.invalid',
    'commit', '--quiet', '-m', 'fixture',
  ], { cwd: root });
}

async function createRegisteredFixture() {
  const root = fixtureRoot();
  initGit(root);
  const dbPath = path.join(root, 'cockpit.db');
  const db = openCockpitDatabase(dbPath);
  const project = registerProject(db, {
    commandId: 'register-continuity',
    name: 'Continuity',
    authorizedRoot: root,
    observation: await probeGitWorktree(root),
  });
  db.close();
  return { root, dbPath, project };
}

async function jsonFetch(service, pathname, body, token = TOKEN) {
  const response = await fetch(`http://${service.host}:${service.port}${pathname}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

function relayFields() {
  return {
    nextSessionFocus: '在新的 AI 聊天继续工作',
    summary: '连续性回归接力',
    currentState: '代码和工作会话保持 active',
    completedItems: ['验证当前绑定能力'],
    pendingItems: ['继续回归'],
    decisions: ['写入权限只由当前绑定决定'],
    artifactRefs: [],
    risks: [],
    suggestedSkills: ['cockpit-relay'],
  };
}

test('scoped MCP connection handle preserves an anonymous bridge binding across service restart', async () => {
  const fixture = await createRegisteredFixture();
  let service = await createCockpitHttpServer({ dbPath: fixture.dbPath, token: TOKEN });
  try {
    const fetchImpl = (url, options) => fetch(url, {
      ...options,
      headers: { ...options.headers, connection: 'close' },
    });
    const handler = () => createServiceHandlers({
      baseUrl: `http://127.0.0.1:${service.port}`,
      workingDirectory: fixture.root,
      fetchImpl,
    });
    const assignment = await jsonFetch(service, `/api/v1/projects/${fixture.project.projectId}/assignments`, {
      clientRequestId: 'continuity-assignment',
      agent: 'Codex',
      mode: 'init',
      task: 'Preserve bridge identity',
    });
    const initCode = assignment.body.message.match(/initCode: "([^"]+)"/)[1];
    const live = handler();
    const initialized = await live.ugk_work_init({
      initCode,
      clientRequestId: 'continuity-init',
      currentTask: 'Preserve bridge identity',
      currentState: 'Connected',
    });
    assert.equal(initialized.bindingKind, 'connection');
    assert.equal(initialized.bindingPersistence, 'connection_only');
    const restartPort = service.port;
    await service.close();
    service = await createCockpitHttpServer({ dbPath: fixture.dbPath, token: TOKEN, port: restartPort });

    const progressed = await live.ugk_work_progress({
      sessionId: initialized.sessionId,
      clientRequestId: 'continuity-progress',
      expectedRevision: initialized.revision,
      status: 'working',
      summary: 'Restart preserved the connection binding',
    });
    assert.equal(progressed.revision, initialized.revision + 1);
    const newBridge = handler();
    const held = await newBridge.ugk_work_context({});
    assert.equal(held.bindingKind, 'connection');
    assert.equal(held.bindingPersistence, 'connection_only');
    assert.equal(held.bindingReason, 'held_by_another_chat');
    assert.equal(held.canContinue, false);
    assert.equal(held.capabilities.writeSession, false);
    assert.equal(held.capabilities.prepareRelay, false);
    const logPath = path.join(path.dirname(fixture.dbPath), 'logs', 'mcp-diagnostics.log');
    assert.equal(existsSync(logPath), true);
    const log = readFileSync(logPath, 'utf8');
    assert.match(log, /"operation":"mcp\.init"/);
    assert.match(log, /"operation":"mcp\.progress"/);
    assert.doesNotMatch(log, /connectionHandle|conversation-continuity-service-token|mcpWorkingDirectory/);
    assert.doesNotMatch(log, new RegExp(fixture.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const diagnosticsResponse = await fetch(
      `http://${service.host}:${service.port}/api/v1/projects/${fixture.project.projectId}/session-diagnostics?limit=10`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    const diagnostics = await diagnosticsResponse.json();
    assert.equal(diagnosticsResponse.status, 200);
    assert.ok(diagnostics.entries.some((entry) => entry.sessionId === initialized.sessionId));
    assert.ok(diagnostics.entries.every((entry) => (
      !JSON.stringify(entry).includes('connectionHandle')
      && !JSON.stringify(entry).includes(fixture.root)
    )));
  } finally {
    await service?.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a changed service-token signing key explicitly rejects an old connection handle', async () => {
  const fixture = fixtureRoot();
  const dbPath = path.join(fixture, 'cockpit.db');
  const oldToken = 'old-continuity-service-token-'.padEnd(48, 'a');
  const newToken = 'new-continuity-service-token-'.padEnd(48, 'b');
  let service = await createCockpitHttpServer({ dbPath, token: oldToken });
  try {
    const first = await jsonFetch(service, '/api/v1/mcp/session', { client: 'ugk-cockpit-stdio' }, oldToken);
    assert.equal(first.response.status, 201);
    assert.match(first.body.connectionHandle, /^v1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
    const restartPort = service.port;
    await service.close();
    service = await createCockpitHttpServer({ dbPath, token: newToken, port: restartPort });
    const rejected = await jsonFetch(service, '/api/v1/mcp/session', {
      client: 'ugk-cockpit-stdio',
      connectionHandle: first.body.connectionHandle,
    }, newToken);
    assert.equal(rejected.response.status, 401);
    assert.equal(rejected.body.code, 'MCP_CONNECTION_HANDLE_INVALID');
    assert.equal(rejected.body.reason, 'connection_handle_rejected');
  } finally {
    await service?.close();
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('a legacy scoped client without handle negotiation keeps its token-level binding', async () => {
  const fixture = await createRegisteredFixture();
  let service = await createCockpitHttpServer({ dbPath: fixture.dbPath, token: TOKEN });
  try {
    const session = await jsonFetch(service, '/api/v1/mcp/session', { client: 'ugk-cockpit-stdio' });
    const assignment = await jsonFetch(service, `/api/v1/projects/${fixture.project.projectId}/assignments`, {
      clientRequestId: 'legacy-client-assignment',
      agent: 'Codex',
      mode: 'init',
      task: 'Preserve legacy token binding',
    });
    const initCode = assignment.body.message.match(/initCode: "([^"]+)"/)[1];
    const initializedResponse = await fetch(
      `http://${service.host}:${service.port}/api/v1/mcp/work/init`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.body.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          initCode,
          clientRequestId: 'legacy-client-init',
          currentTask: 'Preserve legacy token binding',
          currentState: 'Connected',
          mcpWorkingDirectory: fixture.root,
        }),
      },
    );
    const initialized = await initializedResponse.json();
    assert.equal(initializedResponse.status, 200);
    assert.equal(initialized.bindingKind, 'connection');
    await service.close();
    service = null;

    const db = openCockpitDatabase(fixture.dbPath);
    try {
      const principalHash = createHash('sha256')
        .update(`mcp:${session.body.token}`)
        .digest('hex');
      const legacyKey = conversationKey({ host: 'ugk-mcp-connection', id: principalHash });
      const binding = db.prepare(`
        SELECT binding_kind FROM conversation_bindings WHERE conversation_key = ?
      `).get(legacyKey);
      assert.equal(binding.binding_kind, 'connection');
    } finally {
      db.close();
    }
  } finally {
    await service?.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('resume receipts keep current capabilities after progress and lose them after takeover', async () => {
  const fixture = await createRegisteredFixture();
  let service = await createCockpitHttpServer({ dbPath: fixture.dbPath, token: TOKEN });
  const handlers = (id) => createServiceHandlers({
    token: TOKEN,
    baseUrl: 'http://127.0.0.1:' + service.port,
    workingDirectory: fixture.root,
    conversationIdentity: { host: 'codex', id },
  });
  try {
    const assignment = await jsonFetch(
      service,
      '/api/v1/projects/' + fixture.project.projectId + '/assignments',
      {
        clientRequestId: 'resume-replay-assignment',
        agent: 'Codex',
        mode: 'init',
        task: '验证 resume 回执当前权限',
      },
    );
    const initCode = assignment.body.message.match(/initCode: "([^"]+)"/)[1];
    const seed = handlers('seed-chat');
    const initialized = await seed.ugk_work_init({
      initCode,
      clientRequestId: 'resume-replay-init',
      currentTask: '验证 resume 回执当前权限',
      currentState: 'seed 正在工作',
    });
    const prepared = await seed.ugk_work_relay({
      sessionId: initialized.sessionId,
      expectedRevision: initialized.revision,
      clientRequestId: 'resume-replay-relay',
      ...relayFields(),
    });
    const original = handlers('chat-a');
    const resumeRequest = {
      continueCode: prepared.continueCode,
      clientRequestId: 'resume-replay-success',
    };
    const resumed = await original.ugk_work_resume(resumeRequest);
    const progressed = await original.ugk_work_progress({
      sessionId: resumed.sessionId,
      expectedRevision: resumed.revision,
      clientRequestId: 'resume-replay-progress',
      status: 'working',
      summary: '原聊天继续后推进 revision',
    });
    const sameOwnerReplay = await original.ugk_work_resume(resumeRequest);
    assert.equal(sameOwnerReplay.revision, resumed.revision);
    assert.equal(sameOwnerReplay.capabilities.writeSession, true);
    assert.equal(sameOwnerReplay.capabilities.prepareRelay, true);

    const replacement = handlers('chat-b');
    const held = await replacement.ugk_work_context({});
    const offer = await replacement.ugk_work_takeover({
      sessionId: held.sessionId,
      expectedRevision: progressed.revision,
      clientRequestId: 'resume-replay-takeover-offer',
    });
    const takeover = await replacement.ugk_work_takeover({
      sessionId: held.sessionId,
      expectedRevision: progressed.revision,
      clientRequestId: 'resume-replay-takeover-confirm',
      confirmationRequestId: offer.confirmationRequestId,
    });
    const revokedReplay = await original.ugk_work_resume(resumeRequest);
    assert.equal(revokedReplay.status, 'active');
    assert.equal(revokedReplay.capabilities.continueSession, false);
    assert.equal(revokedReplay.capabilities.writeSession, false);
    assert.equal(revokedReplay.capabilities.prepareRelay, false);
    await assert.rejects(original.ugk_work_progress({
      sessionId: takeover.sessionId,
      expectedRevision: takeover.revision,
      clientRequestId: 'resume-replay-old-progress',
      status: 'working',
      summary: '旧聊天尝试写入',
    }), (error) => {
      assert.equal(error.code, 'CONVERSATION_BINDING_CONFLICT');
      assert.equal(error.sessionId, takeover.sessionId);
      assert.equal(error.revision, takeover.revision);
      assert.equal(error.bindingReason, 'replaced');
      return true;
    });
  } finally {
    await service?.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('takeover receipts do not regain write capability after replacement or finish', async () => {
  const fixture = await createRegisteredFixture();
  let service = await createCockpitHttpServer({ dbPath: fixture.dbPath, token: TOKEN });
  const handlers = (id) => createServiceHandlers({
    token: TOKEN,
    baseUrl: 'http://127.0.0.1:' + service.port,
    workingDirectory: fixture.root,
    conversationIdentity: { host: 'codex', id },
  });
  try {
    const assignment = await jsonFetch(
      service,
      '/api/v1/projects/' + fixture.project.projectId + '/assignments',
      {
        clientRequestId: 'takeover-replay-assignment',
        agent: 'Codex',
        mode: 'init',
        task: '验证 takeover 回执当前权限',
      },
    );
    const initCode = assignment.body.message.match(/initCode: "([^"]+)"/)[1];
    const seed = handlers('seed-takeover-chat');
    const initialized = await seed.ugk_work_init({
      initCode,
      clientRequestId: 'takeover-replay-init',
      currentTask: '验证 takeover 回执当前权限',
      currentState: 'seed 正在工作',
    });
    const original = handlers('chat-a');
    const held = await original.ugk_work_context({});
    const offer = await original.ugk_work_takeover({
      sessionId: held.sessionId,
      expectedRevision: held.revision,
      clientRequestId: 'takeover-replay-a-offer',
    });
    const takeoverRequest = {
      sessionId: held.sessionId,
      expectedRevision: held.revision,
      clientRequestId: 'takeover-replay-a-confirm',
      confirmationRequestId: offer.confirmationRequestId,
    };
    const accepted = await original.ugk_work_takeover(takeoverRequest);
    const progressed = await original.ugk_work_progress({
      sessionId: accepted.sessionId,
      expectedRevision: accepted.revision,
      clientRequestId: 'takeover-replay-a-progress',
      status: 'working',
      summary: 'A 继续推进后再重放旧回执',
    });
    const sameOwnerReplay = await original.ugk_work_takeover(takeoverRequest);
    assert.equal(sameOwnerReplay.revision, accepted.revision);
    assert.equal(sameOwnerReplay.capabilities.writeSession, true);
    assert.equal(sameOwnerReplay.capabilities.prepareRelay, true);

    const replacement = handlers('chat-b');
    const replacementContext = await replacement.ugk_work_context({});
    const replacementOffer = await replacement.ugk_work_takeover({
      sessionId: replacementContext.sessionId,
      expectedRevision: progressed.revision,
      clientRequestId: 'takeover-replay-b-offer',
    });
    const replacementRequest = {
      sessionId: replacementContext.sessionId,
      expectedRevision: progressed.revision,
      clientRequestId: 'takeover-replay-b-confirm',
      confirmationRequestId: replacementOffer.confirmationRequestId,
    };
    const replacementAccepted = await replacement.ugk_work_takeover(replacementRequest);
    const revokedReplay = await original.ugk_work_takeover(takeoverRequest);
    assert.equal(revokedReplay.capabilities.continueSession, false);
    assert.equal(revokedReplay.capabilities.writeSession, false);
    assert.equal(revokedReplay.capabilities.prepareRelay, false);

    const finished = await replacement.ugk_work_finish({
      sessionId: replacementAccepted.sessionId,
      expectedRevision: replacementAccepted.revision,
      clientRequestId: 'takeover-replay-finish',
      outcome: 'completed',
      summary: '验证完成后的当前权限',
      nextStep: '等待用户安排',
      acknowledgements: [],
    });
    assert.equal(finished.cockpitVerified, true);
    const finishedReplay = await replacement.ugk_work_takeover(replacementRequest);
    assert.equal(finishedReplay.status, 'active');
    assert.equal(finishedReplay.capabilities.writeSession, false);
    assert.equal(finishedReplay.capabilities.prepareRelay, false);
  } finally {
    await service?.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('old-holder MCP errors retain safe context and project diagnostics stay isolated', async () => {
  const fixture = await createRegisteredFixture();
  const otherRoot = fixtureRoot();
  initGit(otherRoot);
  const registrationDb = openCockpitDatabase(fixture.dbPath);
  const otherProject = registerProject(registrationDb, {
    commandId: 'register-continuity-diagnostics-other',
    name: 'Other continuity project',
    authorizedRoot: otherRoot,
    observation: await probeGitWorktree(otherRoot),
  });
  registrationDb.close();

  let service = await createCockpitHttpServer({ dbPath: fixture.dbPath, token: TOKEN });
  const handlers = (root, id) => createServiceHandlers({
    token: TOKEN,
    baseUrl: 'http://127.0.0.1:' + service.port,
    workingDirectory: root,
    conversationIdentity: { host: 'codex', id },
  });
  try {
    const assignment = await jsonFetch(
      service,
      '/api/v1/projects/' + fixture.project.projectId + '/assignments',
      {
        clientRequestId: 'diagnostics-old-holder-assignment',
        agent: 'Codex',
        mode: 'init',
        task: '验证旧持有人错误诊断',
      },
    );
    const initCode = assignment.body.message.match(/initCode: "([^"]+)"/)[1];
    const original = handlers(fixture.root, 'chat-a');
    const initialized = await original.ugk_work_init({
      initCode,
      clientRequestId: 'diagnostics-old-holder-init',
      currentTask: '验证旧持有人错误诊断',
      currentState: 'A 正在工作',
    });
    const replacement = handlers(fixture.root, 'chat-b');
    const held = await replacement.ugk_work_context({});
    const offer = await replacement.ugk_work_takeover({
      sessionId: held.sessionId,
      expectedRevision: held.revision,
      clientRequestId: 'diagnostics-takeover-offer',
    });
    const accepted = await replacement.ugk_work_takeover({
      sessionId: held.sessionId,
      expectedRevision: held.revision,
      clientRequestId: 'diagnostics-takeover-confirm',
      confirmationRequestId: offer.confirmationRequestId,
    });

    const otherAssignment = await jsonFetch(
      service,
      '/api/v1/projects/' + otherProject.projectId + '/assignments',
      {
        clientRequestId: 'diagnostics-other-assignment',
        agent: 'Codex',
        mode: 'init',
        task: '另一项目的诊断记录',
      },
    );
    const otherInitCode = otherAssignment.body.message.match(/initCode: "([^"]+)"/)[1];
    const other = handlers(otherRoot, 'other-project-chat');
    const otherInitialized = await other.ugk_work_init({
      initCode: otherInitCode,
      clientRequestId: 'diagnostics-other-init',
      currentTask: '另一项目的诊断记录',
      currentState: '另一项目正常工作',
    });
    assert.notEqual(otherInitialized.sessionId, initialized.sessionId);

    const rpcResponse = await dispatchMessage({
      jsonrpc: '2.0',
      id: 41,
      method: 'tools/call',
      params: {
        name: 'ugk_work_progress',
        arguments: {
          sessionId: accepted.sessionId,
          clientRequestId: 'diagnostics-old-holder-progress',
          expectedRevision: accepted.revision,
          status: 'working',
          summary: '旧聊天尝试写入',
        },
        _meta: { 'io.ugk.cockpit/conversation': { host: 'codex', id: 'chat-a' } },
      },
    }, {
      handlers: { ugk_work_progress: original.ugk_work_progress },
    });
    assert.equal(rpcResponse.result.isError, true);
    const errorPayload = JSON.parse(rpcResponse.result.content[0].text);
    assert.equal(errorPayload.code, 'CONVERSATION_BINDING_CONFLICT');
    assert.equal(errorPayload.sessionId, accepted.sessionId);
    assert.equal(errorPayload.revision, accepted.revision);
    assert.equal(errorPayload.bindingReason, 'replaced');
    assert.equal(errorPayload.reason, 'replaced');
    assert.match(errorPayload.diagnosticId, /^diag_[A-Za-z0-9_-]{16,64}$/);
    assert.doesNotMatch(rpcResponse.result.content[0].text, /Conversation binding is missing or stale/);

    const projectDiagnosticsResponse = await fetch(
      'http://' + service.host + ':' + service.port
        + '/api/v1/projects/' + fixture.project.projectId + '/session-diagnostics?limit=100',
      { headers: { authorization: 'Bearer ' + TOKEN } },
    );
    const projectDiagnostics = await projectDiagnosticsResponse.json();
    assert.equal(projectDiagnosticsResponse.status, 200);
    assert.ok(projectDiagnostics.entries.some((entry) => (
      entry.sessionId === accepted.sessionId
      && entry.diagnosticId === errorPayload.diagnosticId
      && entry.bindingReason === 'replaced'
      && entry.result === 'rejected'
    )));

    const otherDiagnosticsResponse = await fetch(
      'http://' + service.host + ':' + service.port
        + '/api/v1/projects/' + otherProject.projectId + '/session-diagnostics?limit=100',
      { headers: { authorization: 'Bearer ' + TOKEN } },
    );
    const otherDiagnostics = await otherDiagnosticsResponse.json();
    assert.equal(otherDiagnosticsResponse.status, 200);
    assert.ok(otherDiagnostics.entries.some((entry) => entry.sessionId === otherInitialized.sessionId));
    assert.ok(otherDiagnostics.entries.every((entry) => (
      entry.sessionId !== accepted.sessionId
      && entry.diagnosticId !== errorPayload.diagnosticId
    )));
  } finally {
    await service?.close();
    rmSync(otherRoot, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('concurrent scoped bootstrap is single-flight and metadata absence does not reuse configured identity', async () => {
  const sessions = [];
  const calls = [];
  const configuredIdentity = { host: 'codex', id: 'configured-chat' };
  const handlers = createServiceHandlers({
    token: null,
    conversationIdentity: configuredIdentity,
    workingDirectory: 'E:\\fixture\\continuity',
    fetchImpl: async (url, options) => {
      calls.push({ pathname: url.pathname, options });
      if (url.pathname === '/api/v1/mcp/session') {
        sessions.push(JSON.parse(options.body));
        await new Promise((resolve) => setTimeout(resolve, 20));
        return Response.json({
          ok: true,
          token: 'scoped-continuity-token-'.padEnd(40, 't'),
          connectionHandle: 'v1.' + 'n'.repeat(43) + '.' + 's'.repeat(43),
        }, { status: 201 });
      }
      return Response.json({ ok: true, status: 'active', revision: 1 });
    },
  });

  await Promise.all([
    handlers.ugk_work_progress({}),
    handlers.ugk_work_progress({}),
  ]);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].connectionHandle, undefined);
  const protocol = createMcpServer({ handlers });
  const request = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'ugk_work_context', arguments: {}, _meta: {} },
  };
  await protocol.dispatchMessage(request);
  protocol.close();
  const contextCall = calls.at(-1);
  assert.equal(contextCall.options.headers['x-ugk-conversation'], undefined);
  assert.ok(TOOLS.every((tool) => !JSON.stringify(tool).includes('connectionHandle')));

  await handlers.ugk_work_context({});
  const directCall = calls.at(-1);
  assert.equal(
    JSON.parse(Buffer.from(directCall.options.headers['x-ugk-conversation'], 'base64url').toString('utf8')).id,
    configuredIdentity.id,
  );
});

test('stdio preserves the safe diagnostic contract for ordinary service failures', async () => {
  const response = await dispatchMessage({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: {
      name: 'ugk_work_progress',
      arguments: {
        sessionId: 'session-diagnostic',
        clientRequestId: 'diagnostic-request',
        expectedRevision: 1,
        status: 'working',
        summary: 'diagnostic failure',
      },
    },
  }, {
    handlers: {
      ugk_work_progress: async () => {
        throw Object.assign(new Error('private backend exception'), {
          code: 'CONVERSATION_BINDING_CONFLICT',
          publicMessage: '当前聊天没有有效工作会话绑定。',
          impact: '代码和已有记录没有被修改。',
          required_action: '请先查询当前工作会话。',
          reason: 'held_by_another_chat',
          diagnosticId: 'diag_1234567890abcdef',
        });
      },
    },
  });

  assert.equal(response.result.isError, true);
  const payload = JSON.parse(response.result.content[0].text);
  assert.equal(payload.code, 'CONVERSATION_BINDING_CONFLICT');
  assert.equal(payload.reason, 'held_by_another_chat');
  assert.equal(payload.diagnosticId, 'diag_1234567890abcdef');
  assert.equal(payload.impact, '代码和已有记录没有被修改。');
  assert.equal(payload.required_action, '请先查询当前工作会话。');
  assert.doesNotMatch(response.result.content[0].text, /private backend exception/);
});

test('diagnostic log rotation is bounded and logging failure does not affect the response path', () => {
  const fixture = fixtureRoot();
  try {
    const logger = createDiagnosticLogger({ directory: fixture });
    for (let index = 0; index < 4000; index += 1) {
      logger.record({
        operation: 'mcp.progress',
        diagnosticId: `diag_${String(index).padStart(16, '0')}`,
        result: 'success',
        sessionId: 'session-1',
        revision: index,
        identitySource: 'connection_handle',
        identityRecognized: true,
      });
    }
    const logNames = ['mcp-diagnostics.log', 'mcp-diagnostics.log.1', 'mcp-diagnostics.log.2', 'mcp-diagnostics.log.3'];
    const present = logNames.filter((name) => existsSync(path.join(fixture, name)));
    assert.ok(present.length >= 2);
    assert.ok(present.length <= 4);
    assert.ok(present.every((name) => statSync(path.join(fixture, name)).size <= 256 * 1024 + 1024));

    const blockedDirectory = path.join(fixture, 'not-a-directory');
    writeFileSync(blockedDirectory, 'occupied');
    const blockedLogger = createDiagnosticLogger({ directory: blockedDirectory });
    assert.doesNotThrow(() => blockedLogger.record({ operation: 'mcp.progress', result: 'success' }));
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
