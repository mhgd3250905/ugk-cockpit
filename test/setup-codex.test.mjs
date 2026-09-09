import test from 'node:test';
import assert from 'node:assert/strict';
import { setupCodex, inspectLegacyInstallation } from '../scripts/setup-codex.mjs';

function fixture(running = false) {
  const calls = [];
  const deps = {
    platform: 'win32', version: '24.15.0',
    run: async (name, args) => {
      calls.push([name, ...args]);
      return { stdout: JSON.stringify({ pluginId: 'ugk-cockpit@ugk-cockpit-local', version: 'test-version' }) };
    },
    dataDirectory: () => 'C:/isolated-data',
    outputRoot: () => 'C:/isolated-packages',
    inspectLegacy: async () => ({ skills: [], mcp: false }),
    probe: async () => running,
    start: async () => { calls.push(['start']); running = true; },
    verify: async () => { calls.push(['verify']); },
    build: async () => { calls.push(['build']); return { marketplaceRoot: 'C:/plugin & space', version: 'test-version' }; },
    wait: async () => {},
  };
  return { calls, deps };
}

test('new install builds, starts and verifies data before registering plugin; host remains pending', async () => {
  const { calls, deps } = fixture();
  const result = await setupCodex({}, deps);
  assert.equal(result.status, 'host_verification_pending');
  assert.equal(result.hostVerification, 'pending');
  assert.ok(calls.findIndex((row) => row[0] === 'verify') < calls.findIndex((row) => row.includes('C:/plugin & space')));
  assert.deepEqual(calls.at(-2), ['codex', 'plugin', 'marketplace', 'add', 'C:/plugin & space', '--json']);
  assert.deepEqual(calls.at(-1), ['codex', 'plugin', 'add', 'ugk-cockpit@ugk-cockpit-local', '--json']);
});

test('running service is verified and reused without build, restart or npm changes', async () => {
  const { calls, deps } = fixture(true);
  await setupCodex({}, deps);
  assert.equal(calls.filter((row) => row[0] === 'verify').length, 1);
  assert.ok(!calls.some((row) => ['npm', 'start'].includes(row[0])));
});

test('data mismatch stops installation before mutation', async () => {
  const { calls, deps } = fixture(true);
  deps.verify = async () => { throw new Error('Database/service project mismatch'); };
  await assert.rejects(setupCodex({}, deps), /mismatch/);
  assert.ok(!calls.some((row) => row[0] === 'build' || row.includes('--json')));
});

test('dry run does not build, start or install', async () => {
  const { calls, deps } = fixture();
  assert.equal((await setupCodex({ dryRun: true }, deps)).status, 'plan');
  assert.ok(calls.every((row) => row.includes('--help') || row.includes('--version')));
});

test('unsupported environment and missing Codex fail before mutations', async () => {
  const { calls, deps } = fixture();
  await assert.rejects(setupCodex({}, { ...deps, version: '24.14.0' }), /24.15/);
  assert.equal(calls.length, 0);
  deps.run = async () => { throw new Error('missing codex'); };
  await assert.rejects(setupCodex({}, deps), /missing codex/);
  assert.equal(calls.length, 0);
});

test('failed service readiness does not register plugin', async () => {
  const { calls, deps } = fixture();
  deps.start = async () => {};
  await assert.rejects(setupCodex({}, deps), /startup was not verified/);
  assert.ok(!calls.some((row) => row.includes('--json')));
});

test('existing standalone installation is reported before any mutation', async () => {
  const { calls, deps } = fixture();
  deps.inspectLegacy = async () => ({ skills: ['cockpit-relay'], mcp: true });
  const result = await setupCodex({}, deps);
  assert.equal(result.status, 'migration_needed');
  assert.ok(calls.every((row) => row.includes('--help') || row.includes('--version')));
});

test('start-only reuses the verified service without Codex or plugin installation', async () => {
  const { calls, deps } = fixture(true);
  assert.equal((await setupCodex({ startOnly: true }, deps)).status, 'service_verified');
  assert.deepEqual(calls, [['verify']]);
});

test('later startup uses prepared web assets without reinstalling dependencies', async () => {
  const { calls, deps } = fixture(false);
  deps.webReady = () => true;
  assert.equal((await setupCodex({ startOnly: true }, deps)).status, 'service_verified');
  assert.ok(calls.some((row) => row[0] === 'start'));
  assert.ok(!calls.some((row) => ['npm', 'codex', 'build'].includes(row[0])));
});

test('default package root is passed to builder', async () => {
  const { deps } = fixture(true);
  deps.build = async ({ outputRoot }) => {
    assert.equal(outputRoot, 'C:/isolated-packages');
    return { marketplaceRoot: outputRoot, version: 'test-version' };
  };
  await setupCodex({}, deps);
});

test('registration must confirm the expected plugin ID and version', async () => {
  for (const installed of [
    { pluginId: 'wrong', version: 'test-version' },
    { pluginId: 'ugk-cockpit@ugk-cockpit-local', version: 'old-version' },
  ]) {
    const { deps } = fixture(true);
    deps.run = async () => ({ stdout: JSON.stringify(installed) });
    await assert.rejects(setupCodex({}, deps), /expected Cockpit plugin version/);
  }
});

test('registration errors never expose command output', async () => {
  const { deps } = fixture(true);
  deps.run = async (_name, args) => {
    if (args.includes('--json')) throw new Error('secret-token-in-command-output');
    return { stdout: '' };
  };
  await assert.rejects(setupCodex({}, deps), (error) =>
    /registration did not complete/.test(error.message) && !error.message.includes('secret-token'));
});

test('legacy inspection distinguishes absent MCP from config failure and suppresses secret output', async () => {
  const execute = async () => { throw Object.assign(new Error('secret'), { stderr: "No MCP server named 'ugk-cockpit' found." }); };
  assert.equal((await inspectLegacyInstallation({ execute })).mcp, false);
  await assert.rejects(inspectLegacyInstallation({ execute: async () => { throw new Error('secret'); } }),
    (error) => /configuration could not be inspected/.test(error.message) && !error.message.includes('secret'));
});

test('matching installed plugin MCP is not mistaken for standalone on repeat setup', async () => {
  const expected = { command: 'node.exe', args: ['immutable/main.mjs'] };
  const inspect = (command) => inspectLegacyInstallation({
    execute: async (_name, args) => ({ stdout: JSON.stringify(args[0] === 'mcp'
      ? { transport: { type: 'stdio', command, args: expected.args, env: null, cwd: null, env_vars: [] } }
      : { installed: [{ pluginId: 'ugk-cockpit@ugk-cockpit-local', installed: true, enabled: true, version: '0.1.0' }] }) }),
    read: () => JSON.stringify({ mcpServers: { 'ugk-cockpit': expected } }),
  });
  assert.equal((await inspect('node.exe')).mcp, false);
  assert.equal((await inspect('other-node.exe')).mcp, true);
});
