import assert from 'node:assert/strict';
import test from 'node:test';
import { createServiceHandlers } from '../src/mcp/service-client.mjs';
import { dispatchMessage } from '../src/mcp/stdio-protocol.mjs';

const TOKEN = 'b'.repeat(32);

function recordingHandlers(responseBody, calls = []) {
  const handlers = createServiceHandlers({
    token: TOKEN,
    workingDirectory: 'E:\\fixture\\declared-project',
    fetchImpl: async (url, options) => {
      calls.push({ url: url.toString(), body: JSON.parse(options.body) });
      return new Response(JSON.stringify(responseBody ?? { ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  return { handlers, calls };
}

// The service documents declaredWorkspace as the fallback for hosts that give
// the bridge no usable working directory, publishes it in the tool schema, and
// accepts it on /api/v1/mcp/work/context.
test('ugk_work_context 必须把 declaredWorkspace 交给服务，否则文档承诺的回退永远不生效', async () => {
  const { handlers, calls } = recordingHandlers({ ok: true, status: 'no_session' });
  await handlers.ugk_work_context({
    declaredWorkspace: 'E:\\fixture\\declared-project',
    confirmSessionId: undefined,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:41737/api/v1/mcp/work/context');
  assert.equal(calls[0].body.declaredWorkspace, 'E:\\fixture\\declared-project',
    `outbound body was ${JSON.stringify(calls[0].body)}`);
  assert.equal(calls[0].body.mcpWorkingDirectory, 'E:\\fixture\\declared-project');
});

test('同一回退经完整 stdio 链路仍然送达（schema 已发布，参数不能在半路被丢掉）', async () => {
  const { handlers, calls } = recordingHandlers({ ok: true, status: 'no_session' });
  const result = await dispatchMessage({
    jsonrpc: '2.0',
    id: 'ctx-declared',
    method: 'tools/call',
    params: {
      name: 'ugk_work_context',
      arguments: { declaredWorkspace: 'E:\\fixture\\declared-project' },
    },
  }, { handlers });
  assert.equal(result.result?.isError, undefined, JSON.stringify(result));
  assert.equal(calls.length, 1, JSON.stringify(result));
  assert.equal(calls[0].body.declaredWorkspace, 'E:\\fixture\\declared-project');
});

// The delivery tools answer HTTP 200 with ok:false on failure, so the bridge is
// the only place that can mark the tool result as an error for the host.
test('送审失败必须以 isError 交给宿主：ugk_work_submit 与 preflight 都是结构化工具', async () => {
  for (const [name, args] of [
    ['ugk_work_submit', { preflightId: 'pf-1', clientRequestId: 'r-1', summary: '送审' }],
    ['ugk_work_submit_preflight', { sessionId: 'session-1', expectedRevision: 1, clientRequestId: 'r-2', files: ['a.txt'] }],
  ]) {
    const { handlers } = recordingHandlers({
      ok: false, code: 'DELIVERY_PUSH_FAILED', localSaved: true, pushed: false,
      retryable: true, requiresNewPreflight: false, preflightId: 'pf-1', submissionId: 'sub-1',
    });
    const result = await dispatchMessage({
      jsonrpc: '2.0', id: `f-${name}`, method: 'tools/call', params: { name, arguments: args },
    }, { handlers });
    assert.equal(result.result?.isError, true, `${name}: ${JSON.stringify(result.result)}`);
    // isError alone is not enough: the receipt facts the host must act on have to
    // survive the curated error payload (code-based wording, ids, booleans).
    const payload = JSON.parse(result.result.content[0].text);
    assert.equal(payload.code, 'DELIVERY_PUSH_FAILED', JSON.stringify(payload));
    assert.equal(payload.localSaved, true, JSON.stringify(payload));
    assert.equal(payload.pushed, false, JSON.stringify(payload));
    assert.equal(payload.retryable, true, JSON.stringify(payload));
    assert.equal(payload.requiresNewPreflight, false, JSON.stringify(payload));
    assert.equal(payload.preflightId, 'pf-1', JSON.stringify(payload));
    assert.equal(payload.submissionId, 'sub-1', JSON.stringify(payload));
  }
});

test('反向界：送审成功不得被标成错误，已有结构化工具行为不变', async () => {
  const { handlers } = recordingHandlers({ ok: true, commandId: 'cmd-1', localSaved: true, pushed: true });
  const ok = await dispatchMessage({
    jsonrpc: '2.0', id: 's-ok', method: 'tools/call',
    params: { name: 'ugk_work_submit', arguments: { preflightId: 'pf-1', clientRequestId: 'r-9', summary: '送审' } },
  }, { handlers });
  assert.equal(ok.result?.isError, undefined, JSON.stringify(ok.result));

  const { handlers: noteHandlers } = recordingHandlers({ ok: false, code: 'SUBMIT_NOTE_NOT_FOUND' });
  const note = await dispatchMessage({
    jsonrpc: '2.0', id: 'n-fail', method: 'tools/call',
    params: { name: 'ugk_work_submit_note', arguments: { sessionId: 'session-1', clientRequestId: 'r-10', note: 'x' } },
  }, { handlers: noteHandlers });
  assert.equal(note.result?.isError, true, JSON.stringify(note.result));
});
