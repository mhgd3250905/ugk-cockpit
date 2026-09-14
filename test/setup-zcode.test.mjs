import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupZcode, createZcodeClient, inspectZcodeLegacy, resolveZcodeCli } from '../scripts/setup-zcode.mjs';
import { resolvePluginOutputRoot } from '../scripts/plugin-output-root.mjs';

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

test('the CLI resolver finds the platform-native executable name', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'zcode-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // POSIX 安装的可执行文件通常没有扩展名，而 Windows 上是 .exe。
  const name = process.platform === 'win32' ? 'zcode.exe' : 'zcode';
  const target = path.join(dir, name);
  writeFileSync(target, '#!/bin/sh\nexit 0\n');
  if (process.platform !== 'win32') chmodSync(target, 0o755);

  const resolved = resolveZcodeCli({ PATH: dir });
  assert.equal(resolved.file, target);
  assert.deepEqual(resolved.args, []);
});

test('the darwin CLI resolver falls back to the app bundle entry without PATH hits', () => {
  // 与实现使用同一 path.join 语义：Windows 宿主上 mock 必须匹配目标平台的
  // 分隔符，而不是硬编码 POSIX 字符串。
  const systemBundle = path.join('/Applications/ZCode.app', 'Contents', 'Resources', 'glm', 'zcode.cjs');
  const userBundle = path.join('/Users/x', 'Applications', 'ZCode.app', 'Contents', 'Resources', 'glm', 'zcode.cjs');

  // A .cjs bundle entry is started through the node interpreter.
  const system = resolveZcodeCli({ PATH: '' }, {
    platform: 'darwin', home: '/Users/x',
    exists: (candidate) => candidate === systemBundle,
    stat: (candidate) => ({ isFile: () => candidate === systemBundle }),
  });
  assert.equal(system.file, process.execPath);
  assert.deepEqual(system.args, [systemBundle]);

  const user = resolveZcodeCli({ PATH: '' }, {
    platform: 'darwin', home: '/Users/x',
    exists: (candidate) => candidate === userBundle,
    stat: (candidate) => ({ isFile: () => candidate === userBundle }),
  });
  assert.deepEqual(user.args, [userBundle]);
});

test('the darwin CLI resolver still finds the real bundled CLI on this machine', { skip: process.platform !== 'darwin' && 'requires macOS' }, (t) => {
  const bundle = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';
  if (!existsSync(bundle)) { t.skip('ZCode.app is not installed in /Applications'); return; }
  const resolved = resolveZcodeCli({ PATH: '' });
  assert.deepEqual(resolved.args, [bundle]);
});

test('a JS CLI entry is still started through the node interpreter', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'zcode-cjs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'zcode.cjs');
  writeFileSync(target, '// entry\n');
  const resolved = resolveZcodeCli({ PATH: dir });
  assert.equal(resolved.file, process.execPath);
  assert.deepEqual(resolved.args, [target]);
});

test('the plugin output root is resolved without a Windows-only environment variable', () => {
  const explicit = resolvePluginOutputRoot('plugin-packages', {
    env: { UGK_PLUGIN_OUTPUT_ROOT: '/tmp/ugk-output' },
    platform: 'linux',
  });
  assert.equal(explicit, path.resolve('/tmp/ugk-output', 'plugin-packages'));

  const posix = resolvePluginOutputRoot('plugin-packages', { env: {}, platform: 'linux' });
  assert.ok(path.isAbsolute(posix));
  assert.ok(posix.endsWith(path.join('UGK Cockpit', 'plugin-packages')));

  // 缺少平台位置时必须给出可操作的错误，而不是把 undefined 交给 path.join。
  assert.throws(
    () => resolvePluginOutputRoot('plugin-packages', { env: {}, platform: 'win32' }),
    /UGK_PLUGIN_OUTPUT_ROOT/,
  );
});
