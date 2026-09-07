import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { registerProject } from '../src/core/projects.mjs';
import { probeGitWorktree } from '../src/git/probe.mjs';
import { createServiceHandlers } from '../src/mcp/service-client.mjs';
import { createCockpitHttpServer } from '../src/service/http-server.mjs';
import { takeOverConversation } from '../src/core/conversation-takeovers.mjs';
import { conversationKey } from '../src/mcp/conversation-identity.mjs';

const TOKEN = 'conversation-takeover-http-test-token-that-is-long-enough';

// POSIX 的系统临时目录（/tmp、/var）本身是符号链接；产品路径授权按契约拒绝
// 穿越链接的路径，夹具必须建立在真实路径下，否则授权在业务断言前就失败。
function fixtureTempRoot() {
  return process.platform === 'win32' ? os.tmpdir() : realpathSync(os.tmpdir());
}

function relayFields() {
  return {
    nextSessionFocus: '在新的 AI 聊天继续工作',
    summary: '已完成接手恢复验证',
    currentState: '代码和工作会话保持 active',
    completedItems: ['已确认接手记录'],
    pendingItems: ['在下一聊天继续'],
    decisions: ['接手必须由用户确认'],
    artifactRefs: [],
    risks: [],
    suggestedSkills: ['cockpit-relay'],
  };
}

async function authorizeTransfer(fixture, session, clientRequestId, target = {}) {
  const baseUrl = fixture.baseUrl();
  const shell = await fetch(baseUrl + '/');
  const cookie = shell.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const response = await fetch(`${baseUrl}/api/v1/projects/${fixture.projectId}/conversation-control/${session.sessionId}/transfer`, {
    method: 'POST',
    headers: { cookie, origin: baseUrl, 'sec-fetch-site': 'same-origin',
      'x-ugk-client-id': 'conversation-transfer-browser-test', 'content-type': 'application/json' },
    body: JSON.stringify({ clientRequestId, expectedRevision: session.revision, ...target }),
  });
  const result = await response.json();
  assert.ok(response.ok, JSON.stringify(result));
  assert.equal(result.revision, session.revision + 1);
  assert.ok(result.transferCode);
  return result;
}

async function createFixture(t, task = '验证会话接手') {
  const root = mkdtempSync(path.join(fixtureTempRoot(), 'ugk-cockpit-takeover-'));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  writeFileSync(path.join(root, 'README.md'), '# conversation takeover fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', [
    '-c', 'user.name=UGK Test',
    '-c', 'user.email=ugk@example.invalid',
    'commit', '--quiet', '-m', 'fixture',
  ], { cwd: root });
  const dbPath = path.join(root, 'cockpit.db');
  const db = openCockpitDatabase(dbPath);
  const project = registerProject(db, {
    commandId: 'register-conversation-takeover-fixture',
    name: 'Conversation takeover fixture',
    authorizedRoot: root,
    observation: await probeGitWorktree(root),
  });
  db.close();

  let service = await createCockpitHttpServer({ dbPath, token: TOKEN });
  let serviceClosed = false;
  const stopService = async () => {
    if (serviceClosed) return;
    await service.close();
    serviceClosed = true;
  };
  t.after(async () => {
    await stopService();
    rmSync(root, { recursive: true, force: true });
  });

  const assignmentResponse = await fetch(`http://${service.host}:${service.port}/api/v1/projects/${project.projectId}/assignments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'conversation-takeover-assignment',
      agent: 'ZCode',
      mode: 'init',
      task,
    }),
  });
  assert.equal(assignmentResponse.status, 201, await assignmentResponse.clone().text());
  const assignment = await assignmentResponse.json();
  const initCode = assignment.message.match(/initCode: "([^\"]+)"/)?.[1];
  assert.ok(initCode);

  return {
    root,
    dbPath,
    projectId: project.projectId,
    initCode,
    baseUrl: () => `http://${service.host}:${service.port}`,
    restart: async () => {
      const port = service.port;
      await stopService();
      service = await createCockpitHttpServer({ dbPath, token: TOKEN, port });
      serviceClosed = false;
    },
    stop: stopService,
  };
}

test('context identifies the holder and an explicitly confirmed takeover fences the old chat', async (t) => {
  const fixture = await createFixture(t, '实现接力恢复');
  const handlers = (id) => createServiceHandlers({
    token: TOKEN,
    baseUrl: fixture.baseUrl(),
    workingDirectory: fixture.root,
    conversationIdentity: { host: 'zcode', id },
  });
  const original = handlers('chat-a');
  const initialized = await original.ugk_work_init({
    initCode: fixture.initCode,
    clientRequestId: 'takeover-init',
    currentTask: '实现接力恢复',
    currentState: 'A 正在工作',
  });
  const replacement = handlers('chat-b');

  const held = await replacement.ugk_work_context({});
  assert.equal(held.status, 'active');
  assert.equal(held.bindingReason, 'held_by_another_chat');
  assert.equal(held.canContinue, false);
  assert.equal(held.latestNode.type, 'init');
  assert.equal(held.latestNode.summary, 'A 正在工作');
  assert.deepEqual(held.availableActions, ['return_to_owner', 'open_workbench_transfer']);
  assert.deepEqual(held.owner, {
    bindingPersistence: 'durable',
    holderType: 'durable_chat',
    host: 'zcode',
    conversationLocator: 'chat-a',
    task: '实现接力恢复',
    agent: 'ZCode',
    lastActivityAt: held.owner.lastActivityAt,
    boundAt: held.owner.boundAt,
  });

  await assert.rejects(replacement.ugk_work_takeover({
    sessionId: held.sessionId,
    clientRequestId: 'takeover-offer-b',
    expectedRevision: held.revision,
  }), /CONVERSATION_PLATFORM_AUTHORIZATION_REQUIRED/);
  const legacyBypass = await fetch(`${fixture.baseUrl()}/api/v1/mcp/work/takeover`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json',
      'x-ugk-conversation': Buffer.from(JSON.stringify({ host: 'zcode', id: 'chat-b' })).toString('base64url') },
    body: JSON.stringify({ sessionId: held.sessionId, clientRequestId: 'legacy-direct-takeover',
      expectedRevision: held.revision, confirmationRequestId: 'old-confirmation', mcpWorkingDirectory: fixture.root }),
  });
  assert.equal((await legacyBypass.json()).code, 'CONVERSATION_PLATFORM_AUTHORIZATION_REQUIRED');
  const offer = await authorizeTransfer(fixture, held, 'takeover-authorize-b', {
    targetHost: 'zcode', targetConversationId: 'chat-b',
  });
  const frozen = await original.ugk_work_context({});
  assert.equal(frozen.canContinue, false);
  assert.equal(frozen.latestNode.type, 'transfer_authorized');
  assert.equal(frozen.latestNode.summary, '用户在工作台授权转交，等待新的聊天接手。');

  // Platform authorization is target-bound and survives service replacement.
  await fixture.restart();
  await assert.rejects(handlers('chat-c').ugk_work_takeover({
    sessionId: held.sessionId,
    clientRequestId: 'takeover-wrong-chat',
    transferCode: offer.transferCode,
  }), /CONVERSATION_TRANSFER_TARGET_MISMATCH/);

  const accepted = await replacement.ugk_work_takeover({
    sessionId: held.sessionId,
    clientRequestId: 'takeover-confirm-b',
    transferCode: offer.transferCode,
  });
  assert.equal(accepted.takeoverAccepted, true);
  assert.equal(accepted.revision, initialized.revision + 2);
  await assert.rejects(original.ugk_work_progress({
    sessionId: held.sessionId,
    clientRequestId: 'old-chat-progress',
    expectedRevision: accepted.revision,
    status: 'working',
    summary: '旧聊天尝试写入',
  }), /CONVERSATION_BINDING_CONFLICT/);

  const state = openCockpitDatabase(fixture.dbPath, { migrate: false });
  const owner = state.prepare(`SELECT binding_kind, owner_host, owner_locator, revoked
    FROM conversation_bindings WHERE session_id = ? AND revoked = 0`).get(held.sessionId);
  assert.equal(owner.binding_kind, 'host');
  assert.equal(owner.owner_host, 'zcode');
  assert.equal(owner.owner_locator, 'chat-b');
  const audit = state.prepare(`SELECT status, summary, expected_revision, revision
    FROM progress_events WHERE client_request_id = ?`).get(`conversation.transfer.consume.${held.sessionId}.takeover-confirm-b`);
  assert.equal(audit.status, 'working');
  assert.equal(audit.summary, '新的聊天已通过工作台授权接手。');
  assert.equal(audit.expected_revision, offer.revision);
  assert.equal(audit.revision, accepted.revision);
  assert.ok(state.prepare('SELECT request_json, response_json FROM commands').all()
    .every(row => !JSON.stringify(row).includes(offer.transferCode)));
  state.close();

  // The user may choose to make a new C after B has explicitly taken over.
  const prepared = await replacement.ugk_work_relay({
    sessionId: held.sessionId,
    clientRequestId: 'takeover-relay-to-c',
    expectedRevision: accepted.revision,
    ...relayFields(),
  });
  const continued = await handlers('chat-c').ugk_work_resume({
    continueCode: prepared.continueCode,
    clientRequestId: 'takeover-resume-c',
  });
  assert.equal(continued.relayAccepted, true);
  assert.equal((await handlers('chat-c').ugk_work_context({})).canContinue, true);
  const staleReplacement = await replacement.ugk_work_context({});
  assert.equal(staleReplacement.bindingStatus, 'stale');
  assert.equal(staleReplacement.bindingReason, 'replaced');
  assert.equal(staleReplacement.owner.conversationLocator, 'chat-c');
  assert.deepEqual(staleReplacement.availableActions, [
    'return_to_owner', 'open_workbench_transfer',
  ]);
});

test('connection-only MCP bindings survive a service restart as a recoverable held session', async (t) => {
  const fixture = await createFixture(t, '恢复无聊天 ID 的连接');
  const connection = () => createServiceHandlers({
    baseUrl: fixture.baseUrl(),
    workingDirectory: fixture.root,
  });
  const firstConnection = createServiceHandlers({
    baseUrl: fixture.baseUrl(), workingDirectory: fixture.root,
    conversationIdentity: { host: 'fixture', id: 'pre-upgrade-holder' },
  });
  const initialized = await firstConnection.ugk_work_init({
    initCode: fixture.initCode,
    clientRequestId: 'connection-init',
    currentTask: '恢复无聊天 ID 的连接',
    currentState: '此前 MCP 连接正在工作',
  });
  const historicalDb = openCockpitDatabase(fixture.dbPath, { migrate: false });
  // Only this temporary fixture simulates the metadata unavailable in v24.
  historicalDb.prepare(`UPDATE conversation_bindings SET conversation_key = ?, binding_kind = 'connection',
    owner_host = NULL, owner_locator = NULL WHERE session_id = ?`)
    .run(conversationKey({ host: 'ugk-mcp-connection', id: 'historical-principal' }), initialized.sessionId);
  historicalDb.close();

  await fixture.restart();
  const anonymousAfterRestart = connection();
  const held = await anonymousAfterRestart.ugk_work_context({});
  assert.equal(held.bindingReason, 'held_by_another_chat');
  assert.equal(held.owner.bindingPersistence, 'connection_only');
  assert.equal(held.owner.holderType, 'previous_mcp_connection');
  assert.equal(held.owner.host, null);
  assert.equal(held.owner.conversationLocator, null);
  assert.equal(held.owner.task, '恢复无聊天 ID 的连接');
  assert.equal(held.revision, initialized.revision);

  const offer = await authorizeTransfer(fixture, held, 'connection-takeover-authorize');
  await assert.rejects(anonymousAfterRestart.ugk_work_takeover({
    sessionId: held.sessionId, clientRequestId: 'connection-anonymous-consume', transferCode: offer.transferCode,
  }), /CONVERSATION_IDENTITY_REQUIRED/);
  const afterRestart = createServiceHandlers({
    baseUrl: fixture.baseUrl(), workingDirectory: fixture.root,
    conversationIdentity: { host: 'zcode', id: 'recovered-chat' },
  });
  const accepted = await afterRestart.ugk_work_takeover({
    sessionId: held.sessionId,
    clientRequestId: 'connection-takeover-confirm',
    transferCode: offer.transferCode,
  });
  assert.equal(accepted.takeoverAccepted, true);
  assert.equal(accepted.binding.relayId, null);
  assert.equal(accepted.binding.relaySequence, null);
  assert.equal(accepted.binding.acceptedRevision, accepted.revision);
  const recovered = await afterRestart.ugk_work_context({});
  assert.equal(recovered.canContinue, true);
  assert.equal(recovered.sessionId, held.sessionId);
  assert.equal(recovered.revision, accepted.revision);
  for (const invalidGeneration of [
    { relayId: null, relaySequence: null, acceptedRevision: 0 },
    { relayId: null, relaySequence: null, acceptedRevision: '40' },
    { relayId: null, relaySequence: 1, acceptedRevision: accepted.revision },
    { relayId: 'partial-relay', relaySequence: null, acceptedRevision: accepted.revision },
  ]) {
    const response = await fetch(`${fixture.baseUrl()}/api/v1/mcp/work/context`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ mcpWorkingDirectory: fixture.root,
        bridgeBinding: { ...accepted.binding, ...invalidGeneration } }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'INVALID_REQUEST');
  }
  const queriedAgain = await afterRestart.ugk_work_context({});
  assert.equal(queriedAgain.canContinue, true);
  assert.equal(queriedAgain.revision, accepted.revision);
  await assert.rejects(firstConnection.ugk_work_progress({
    sessionId: held.sessionId,
    clientRequestId: 'connection-old-holder-progress',
    expectedRevision: accepted.revision,
    status: 'working',
    summary: '旧连接不得重新取得写入权限',
  }), /CONVERSATION_BINDING_CONFLICT/);
  const progressed = await afterRestart.ugk_work_progress({
    sessionId: held.sessionId,
    clientRequestId: 'connection-takeover-progress',
    expectedRevision: accepted.revision,
    status: 'working',
    summary: '已在重启后的连接继续工作',
  });
  assert.equal(progressed.revision, accepted.revision + 1);
});

for (const identityMode of ['host', 'connection']) {
  test(`${identityMode} ownership after historical relays survives takeover, process replacement, and another relay`, async (t) => {
    const fixture = await createFixture(t);
    const connection = (id) => createServiceHandlers({
      baseUrl: fixture.baseUrl(), workingDirectory: fixture.root,
      conversationIdentity: { host: 'test', id },
      fetchImpl: (url, options) => fetch(url, {
        ...options, headers: { ...options.headers, connection: 'close' },
      }),
    });
    const original = connection('original');
    let holder = original;
    let current = await holder.ugk_work_init({ initCode: fixture.initCode,
      clientRequestId: 'history-init', currentTask: 'Historical relay ownership', currentState: 'active' });
    let lastResume;
    for (let index = 0; index < 6; index++) {
      const prepared = await holder.ugk_work_relay({ sessionId: current.sessionId,
        expectedRevision: current.revision, clientRequestId: `history-relay-${index}`, ...relayFields() });
      holder = connection(`relay-${index}`);
      lastResume = { continueCode: prepared.continueCode, clientRequestId: `history-resume-${index}` };
      current = await holder.ugk_work_resume(lastResume);
    }
    if (identityMode === 'connection') {
      const historicalDb = openCockpitDatabase(fixture.dbPath, { migrate: false });
      for (const row of historicalDb.prepare('SELECT conversation_key FROM conversation_bindings WHERE session_id = ?').all(current.sessionId)) {
        historicalDb.prepare(`UPDATE conversation_bindings SET conversation_key = ?, binding_kind = 'connection',
          owner_host = NULL, owner_locator = NULL WHERE session_id = ? AND conversation_key = ?`)
          .run(conversationKey({ host: 'ugk-mcp-connection', id: row.conversation_key }), current.sessionId, row.conversation_key);
      }
      historicalDb.close();
    }
    const replacement = createServiceHandlers({ baseUrl: fixture.baseUrl(), workingDirectory: fixture.root,
      conversationIdentity: { host: 'test', id: 'takeover' },
      fetchImpl: (url, options) => fetch(url, { ...options, headers: { ...options.headers, connection: 'close' } }),
    });
    const offer = await authorizeTransfer(fixture, current, 'history-authorize');
    const confirmation = { sessionId: current.sessionId,
      clientRequestId: 'history-confirm', transferCode: offer.transferCode };
    const accepted = await replacement.ugk_work_takeover(confirmation);
    assert.equal(accepted.takeoverAccepted, true);
    assert.equal(accepted.binding.relayId, null);
    assert.equal(accepted.capabilities.writeSession, true);

    // Historical relay rows must remain untouched by recovery after transfer.
    const snapshot = () => {
      const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
      try {
        return JSON.stringify(['projects', 'runs', 'assignments', 'relays', 'commands',
          'progress_events', 'conversation_bindings'].map((table) =>
          db.prepare(`SELECT * FROM ${table}`).all()));
      } finally { db.close(); }
    };
    const before = snapshot();
    const context = await replacement.ugk_work_context({});
    assert.equal(context.canContinue, true);
    assert.equal(context.capabilities.writeSession, true);
    assert.equal(context.revision, accepted.revision);
    assert.deepEqual(context.binding, accepted.binding);
    assert.equal(snapshot(), before);

    const port = Number(new URL(fixture.baseUrl()).port);
    await fixture.stop();
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { createCockpitHttpServer } from './src/service/http-server.mjs';
      const service = await createCockpitHttpServer(JSON.parse(process.argv[1]));
      process.stdout.write('ready\\n');
    `, JSON.stringify({ dbPath: fixture.dbPath, token: TOKEN, port })],
    { cwd: path.resolve(import.meta.dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Replacement service startup timeout')), 10000);
        child.once('error', (error) => { clearTimeout(timeout); reject(error); });
        child.once('exit', () => { clearTimeout(timeout); reject(new Error('Replacement service exited')); });
        child.stdout.once('data', () => { clearTimeout(timeout); resolve(); });
      });
      const restarted = await replacement.ugk_work_context({});
      assert.equal(restarted.canContinue, true);
      assert.equal(restarted.revision, accepted.revision);
      assert.equal(snapshot(), before);
      const progressed = await replacement.ugk_work_progress({ sessionId: accepted.sessionId,
        expectedRevision: restarted.revision, clientRequestId: 'history-progress',
        status: 'working', summary: 'Current owner survives historical relays' });
      const receipt = await replacement.ugk_work_takeover(confirmation);
      assert.equal(receipt.revision, accepted.revision);
      assert.equal(receipt.capabilities.writeSession, true);
      const staleReceipt = await holder.ugk_work_resume(lastResume);
      assert.equal(staleReceipt.capabilities.writeSession, false);
      for (const old of [original, holder]) {
        assert.equal((await old.ugk_work_context({})).canContinue, false);
        await assert.rejects(old.ugk_work_progress({ sessionId: accepted.sessionId,
          expectedRevision: progressed.revision, clientRequestId: 'history-old-progress',
          status: 'working', summary: 'Must reject revoked holder' }), /CONVERSATION_BINDING_CONFLICT/);
      }
      const prepared = await replacement.ugk_work_relay({ sessionId: accepted.sessionId,
        expectedRevision: progressed.revision, clientRequestId: 'history-next-relay', ...relayFields() });
      assert.equal((await replacement.ugk_work_context({})).capabilities.writeSession, false);
      const next = connection('next');
      const resumed = await next.ugk_work_resume({ continueCode: prepared.continueCode,
        clientRequestId: 'history-next-resume' });
      assert.equal((await next.ugk_work_context({})).canContinue, true);
      assert.equal((await replacement.ugk_work_takeover(confirmation)).capabilities.writeSession, false);
      await assert.rejects(replacement.ugk_work_progress({ sessionId: accepted.sessionId,
        expectedRevision: resumed.revision, clientRequestId: 'history-revoked-progress',
        status: 'working', summary: 'Must reject replaced takeover holder' }), /CONVERSATION_BINDING_CONFLICT/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
    }
  });
}

test('legacy core takeover: process kill before commit leaves historical holder intact and confirmation retryable', async (t) => {
  const fixture = await createFixture(t, '验证接手进程中断');
  const original = createServiceHandlers({
    token: TOKEN,
    baseUrl: fixture.baseUrl(),
    workingDirectory: fixture.root,
    conversationIdentity: { host: 'zcode', id: 'chat-a' },
  });
  const initialized = await original.ugk_work_init({
    initCode: fixture.initCode,
    clientRequestId: 'takeover-kill-init',
    currentTask: '验证接手进程中断',
    currentState: 'A 正在工作',
  });
  await fixture.stop();

  const binding = {
    key: conversationKey({ host: 'zcode', id: 'chat-b' }),
    bindingKind: 'host', host: 'zcode', locator: 'chat-b',
  };
  const request = {
    sessionId: initialized.sessionId,
    expectedRevision: initialized.revision,
    conversationKey: binding.key,
    binding,
  };
  let db = openCockpitDatabase(fixture.dbPath);
  const offer = takeOverConversation(db, { ...request, clientRequestId: 'takeover-kill-offer' });
  assert.equal(offer.status, 'confirmation_required');
  db.close();

  const confirmation = {
    ...request,
    clientRequestId: 'takeover-kill-confirm',
    confirmationRequestId: offer.confirmationRequestId,
  };
  const child = `
    import { openCockpitDatabase } from ${JSON.stringify(new URL('../src/core/database.mjs', import.meta.url).href)};
    import { takeOverConversation } from ${JSON.stringify(new URL('../src/core/conversation-takeovers.mjs', import.meta.url).href)};
    const db = openCockpitDatabase(process.argv[1]);
    takeOverConversation(db, JSON.parse(process.argv[2]), {
      faultInjector(point) {
        if (point === 'takeover.after_command_commit_before_transaction_commit') process.kill(process.pid, 'SIGKILL');
      },
    });
    db.close();
  `;
  assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', child,
    fixture.dbPath, JSON.stringify(confirmation)], { encoding: 'utf8' }));

  db = openCockpitDatabase(fixture.dbPath);
  assert.equal(db.prepare('SELECT revision FROM runs WHERE id = ?').get(initialized.sessionId).revision, initialized.revision);
  assert.equal(db.prepare(`SELECT owner_locator FROM conversation_bindings
    WHERE session_id = ? AND revoked = 0`).get(initialized.sessionId).owner_locator, 'chat-a');
  assert.equal(db.prepare('SELECT state FROM commands WHERE id = ?')
    .get(`conversation.takeover.${initialized.sessionId}.takeover-kill-confirm`).state, 'received');
  const retried = takeOverConversation(db, confirmation);
  assert.equal(retried.takeoverAccepted, true);
  assert.equal(retried.revision, initialized.revision + 1);
  db.close();
});
