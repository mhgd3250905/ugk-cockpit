import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { setupCodex } from '../scripts/setup-codex.mjs';
import { verifyServiceData } from '../scripts/verify-service-data.mjs';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { registerProject } from '../src/core/projects.mjs';
import { probeGitWorktree } from '../src/git/probe.mjs';

async function bounded(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

// Tests the absent-service orchestration against a real process and persisted
// project. The worker uses port 0; production main.mjs/start() and its fixed
// port, dependency installation and Codex registration are outside this test.
test('installer starts a real isolated service and verifies an existing project before registration', { timeout: 30_000 }, async (t) => {
  const directory = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'ugk-setup-service-'));
  let child;
  let closed;
  t.after(async () => {
    if (child) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await bounded(closed, 5000, 'Fixture service did not exit');
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const repository = path.join(directory, 'repository');
  mkdirSync(repository);
  const git = (args) => execFileSync('git', args, {
    cwd: repository, windowsHide: true, timeout: 5000, maxBuffer: 256 * 1024,
  });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Setup Fixture']);
  git(['config', 'user.email', 'fixture@localhost']);
  writeFileSync(path.join(repository, 'README.md'), 'existing project\n');
  git(['add', 'README.md']);
  git(['commit', '-m', 'fixture baseline']);
  const dbPath = path.join(directory, 'cockpit.db');
  const db = openCockpitDatabase(dbPath);
  try {
    const registered = registerProject(db, {
      commandId: 'setup-fixture-project', name: 'Existing installation project',
      observation: await probeGitWorktree(repository),
    });
    assert.equal(registered.ok, true);
  } finally { db.close(); }

  let serviceUrl;
  const calls = [];
  const result = await setupCodex({}, {
    platform: 'win32', version: '24.15.0',
    dataDirectory: () => directory,
    outputRoot: () => path.join(directory, 'packages'),
    inspectLegacy: async () => ({ skills: [], mcp: false }),
    run: async (name, args) => {
      calls.push([name, ...args]);
      return { stdout: JSON.stringify({ pluginId: 'ugk-cockpit@ugk-cockpit-local', version: 'fixture-version' }) };
    },
    build: async () => ({ marketplaceRoot: path.join(directory, 'packages'), version: 'fixture-version' }),
    probe: async () => {
      if (!serviceUrl) return false;
      const response = await fetch(new URL('health', serviceUrl), { signal: AbortSignal.timeout(3000) });
      assert.equal(response.ok, true);
      return (await response.json()).status === 'ok';
    },
    start: async (actualDirectory) => {
      assert.equal(actualDirectory, directory);
      calls.push(['start']);
      const config = Buffer.from(JSON.stringify({
        dbPath, token: 'isolated-setup-service-test-token', authorizedRoots: [repository],
      })).toString('base64url');
      child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/service-worker.mjs', import.meta.url)), config], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      closed = new Promise((resolve) => child.once('close', resolve));
      child.stderr.resume();
      const ready = new Promise((resolve, reject) => {
        let output = '';
        child.once('error', reject);
        child.once('exit', () => reject(new Error('Fixture service exited before readiness')));
        child.stdout.on('data', (chunk) => {
          output += chunk.toString();
          if (output.length > 4096) return reject(new Error('Unexpected fixture readiness output'));
          if (!output.includes('\n')) return;
          try { resolve(JSON.parse(output.split('\n')[0])); } catch (error) { reject(error); }
        });
      });
      const { port } = await bounded(ready, 10_000, 'Fixture service readiness timed out');
      assert.ok(Number.isInteger(port) && port > 0);
      serviceUrl = `http://127.0.0.1:${port}/`;
    },
    verify: async (actualDirectory) => {
      assert.equal(actualDirectory, directory);
      assert.equal(await verifyServiceData(directory, serviceUrl), 1);
      calls.push(['verified-existing-project']);
    },
  });
  assert.equal(result.status, 'host_verification_pending');
  const verified = calls.findIndex((row) => row[0] === 'verified-existing-project');
  const registered = calls.findIndex((row) => row.includes('--json'));
  assert.ok(verified > calls.findIndex((row) => row[0] === 'start'));
  assert.ok(registered > verified);
});
