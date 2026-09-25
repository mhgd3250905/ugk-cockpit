// Audit round 2026-09-26, findings 4, 6 and 7 (MCP bridge).
//
// 4. `ugk_work_context` advertises `declaredWorkspace`, the service validates
//    and uses it, and the access instruction tells a host whose bridge cannot
//    resolve a working directory to pass it — but the bridge rebuilt the request
//    field by field and dropped it, so the documented fallback could never work
//    on exactly the route that needs it most (read the current session), while
//    init/resume/takeover forwarded it.
// 6. Every input line was chained behind the previous handler, so a host's
//    keepalive `ping` waited behind a tool call that can take the full 30s
//    service timeout.
// 7. The payload-size guard ended a line only on `\n` while readline also
//    terminates on `\r`, so a `\r`-framed host accumulated a running total
//    across many small messages and was killed for a single oversized line it
//    never sent.
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { createServiceHandlers } from '../src/mcp/service-client.mjs';
import { createMcpServer, TOOLS } from '../src/mcp/stdio-protocol.mjs';

const WORKING_DIRECTORY = 'C:\\Users\\operator\\AppData\\Local\\UGK Cockpit';
const DECLARED = 'E:\\AII\\my-product';

function stubService(respondWith = { ok: true, status: 'no_session' }) {
  const calls = [];
  const handlers = createServiceHandlers({
    token: 'x'.repeat(32),
    workingDirectory: WORKING_DIRECTORY,
    fetchImpl: async (url, options) => {
      calls.push({ url: url.toString(), body: JSON.parse(options.body) });
      return new Response(JSON.stringify(respondWith), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  return { handlers, calls };
}

test('the context tool advertises declaredWorkspace and the service accepts it', () => {
  const tool = TOOLS.find((item) => item.name === 'ugk_work_context');
  assert.ok(tool.inputSchema.properties.declaredWorkspace,
    'the tool stopped advertising the fallback this test protects');
});

test('ugk_work_context forwards declaredWorkspace to the service', async () => {
  const { handlers, calls } = stubService();
  await handlers.ugk_work_context({
    declaredWorkspace: DECLARED,
    confirmSessionId: 'sess-1',
    expectedRevision: 3,
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/v1\/mcp\/work\/context$/u);
  assert.deepEqual(calls[0].body, {
    confirmSessionId: 'sess-1',
    expectedRevision: 3,
    declaredWorkspace: DECLARED,
    mcpWorkingDirectory: WORKING_DIRECTORY,
  });
});

test('omitted optional context fields stay omitted', async () => {
  const { handlers, calls } = stubService();
  await handlers.ugk_work_context({});
  assert.deepEqual(calls[0].body, { mcpWorkingDirectory: WORKING_DIRECTORY });
  await handlers.ugk_work_context({ confirmSessionId: 'sess-2', expectedRevision: 7 });
  assert.deepEqual(calls[1].body, {
    confirmSessionId: 'sess-2',
    expectedRevision: 7,
    mcpWorkingDirectory: WORKING_DIRECTORY,
  });
});

test('the other entry tools still forward declaredWorkspace', async () => {
  const { handlers, calls } = stubService({ ok: true, sessionId: 'sess-1' });
  await handlers.ugk_work_init({ initCode: 'init-1', clientRequestId: 'r1', declaredWorkspace: DECLARED });
  assert.equal(calls[0].body.declaredWorkspace, DECLARED);
});

function bridge(handlers = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = [];
  const answered = new Map();
  stdout.on('data', (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (!line.trim()) continue;
      const frame = JSON.parse(line);
      if (frame.id !== undefined && frame.id !== null) answered.set(frame.id, frame);
    }
  });
  const server = createMcpServer({
    stdin,
    stdout,
    stderr: { write: (chunk) => { stderr.push(String(chunk)); return true; } },
    handlers,
  });
  return { stdin, server, stderr, answered };
}

test('a ping is not held behind a slow tool call', async () => {
  const { stdin, server, answered } = bridge({
    ugk_work_context: async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { ok: true, status: 'active' };
    },
  });
  const started = Date.now();
  stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ugk_work_context', arguments: {} } })}\n`);
  stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n`);
  for (let attempt = 0; attempt < 100 && !answered.has(2); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const pingAt = Date.now() - started;
  assert.ok(answered.has(2), `the host keepalive was never answered (ids: ${[...answered.keys()].join(',')})`);
  assert.ok(pingAt < 300, `the ping waited ${pingAt}ms behind a tool call`);
  for (let attempt = 0; attempt < 100 && !answered.has(1); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(answered.has(1), 'the tool call itself never answered');
  server.close();
});

test('many small carriage-return framed messages do not trip the line limit', async () => {
  // The guard's line must be the same line readline delivers, or the counter
  // becomes a session-wide byte budget instead of a per-message ceiling.
  const { stdin, server, stderr, answered } = bridge({});
  const limit = 18 * 1024 * 1024;
  const padTo = 16 * 1024;
  const count = Math.ceil((limit + 1024 * 1024) / padTo);
  for (let index = 0; index < count; index += 1) {
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: index, method: 'ping', _pad: 'a'.repeat(padTo - 60) })}\r`);
    if (index % 250 === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  // Wait for the bridge to answer the last message rather than a fixed pause: a
  // loaded runner can otherwise tear the guard down before it ever accumulates
  // the bytes, and the assertion would pass for the wrong reason.
  for (let attempt = 0; attempt < 400 && !answered.has(count - 1); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(answered.has(count - 1), `the bridge stopped answering at message ${[...answered.keys()].length}`);
  assert.equal(stderr.join('').includes('payload limit'), false,
    `a CR-framed stream of ${padTo}-byte messages was killed for exceeding a ${limit}-byte line`);
  server.close();
});

test('a genuinely oversized line still fails closed', async () => {
  const { stdin, server, stderr } = bridge({});
  const chunk = Buffer.alloc(19 * 1024 * 1024, 0x61).toString('utf8');
  stdin.write(`{"jsonrpc":"2.0","id":1,"method":"ping","_pad":"${chunk}`);
  await new Promise((resolve) => setTimeout(resolve, 120));
  stdin.write('"}\n');
  for (let attempt = 0; attempt < 100 && !stderr.join('').includes('payload limit'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.match(stderr.join(''), /payload limit/u);
  server.close();
});
