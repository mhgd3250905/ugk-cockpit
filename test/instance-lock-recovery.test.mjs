import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { acquireInstanceLock } from '../src/core/single-instance.mjs';

function lockFixture(t, prefix) {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  });
  return path.join(root, 'service.lock');
}

test('an abandoned lock whose pid was recycled does not block startup forever', (t) => {
  const lockPath = lockFixture(t, 'ugk-lock-recycled-');
  // The lock claims the pid of a process that is definitely alive — this
  // process — but it was written long ago, so the pid no longer identifies a
  // Cockpit instance.
  writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    ownerToken: 'abandoned-owner',
    createdAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString(),
  }), 'utf8');

  const lock = acquireInstanceLock(lockPath);
  t.after(() => lock.release());
  assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).pid, process.pid);
});

test('a lock whose heartbeat stopped is reclaimed even while the pid still exists', (t) => {
  const lockPath = lockFixture(t, 'ugk-lock-heartbeat-');
  writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    ownerToken: 'stopped-owner',
    createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    heartbeatAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  }), 'utf8');

  const lock = acquireInstanceLock(lockPath);
  t.after(() => lock.release());
  assert.ok(Date.parse(JSON.parse(readFileSync(lockPath, 'utf8')).heartbeatAt) > Date.now() - 60_000);
});

test('a freshly acquired lock still blocks a second instance and is released cleanly', (t) => {
  const lockPath = lockFixture(t, 'ugk-lock-live-');
  const lock = acquireInstanceLock(lockPath);
  assert.throws(() => acquireInstanceLock(lockPath), { code: 'INSTANCE_ALREADY_RUNNING' });
  lock.release();
  const second = acquireInstanceLock(lockPath);
  second.release();
  assert.doesNotThrow(() => second.release());
});

test('the owner keeps the lock fresh and release stops the heartbeat', async (t) => {
  const lockPath = lockFixture(t, 'ugk-lock-heartbeat-live-');
  const lock = acquireInstanceLock(lockPath, { heartbeatMs: 10 });
  const initial = JSON.parse(readFileSync(lockPath, 'utf8'));
  assert.equal(initial.pid, process.pid);
  assert.equal(initial.heartbeatAt, initial.createdAt);

  // 心跳必须真的写回文件，否则判活逻辑没有依据。这里必须用真正的异步等待，
  // 同步阻塞会让定时器根本没有机会触发。
  let refreshed = null;
  for (let i = 0; i < 100 && !refreshed; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    const current = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (current.heartbeatAt !== initial.heartbeatAt) refreshed = current;
  }
  assert.ok(refreshed, '心跳应在宽限期内刷新 heartbeatAt');
  assert.ok(Date.parse(refreshed.heartbeatAt) > Date.parse(initial.createdAt));
  assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).ownerToken, initial.ownerToken);

  lock.release();
  assert.equal(existsSync(lockPath), false, 'release 应删除锁文件');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(existsSync(lockPath), false, 'release 之后心跳不得再重建锁文件');
});
