import assert from 'node:assert/strict';
import os from 'node:os';
import test from 'node:test';
import { createServiceHandlers } from '../src/mcp/service-client.mjs';

test('credential bootstrap honors the shutdown signal instead of lingering on its own timeout', { timeout: 5000 }, async () => {
  const controller = new AbortController();
  const seenSignals = [];
  const hangingFetch = (url, init = {}) => new Promise((resolve, reject) => {
    const signal = init.signal ?? null;
    seenSignals.push(signal);
    // 真实 fetch 对"已经中止的信号"会立即拒绝；桩必须模拟同一语义。
    if (signal?.aborted) {
      reject(new Error('signal aborted'));
      return;
    }
    signal?.addEventListener('abort', () => reject(new Error('signal aborted')), { once: true });
  });
  const handlers = createServiceHandlers({
    baseUrl: 'http://127.0.0.1:1/',
    fetchImpl: hangingFetch,
    shutdownSignal: controller.signal,
    workingDirectory: os.tmpdir(),
  });

  const pending = handlers.ugk_work_context({});
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(seenSignals.length >= 1, '复现前提：bootstrap 必须已经发起请求');

  const start = Date.now();
  controller.abort(new Error('MCP stdio server closed.'));
  await assert.rejects(pending);
  assert.ok(Date.now() - start < 1500, `关停信号应在毫秒级生效，实际耗时 ${Date.now() - start}ms`);
});
