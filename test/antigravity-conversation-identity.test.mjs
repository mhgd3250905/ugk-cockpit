import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { registerProject } from '../src/core/projects.mjs';
import { probeGitWorktree } from '../src/git/probe.mjs';
import { createServiceHandlers } from '../src/mcp/service-client.mjs';
import { createCockpitHttpServer } from '../src/service/http-server.mjs';
import { conversationIdentity, conversationKey } from '../src/mcp/conversation-identity.mjs';
import { dispatchMessage } from '../src/mcp/stdio-protocol.mjs';

const native = 'antigravity.google/conversation_id';
const explicit = 'io.ugk.cockpit/conversation';
const envelope = (id) => ({ [native]: id });

test('Antigravity native metadata preserves the conversation ID and isolates different chats', () => {
  const id = 'chat-a-原始值';
  assert.deepEqual(conversationIdentity(envelope(id)), { host: 'antigravity', id });
  const first = conversationKey(conversationIdentity({ ...envelope(id), progressToken: 1 }));
  const second = conversationKey(conversationIdentity({ ...envelope(id), progressToken: 2 }));
  assert.equal(first, second);
  assert.notEqual(first, conversationKey(conversationIdentity(envelope('chat-b'))));
  assert.deepEqual(conversationIdentity(envelope(' chat-with-spaces ')), {
    host: 'antigravity', id: ' chat-with-spaces ',
  });
});

test('malformed Antigravity IDs fail closed instead of falling back to another identity', () => {
  for (const id of ['', ' ', '\n\t', null, undefined, 1, true, {}, [], 'x'.repeat(257)]) {
    assert.throws(() => conversationIdentity(envelope(id)), /Invalid host conversation metadata/);
    assert.throws(() => conversationIdentity({ ...envelope(id), threadId: 'valid-codex-id' }), /Invalid host conversation metadata/);
  }
});

test('Antigravity agrees only with identical explicit identity and rejects conflicting sources', () => {
  assert.deepEqual(conversationIdentity({ ...envelope('chat-a'), [explicit]: { host: 'antigravity', id: 'chat-a' } }), {
    host: 'antigravity', id: 'chat-a',
  });
  for (const other of [
    { [explicit]: { host: 'antigravity', id: 'chat-b' } },
    { [explicit]: { host: 'codex', id: 'chat-a' } },
    { threadId: 'chat-a' },
    { 'com.zcode/request-context': { session_id: 'chat-a' } },
  ]) {
    assert.throws(() => conversationIdentity({ ...envelope('chat-a'), ...other }), /Conflicting host conversation metadata/);
  }
});

test('generic conversation and session field names never imply an Antigravity identity', () => {
  for (const meta of [undefined, null, {}, { conversation_id: 'chat-a' }, { cascadeId: 'chat-a' }, { session_id: 'chat-a' }]) {
    assert.equal(conversationIdentity(meta), null);
  }
});

test('process environment cannot supply or override per-request Antigravity identity', (t) => {
  const env = { ...process.env };
  for (const name of ['ANTIGRAVITY_CONVERSATION_ID', 'ANTIGRAVITY_SESSION_ID', 'CASCADE_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID']) {
    env[name] = 'another-chat';
  }
  t.mock.property(process, 'env', env);
  assert.equal(conversationIdentity(undefined), null);
  assert.equal(conversationIdentity({}), null);
  assert.deepEqual(conversationIdentity(envelope('request-chat')), { host: 'antigravity', id: 'request-chat' });
});

test('tools/call forwards each request native metadata without leaking across interleaved chats', async () => {
  const seen = [];
  const metadata = [envelope('chat-a'), undefined, envelope('chat-b'), {}, envelope('chat-a'), { cascadeId: 'chat-b' }];
  const handlers = {
    async ugk_work_context(args, context) {
      assert.deepEqual(args, {});
      seen.push(context.conversationIdentity);
      await Promise.resolve();
      return { ok: true, identity: context.conversationIdentity };
    },
  };
  const responses = await Promise.all(metadata.map((_meta, index) => dispatchMessage({
    jsonrpc: '2.0', id: index, method: 'tools/call',
    params: { name: 'ugk_work_context', arguments: {}, ...(_meta === undefined ? {} : { _meta }) },
  }, { handlers })));
  const expected = [
    { host: 'antigravity', id: 'chat-a' }, null, { host: 'antigravity', id: 'chat-b' },
    null, { host: 'antigravity', id: 'chat-a' }, null,
  ];
  assert.deepEqual(seen, expected);
  assert.deepEqual(responses.map((response) => JSON.parse(response.result.content[0].text).identity), expected);
});

test('invalid or conflicting native metadata never invokes the tools/call handler', async () => {
  let calls = 0;
  for (const _meta of [envelope(''), envelope(12), { ...envelope('chat-a'), threadId: 'codex-a' }]) {
    const result = await dispatchMessage({ jsonrpc: '2.0', id: 'rejected', method: 'tools/call',
      params: { name: 'ugk_work_context', arguments: {}, _meta },
    }, { handlers: { ugk_work_context: async () => { calls++; return { ok: true }; } } });
    assert.equal(result.result.isError, true);
  }
  assert.equal(calls, 0);
});

test('native Antigravity relay ownership survives HTTP service and bridge reconstruction and fences other chats', async (t) => {
  const container = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'ugk-antigravity-identity-'));
  const root = path.join(container, 'project');
  mkdirSync(root);
  const dbPath = path.join(container, 'state.db');
  const token = 'antigravity-identity-fixture-token'.padEnd(44, 'x');
  let service;
  t.after(async () => {
    await service?.close();
    rmSync(container, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const git = (args) => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe', timeout: 10000 });
  git(['init', '--quiet']);
  writeFileSync(path.join(root, 'README.md'), '# Antigravity relay fixture\n');
  git(['add', 'README.md']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  const db = openCockpitDatabase(dbPath);
  let project;
  try {
    project = registerProject(db, { commandId: 'register-antigravity', name: 'Antigravity fixture',
      authorizedRoot: root, observation: await probeGitWorktree(root) });
  } finally { db.close(); }
  assert.equal(project.ok, true);
  service = await createCockpitHttpServer({ dbPath, token });
  const response = await fetch(`http://127.0.0.1:${service.port}/api/v1/projects/${project.projectId}/assignments`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ clientRequestId: 'assignment-antigravity', agent: 'Codex', mode: 'init', task: 'Relay native identity' }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  const assignment = await response.json();
  const createBridge = () => createServiceHandlers({ baseUrl: `http://127.0.0.1:${service.port}`, workingDirectory: root });
  let handlers = createBridge();
  let requestId = 0;
  const call = async (name, args, _meta) => {
    const reply = await dispatchMessage({ jsonrpc: '2.0', id: ++requestId, method: 'tools/call',
      params: { name, arguments: args, _meta } }, { handlers });
    assert.notEqual(reply.result?.isError, true, JSON.stringify(reply));
    return JSON.parse(reply.result.content[0].text);
  };
  const codex = { threadId: 'source-codex-chat' };
  const antigravity = envelope('destination-antigravity-chat');
  const initialized = await call('ugk_work_init', {
    initCode: assignment.message.match(/initCode: "([^"]+)"/)[1], clientRequestId: 'init-antigravity-fixture',
    currentTask: 'Relay native identity', currentState: 'Initial fixture',
  }, codex);
  const prepared = await call('ugk_work_relay', {
    sessionId: initialized.sessionId, expectedRevision: initialized.revision, clientRequestId: 'relay-to-antigravity',
    nextSessionFocus: 'Verify durable ownership', summary: 'Fixture prepared', currentState: 'Active',
    completedItems: [], pendingItems: [], decisions: [], artifactRefs: [], risks: [], suggestedSkills: [],
  }, codex);
  assert.equal(prepared.relayPrepared, true);
  const resumed = await call('ugk_work_resume', {
    continueCode: prepared.continueCode, clientRequestId: 'resume-native-antigravity',
  }, antigravity);
  assert.equal(resumed.relayAccepted, true);
  assert.equal(resumed.status, 'active');
  assert.equal(resumed.sessionId, initialized.sessionId);
  const denied = await dispatchMessage({ jsonrpc: '2.0', id: ++requestId, method: 'tools/call', params: {
    name: 'ugk_work_progress', arguments: { sessionId: resumed.sessionId, expectedRevision: resumed.revision,
      clientRequestId: 'old-codex-must-not-write', status: 'working', summary: 'Rejected old owner' }, _meta: codex,
  } }, { handlers });
  assert.equal(denied.result.isError, true);
  assert.match(JSON.stringify(denied), /CONVERSATION_BINDING_CONFLICT/);
  await service.close();
  service = null;
  service = await createCockpitHttpServer({ dbPath, token });
  handlers = createBridge();
  const context = await call('ugk_work_context', {}, antigravity);
  assert.equal(context.canContinue, true);
  assert.equal(context.bindingPersistence, 'durable');
  assert.equal(context.sessionId, resumed.sessionId);
  assert.equal(context.revision, resumed.revision);
  const foreign = await call('ugk_work_context', {}, envelope('other-antigravity-chat'));
  assert.equal(foreign.canContinue, false);
  const again = await call('ugk_work_context', {}, antigravity);
  assert.equal(again.canContinue, true);
  assert.equal(again.revision, resumed.revision);
});
