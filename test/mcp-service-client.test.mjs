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

  const submitArguments = {
    sessionId: 'session-1', clientRequestId: 'request-submit', expectedRevision: 2,
    summary: '完成开发空间功能',
  };
  await handlers.ugk_work_submit(submitArguments);
  assert.equal(calls[2].url, 'http://127.0.0.1:41737/api/v1/mcp/work/submit');
  assert.deepEqual(JSON.parse(calls[2].options.body), submitArguments);

  await handlers.ugk_work_handoff({
    sessionId: 'session-1', clientRequestId: 'request-3', expectedRevision: 1,
    outcome: 'completed', nextSessionFocus: '等待安排', summary: 'done',
    currentState: 'clean', completedItems: [], pendingItems: [], decisions: [],
    artifactRefs: [], risks: [], suggestedSkills: [],
  });
  assert.equal(calls[3].url, 'http://127.0.0.1:41737/api/v1/mcp/work/handoff');

  await handlers.ugk_work_init({
    initCode: 'init-code', clientRequestId: 'request-4',
    currentTask: '继续现有开发', currentState: '功能完成一半',
  });
  assert.equal(calls[4].url, 'http://127.0.0.1:41737/api/v1/mcp/work/init');
  assert.deepEqual(JSON.parse(calls[4].options.body), {
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

test('MCP service handlers bootstrap a scoped local session when the API token is unavailable', async () => {
  const calls = [];
  const scopedToken = 'scoped-mcp-token-that-is-long-enough';
  const handlers = createServiceHandlers({
    token: null,
    fetchImpl: async (url, options) => {
      calls.push({ url: url.toString(), options });
      if (url.pathname === '/api/v1/mcp/session') {
        return new Response(JSON.stringify({ ok: true, token: scopedToken }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true, revision: 3 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const result = await handlers.ugk_work_progress({
    sessionId: 'session-1', clientRequestId: 'progress-1', expectedRevision: 2,
    status: 'working', note: '继续开发',
  });

  assert.equal(result.revision, 3);
  assert.equal(calls[0].url, 'http://127.0.0.1:41737/api/v1/mcp/session');
  assert.equal(calls[0].options.headers.authorization, undefined);
  assert.equal(calls[1].options.headers.authorization, `Bearer ${scopedToken}`);
});

test('MCP service handlers refresh an expired scoped session once', async () => {
  let bootstrapCount = 0;
  const calls = [];
  const handlers = createServiceHandlers({
    token: null,
    fetchImpl: async (url, options) => {
      calls.push({ url: url.toString(), options });
      if (url.pathname === '/api/v1/mcp/session') {
        bootstrapCount += 1;
        return new Response(JSON.stringify({
          ok: true,
          token: `scoped-token-${bootstrapCount}-${'x'.repeat(32)}`,
        }), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      if (bootstrapCount === 1) {
        return new Response(JSON.stringify({ code: 'AUTH_REQUIRED' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true, revision: 4 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const result = await handlers.ugk_work_progress({
    sessionId: 'session-1', clientRequestId: 'progress-2', expectedRevision: 3,
    status: 'working', note: '刷新会话后继续',
  });

  assert.equal(result.revision, 4);
  assert.equal(bootstrapCount, 2);
  assert.equal(calls.length, 4);
  assert.notEqual(calls[1].options.headers.authorization, calls[3].options.headers.authorization);
});
