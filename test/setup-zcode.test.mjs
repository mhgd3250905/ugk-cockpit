import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupZcode, createZcodeClient, inspectZcodeLegacy } from '../scripts/setup-zcode.mjs';

function fixture() {
  const calls = [];
  const plugin = {
    id: 'ugk-cockpit@ugk-cockpit-local', version: 'v1', enabled: true,
    skillCount: 7, mcpServerNames: ['plugin:ugk-cockpit:ugk-cockpit'],
  };
  return {
    calls, plugin,
    deps: {
      resolve: () => ({}),
      inspect: () => ({ skills: [], mcp: false }),
      build: async () => ({ marketplaceRoot: 'C:/bundle', version: 'v1' }),
      service: async (options = {}) => { calls.push(options.dryRun ? 'preflight' : 'service'); return { status: 'service_verified', dataDirectory: 'C:/custom-cockpit-data' }; },
      connect: () => ({
        request: async (method) => { calls.push(method); return { installedPlugins: [plugin], plugins: [plugin] }; },
        close: () => calls.push('close'),
      }),
    },
  };
}

test('native installation verifies all skills/MCP while host call remains pending', async () => {
  const { calls, deps } = fixture();
  const result = await setupZcode({}, deps);
  assert.equal(result.status, 'host_verification_pending');
  assert.equal(result.dataDirectory, 'C:/custom-cockpit-data');
  assert.deepEqual(calls, ['preflight', 'service', 'plugins/marketplace/add', 'plugins/install', 'plugins/list', 'close']);
});

test('dry run only preflights, without bundle writes or native process', async () => {
  const { calls, deps } = fixture();
  deps.build = () => assert.fail();
  const result = await setupZcode({ dryRun: true }, deps);
  assert.equal(result.status, 'plan');
  assert.equal(result.dataDirectory, 'C:/custom-cockpit-data');
  assert.deepEqual(calls, ['preflight']);
});

test('start-only bypasses ZCode resolution and collision checks', async () => {
  for (const dryRun of [false, true]) {
    const { calls, deps } = fixture();
    deps.resolve = () => assert.fail();
    deps.inspect = () => assert.fail();
    assert.equal((await setupZcode({ startOnly: true, dryRun }, deps)).dataDirectory, 'C:/custom-cockpit-data');
    assert.deepEqual(calls, [dryRun ? 'preflight' : 'service']);
  }
});

test('failed service preflight prevents bundle creation', async () => {
  const { deps } = fixture();
  deps.service = async () => { throw new Error('version mismatch'); };
  deps.build = () => assert.fail();
  await assert.rejects(setupZcode({}, deps), /version mismatch/);
});

test('legacy configuration is preserved and migration reported', async () => {
  const { calls, deps } = fixture();
  deps.inspect = () => ({ skills: [], mcp: true });
  assert.equal((await setupZcode({}, deps)).status, 'migration_needed');
  assert.deepEqual(calls, []);
});

test('wrong version or missing skills fails and closes native process', async () => {
  for (const field of ['version', 'skillCount']) {
    const { calls, deps, plugin } = fixture();
    plugin[field] = field === 'version' ? 'old' : 6;
    await assert.rejects(setupZcode({}, deps), /confirm|expose/);
    assert.equal(calls.at(-1), 'close');
  }
});

test('native transport handles split NDJSON and redacts protocol error detail', async () => {
  const source = `
    let buffer = '';
    process.stdin.on('data', chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
        const result = request.method === 'error' ? { id: request.id, error: { code: -42, message: 'secret-detail' } }
          : { id: request.id, result: { okay: true } };
        const text = JSON.stringify(result) + '\\n';
        process.stdout.write(text.slice(0, 5));
        setTimeout(() => process.stdout.write(text.slice(5)), 5);
      }
    });
  `;
  const client = createZcodeClient({ cli: { file: process.execPath, args: ['-e', source] }, timeoutMs: 2000 });
  try {
    assert.deepEqual(await client.request('test', {}), { okay: true });
    await assert.rejects(client.request('error', {}), (error) => error.message.includes('-42') && !error.message.includes('secret-detail'));
  } finally { client.close(); }
});

test('native timeout reports uncertain outcome', async () => {
  const client = createZcodeClient({
    cli: { file: process.execPath, args: ['-e', 'process.stdin.resume();'] }, timeoutMs: 100,
  });
  try { await assert.rejects(client.request('install', {}), /outcome may be incomplete/); }
  finally { client.close(); }
});

test('legacy MCP fallback is inspected only when native user servers are empty', (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'zcode-legacy-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(path.join(home, '.agents'), { recursive: true });
  mkdirSync(path.join(home, '.zcode/cli'), { recursive: true });
  writeFileSync(path.join(home, '.agents/mcp.json'), JSON.stringify({ mcpServers: { 'ugk-cockpit': {} } }));
  assert.equal(inspectZcodeLegacy({ home }).mcp, true);
  writeFileSync(path.join(home, '.zcode/cli/config.json'), JSON.stringify({ mcp: { servers: { other: {} } } }));
  assert.equal(inspectZcodeLegacy({ home }).mcp, false);
});
