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

test('a lock whose pid was recycled by a different process is reclaimable', (t) => {
  const lockPath = lockFixture(t, 'ugk-lock-recycled-');
  // The lock claims the pid of a process that is definitely alive — this one —
  // but records a different boot-relative start time, which is exactly what a
  // recycled pid looks like.
  writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    ownerToken: 'abandoned-owner',
    createdAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString(),
    processIdentity: '9999999999',
  }), 'utf8');

  if (process.platform !== 'linux') {
    // 该平台没有可靠的进程身份来源，活 PID 必须继续被当作在跑。
    assert.throws(() => acquireInstanceLock(lockPath), { code: 'INSTANCE_ALREADY_RUNNING' });
    return;
  }
  const lock = acquireInstanceLock(lockPath);
  t.after(() => lock.release());
  assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).pid, process.pid);
});

test('a live instance is never stolen, whatever the clock says', (t) => {
  const lockPath = lockFixture(t, 'ugk-lock-live-clock-');
  const lock = acquireInstanceLock(lockPath);
  t.after(() => lock.release());

  // Simulate both a long-running instance and a clock jump by backdating the
  // lock far beyond any plausible deadline: time is not evidence of death.
  const backdated = JSON.parse(readFileSync(lockPath, 'utf8'));
  backdated.createdAt = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
  writeFileSync(lockPath, JSON.stringify(backdated), 'utf8');

  assert.throws(() => acquireInstanceLock(lockPath), { code: 'INSTANCE_ALREADY_RUNNING' });
  // The original owner still holds and can release the very same lock.
  assert.doesNotThrow(() => lock.release());
  assert.equal(existsSync(lockPath), false);
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

test('a dead owner is reclaimed as before', (t) => {
  const lockPath = lockFixture(t, 'ugk-lock-dead-');
  writeFileSync(lockPath, JSON.stringify({
    pid: 999_999_999,
    ownerToken: 'dead-owner',
    createdAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString(),
  }), 'utf8');
  const lock = acquireInstanceLock(lockPath);
  t.after(() => lock.release());
  assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).pid, process.pid);
});
