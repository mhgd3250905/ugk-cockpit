import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const workerPath = fileURLToPath(new URL('../../scripts/lock-worker.mjs', import.meta.url));

function runWorker(lockPath, holdMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, lockPath, String(holdMs)], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('eight processes produce one live instance owner', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-lock-process-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'service.lock');
  const results = await Promise.all(
    Array.from({ length: 8 }, () => runWorker(lockPath, 1_500)),
  );
  assert.equal(results.filter((result) => result.status === 0).length, 1);
  assert.equal(results.filter((result) => result.status === 2).length, 7);
});

test('a process killed while holding the lock does not block recovery', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-lock-kill-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'service.lock');
  const child = spawn(process.execPath, [workerPath, lockPath, '10000'], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', (chunk) => {
      assert.match(chunk.toString(), /acquired/);
      resolve();
    });
  });
  child.kill();
  await new Promise((resolve) => child.once('close', resolve));
  const recovered = await runWorker(lockPath, 10);
  assert.equal(recovered.status, 0, recovered.stderr);
});

