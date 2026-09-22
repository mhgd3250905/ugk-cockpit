// Crash fitness tests for the delivery index lock. AGENTS.md requires that a
// file-write crash scenario be tested by terminating a real process, not by an
// exception that still runs `finally`: a lock left in the Git index.lock
// namespace that no caller can attribute wedges delivery for that repository
// forever, because an unattributable lock must never be deleted automatically.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  acquireDeliveryIndexLock,
  releaseDeliveryIndexLock,
} from '../src/git/delivery-index-lock.mjs';

const PROTOCOL = 'ugk-cockpit-delivery-index-lock-v1';
const LOCK_MODULE = new URL('../src/git/delivery-index-lock.mjs', import.meta.url).href;

function fixture(t) {
  const base = process.platform === 'win32' ? os.tmpdir() : realpathSync(os.tmpdir());
  const root = mkdtempSync(path.join(base, 'ugk-index-lock-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  const indexPath = path.join(root, 'index');
  writeFileSync(indexPath, 'fixture git index');
  return { root, indexPath, lockPath: `${indexPath}.lock` };
}

function sizeOrNull(target) {
  try { return statSync(target).size; } catch { return null; }
}

// The child announces the exact instruction it is about to execute, so the
// parent can land SIGKILL inside the publish window instead of hoping to.
function spawnPublishRookie(indexPath, markers) {
  const script = `
    const fs = await import('node:fs');
    const { acquireDeliveryIndexLock, releaseDeliveryIndexLock } = await import(process.argv[1]);
    const [indexPath, startedPath, donePath] = process.argv.slice(2);
    fs.writeFileSync(startedPath, 'started');
    process.send({ preAcquire: true });
    const lock = acquireDeliveryIndexLock(indexPath, 'publish-window-victim');
    fs.writeFileSync(donePath, 'acquired');
    releaseDeliveryIndexLock(lock);
    process.send({ released: true });
  `;
  return spawn(process.execPath, ['--input-type=module', '--eval', script, LOCK_MODULE,
    indexPath, markers.started, markers.done], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
  });
}

// A real process kill is the only honest way to test a write crash, but the
// publish window here is sub-millisecond, so kills cannot be aimed at it on
// demand: some rounds land before the file appears and some after the creator
// already released it. These rounds therefore assert the *durable* rule - any
// lock a kill leaves behind must be attributable, and the next acquirer must
// always get in - while the deterministic tests below prove atomic publication
// by construction. The stranded-state repro itself lives in the paired
// regression: an empty lock is unattributable and must never be produced.
test('kills around the publish window never strand a lock the next acquirer cannot use', async (t) => {
  const { indexPath, lockPath } = fixture(t);
  let roundsWithAPublishedLock = 0;
  for (let round = 1; round <= 20; round += 1) {
    const markers = {
      started: `${lockPath}.started-${round}`,
      done: `${lockPath}.done-${round}`,
    };
    const child = spawnPublishRookie(indexPath, markers);
    const exited = once(child, 'exit');
    child.stderr.on('data', () => {});
    try {
      await Promise.race([
        once(child, 'message'),
        exited.then(() => { throw new Error(`child exited before announcing acquire (round ${round})`); }),
      ]);
      await new Promise((resolve) => setTimeout(resolve, round % 9));
      child.kill('SIGKILL');
      await exited;

      const size = sizeOrNull(lockPath);
      if (size !== null) {
        roundsWithAPublishedLock += 1;
        const bytes = readFileSync(lockPath, 'utf8');
        assert.ok(bytes.length > 0,
          `round ${round}: a killed acquirer left a 0-byte lock, which no later caller can attribute`);
        const owner = JSON.parse(bytes);
        assert.equal(owner.protocol, PROTOCOL, `round ${round}: visible lock is not an owner record`);
        assert.equal(owner.pid, child.pid, `round ${round}: lock names a creator that is not the killed child`);
      }
      releaseDeliveryIndexLock(acquireDeliveryIndexLock(indexPath, `after-kill-${round}`));
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      rmSync(markers.started, { force: true });
      rmSync(markers.done, { force: true });
    }
  }
});

test('a killed holder leaves a lock the next acquirer reclaims by owner pid', async (t) => {
  const { indexPath, lockPath } = fixture(t);
  const script = `
    const { acquireDeliveryIndexLock } = await import(process.argv[1]);
    const lock = acquireDeliveryIndexLock(process.argv[2], 'holding-victim');
    process.send({ held: lock.lockPath });
    await new Promise(() => {});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script, LOCK_MODULE, indexPath], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
  });
  const exited = once(child, 'exit');
  child.stderr.on('data', () => {});
  const [message] = await Promise.race([
    once(child, 'message'),
    exited.then(() => { throw new Error('child exited before acquiring'); }),
  ]);
  assert.equal(message.held, lockPath);
  const bytes = readFileSync(lockPath, 'utf8');
  assert.equal(JSON.parse(bytes).pid, child.pid);

  child.kill('SIGKILL');
  await exited;
  const recovered = acquireDeliveryIndexLock(indexPath, 'after-holder-kill');
  assert.notEqual(recovered.lockPath, undefined);
  releaseDeliveryIndexLock(recovered);
});

test('the published lock carries its owner record before any caller can observe it', (t) => {
  const { root, indexPath, lockPath } = fixture(t);
  const lock = acquireDeliveryIndexLock(indexPath, 'complete-at-publish');
  try {
    const owner = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.equal(owner.protocol, PROTOCOL);
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.commandId, 'complete-at-publish');
    const stat = statSync(lockPath, { bigint: true });
    assert.equal(owner.fileIdentity, `${stat.dev}:${stat.ino}`);
  } finally {
    assert.equal(releaseDeliveryIndexLock(lock), true);
  }
  // No private publish artifact is left in the repository directory.
  assert.deepEqual(readdirSync(root).filter((name) => name.includes('.tmp-')), []);
});

test('an unattributable lock in the Git namespace is still never removed', (t) => {
  const { indexPath, lockPath } = fixture(t);
  for (const foreign of ['', 'not json', '{"protocol":"other"}']) {
    writeFileSync(lockPath, foreign);
    assert.throws(() => acquireDeliveryIndexLock(indexPath, 'foreign-lock'),
      { code: 'DELIVERY_INDEX_LOCKED' });
    assert.equal(readFileSync(lockPath, 'utf8'), foreign,
      'a lock this platform cannot attribute must stay exactly as found');
  }
});
