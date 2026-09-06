import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

test('concurrent recovery from one stale lock still produces a single owner', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-lock-stale-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'service.lock');
  const goFile = path.join(root, 'go');
  // 双向屏障：先写入一把 owner 已死亡的陈旧锁（真实场景来自崩溃遗留），
  // 每个竞争者报告就绪后由测试放行，保证它们在同一锁检查窗口内到达；
  // 否则 spawn 启动抖动会让竞态窗口错过，测试失去对回归的捕获能力。
  const racerPath = path.join(root, 'stale-lock-racer.mjs');
  // Windows Node 不接受 C:\... 形式的 ESM import specifier；模块定位必须
  // 以 file:// URL 内嵌，跨平台一致。
  const singleInstanceModuleUrl = pathToFileURL(fileURLToPath(new URL('../../src/core/single-instance.mjs', import.meta.url))).href;
  writeFileSync(racerPath, `
    import { acquireInstanceLock } from ${JSON.stringify(singleInstanceModuleUrl)};
    import { existsSync, writeFileSync } from 'node:fs';
    const readyFile = process.argv[2] + '.ready';
    writeFileSync(readyFile, 'ready', 'utf8');
    while (!existsSync(${JSON.stringify(goFile)})) {}
    try {
      const lock = acquireInstanceLock(${JSON.stringify(lockPath)}, { pid: process.pid });
      process.stdout.write('acquired\\n');
      setTimeout(() => { lock.release(); process.exit(0); }, 1500);
    } catch (error) {
      process.stdout.write((error.code ?? 'error') + '\\n');
      process.exit(error.code === 'INSTANCE_ALREADY_RUNNING' ? 2 : 3);
    }
  `, 'utf8');
  // 一把 owner 已死亡的陈旧锁。
  writeFileSync(lockPath, JSON.stringify({
    pid: 999999999,
    ownerToken: 'stale-lock-owner',
    createdAt: '2020-01-01T00:00:00.000Z',
  }), 'utf8');
  const racers = Array.from({ length: 6 }, (_, index) => spawn(process.execPath, [racerPath, path.join(root, `racer-${index}`)], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  racers.forEach((child, index) => {
    child.once('error', () => { throw new Error(`racer ${index} failed to spawn`); });
  });
  const readyFiles = racers.map((_, index) => path.join(root, `racer-${index}.ready`));
  const readyDeadline = Date.now() + 30_000;
  while (!(readyFiles.every((file) => existsSync(file)))
    && Date.now() < readyDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(readyFiles.every((file) => existsSync(file)), 'racers did not become ready in time');
  writeFileSync(goFile, 'go', 'utf8');
  const results = await Promise.all(racers.map((child) => new Promise((resolve) => {
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.once('close', (status) => resolve({ status, stdout: stdout.trim() }));
  })));
  const outcomes = results.map((result) => result.stdout);
  assert.equal(outcomes.filter((status) => status === 'acquired').length, 1, JSON.stringify(outcomes));
  assert.equal(results.filter((result) => result.status === 2 && result.stdout === 'INSTANCE_ALREADY_RUNNING').length, 5, JSON.stringify(outcomes));
});

