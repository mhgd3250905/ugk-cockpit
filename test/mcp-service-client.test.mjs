import assert from 'node:assert/strict';
import test from 'node:test';
import { createServiceHandlers } from '../src/mcp/service-client.mjs';

test('MCP service handlers forward only tool arguments with the local bearer token', async () => {
  const calls = [];
  const handlers = createServiceHandlers({
    token: 'x'.repeat(32),
    workingDirectory: 'E:\\fixture\\active-project',
    fetchImpl: async (url, options) => {
      calls.push({ url: url.toString(), options });
      return new Response(JSON.stringify({ ok: true, sessionId: 'session-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const arguments_ = { dispatchCode: 'dispatch', clientRequestId: 'request-1' };
  assert.equal((await handlers.ugk_work_accept(arguments_)).sessionId, 'session-1');
  assert.equal(calls[0].url, 'http://127.0.0.1:41737/api/v1/mcp/work/accept');
  assert.equal(calls[0].options.headers.authorization, `Bearer ${'x'.repeat(32)}`);
  assert.deepEqual(JSON.parse(calls[0].options.body), arguments_);

  await handlers.ugk_work_begin({
    sessionId: 'session-1', clientRequestId: 'request-2', expectedRevision: 1, task: '开始工作',
  });
  assert.equal(calls[1].url, 'http://127.0.0.1:41737/api/v1/mcp/work/begin');

  await handlers.ugk_work_handoff({
    sessionId: 'session-1', clientRequestId: 'request-3', expectedRevision: 1,
    outcome: 'completed', nextSessionFocus: '等待安排', summary: 'done',
    currentState: 'clean', completedItems: [], pendingItems: [], decisions: [],
    artifactRefs: [], risks: [], suggestedSkills: [],
  });
  assert.equal(calls[2].url, 'http://127.0.0.1:41737/api/v1/mcp/work/handoff');

  await handlers.ugk_work_init({
    initCode: 'init-code', clientRequestId: 'request-4',
    currentTask: '继续现有开发', currentState: '功能完成一半',
  });
  assert.equal(calls[3].url, 'http://127.0.0.1:41737/api/v1/mcp/work/init');
  assert.deepEqual(JSON.parse(calls[3].options.body), {
    initCode: 'init-code',
    clientRequestId: 'request-4',
    currentTask: '继续现有开发',
    currentState: '功能完成一半',
    mcpWorkingDirectory: 'E:\\fixture\\active-project',
  });
});

test('MCP service errors expose the public service message without leaking response details', async () => {
  const handlers = createServiceHandlers({
    token: 'x'.repeat(32),
    fetchImpl: async () => new Response(JSON.stringify({
      code: 'DISPATCH_EXPIRED', message: '这次接手码已经过期。', secret: 'must-not-surface',
    }), { status: 409 }),
  });
  await assert.rejects(
    handlers.ugk_work_accept({ dispatchCode: 'old', clientRequestId: 'request-2' }),
    (error) => error.publicMessage === '这次接手码已经过期。' && !error.message.includes('secret'),
  );
});
