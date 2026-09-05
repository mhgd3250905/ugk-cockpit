import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createServiceHandlers } from '../src/mcp/service-client.mjs';
import { createCockpitHttpServer } from '../src/service/http-server.mjs';

test('stdio entrypoint ignores a divergent AppData credential and renews service credentials without changing context', () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'ugk-mcp-auth-view-'));
  try {
    mkdirSync(path.join(fixture, 'UGK Cockpit'));
    writeFileSync(path.join(fixture, 'UGK Cockpit', 'api-token'), 'different-file-view-'.padEnd(44, 'x'));
    const preload = path.join(fixture, 'transport.mjs');
    writeFileSync(preload, `
import assert from 'node:assert/strict';
let bootstraps = 0;
let originalBody;
globalThis.fetch = async (url, options) => {
  if (url.pathname === '/api/v1/mcp/session') {
    assert.equal(options.headers.authorization, undefined);
    bootstraps += 1;
    return Response.json({ token: ('service-' + bootstraps).padEnd(40, 's') }, { status: 201 });
  }
  assert.equal(url.pathname, '/api/v1/mcp/work/context');
  assert.equal(options.headers.authorization, 'Bearer ' + ('service-' + bootstraps).padEnd(40, 's'));
  if (bootstraps === 1) {
    originalBody = options.body;
    return Response.json({ code: 'AUTH_REQUIRED' }, { status: 401 });
  }
  assert.equal(bootstraps, 2);
  assert.equal(options.body, originalBody);
  assert.equal(JSON.parse(options.body).mcpWorkingDirectory, process.cwd());
  return Response.json({ ok: true, status: 'active', revision: 17, bindingStatus: 'unbound' });
};
`);
    const stdout = execFileSync(process.execPath, [
      '--import', pathToFileURL(preload).href,
      path.resolve('src/mcp/main.mjs'),
    ], {
      cwd: fixture,
      env: { ...process.env, LOCALAPPDATA: fixture },
      windowsHide: true,
      encoding: 'utf8',
      timeout: 10000,
      input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ugk_work_context', arguments: {} } })}\n`,
    });
    const message = JSON.parse(stdout.trim());
    assert.equal(message.result.isError, undefined);
    const result = JSON.parse(message.result.content[0].text);
    assert.deepEqual(result, { ok: true, status: 'active', revision: 17, bindingStatus: 'unbound' });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('a live MCP handler renews its scoped credential after the HTTP service restarts', async () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'ugk-mcp-auth-restart-'));
  const options = { dbPath: path.join(fixture, 'cockpit.db'), token: 'service-private-token-'.padEnd(40, 'x') };
  let service = await createCockpitHttpServer(options);
  try {
    const port = service.port;
    const responses = [];
    const handlers = createServiceHandlers({
      baseUrl: `http://127.0.0.1:${port}`,
      fetchImpl: async (url, request) => {
        // Isolate credential renewal from an old keep-alive socket being closed
        // at the exact instant of restart; uncertain transport errors stay errors.
        const response = await fetch(url, {
          ...request,
          headers: { ...request.headers, connection: 'close' },
        });
        responses.push({ path: url.pathname, status: response.status });
        return response;
      },
    });
    // Invalid business arguments prove the request passed authentication without
    // creating or changing any work session.
    await assert.rejects(handlers.ugk_work_progress({}), /INVALID_REQUEST/);
    await service.close();
    service = null;
    service = await createCockpitHttpServer({ ...options, port });
    await assert.rejects(handlers.ugk_work_progress({}), /INVALID_REQUEST/);
    assert.deepEqual(responses.map(item => item.status), [201, 400, 401, 201, 400]);
    assert.equal(responses.filter(item => item.path === '/api/v1/mcp/session').length, 2);
  } finally {
    await service?.close();
    rmSync(fixture, { recursive: true, force: true });
  }
});
