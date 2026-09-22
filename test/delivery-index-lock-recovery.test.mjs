// Crash fitness test for the delivery index lock. AGENTS.md requires that a
// file-write crash scenario be tested by terminating a real process, not by an
// exception that still runs `finally`: a lock left in the Git index.lock
// namespace that no caller can attribute wedges delivery for that repository
// forever, because an unattributable lock must never be deleted automatically.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  acquireDeliveryIndexLock,
  releaseDeliveryIndexLock,
} from '../src/git/delivery-index-lock.mjs';

const PROTOCOL = 'ugk-cockpit-delivery-index-lock-v1';

function fixtureRoot(t) {
  // On POSIX the system temp root itself is often a symlink, and the path
  // helpers this repo uses reject link-traversing paths, so fixtures are built
  // under the resolved temp directory.
  const base = process.platform === 'win32' ? os.tmpdir() : realpathSync(os.tmpdir());
  const root = mkdtempSync(path.join(base, 'ugk-index-lock-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  return root;
}

function childScript() {
  return `
    const { acquireDeliveryIndexLock, releaseDeliveryIndexLock } = await import(process.argv[1]);
    const indexPath = process.argv[2];
    let round = 0;
    for (;;) {
      const lock = acquireDeliveryIndexLock(indexPath, 'crash-fitness-' + (round += 1));
      process.send({ held: round });
      releaseDeliveryIndexLock(lock);
    }
  `;
}

// Kills a holding process at an unpredictable point of its acquire/release
// cycle and asserts the surviving state is always usable.
test('a hard-killed acquirer never strands an unattributable index lock', { timeout: 180_000 }, async (t) => {
  const root = fixtureRoot(t);
  const indexPath = path.join(root, 'index');
  writeFileSync(indexPath, 'fixture git index');
  const lockPath = `${indexPath}.lock`;
  let killedWhileHolding = 0;
  let observedLockAfterKill = 0;

  for (let round = 0; round < 12; round += 1) {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', childScript(),
      new URL('../src/git/delivery-index-lock.mjs', import.meta.url).href, indexPath], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
    });
    const exited = once(child, 'exit');
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const held = await Promise.race([
      once(child, 'message'),
      exited.then(() => { throw new Error(`child exited before holding: ${stderr}`); }),
    ]);
    assert.equal(typeof held[0].held, 'number');
    // Sleep a random fraction of a cycle so the signal lands in a different
    // place every round, including inside the publish window.
    await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 40)));
    child.kill('SIGKILL');
    await exited;
    assert.equal(child.signalCode, 'SIGKILL', 'the round is only meaningful after a real process kill');

    if (statOrNull(lockPath)) {
      observedLockAfterKill += 1;
      const bytes = readFileSync(lockPath, 'utf8');
      // The regression this guards: a create-then-write lock can be observed
      // with no owner record at all, which no later caller can attribute.
      assert.ok(bytes.length > 0, `round ${round}: a killed acquirer left a 0-byte lock`);
      const owner = JSON.parse(bytes);
      assert.equal(owner.protocol, PROTOCOL, `round ${round}: lock is not an owner record`);
      assert.equal(owner.pid, child.pid);
      killedWhileHolding += 1;
    }
    // Whatever was left behind must be recoverable by the next acquirer.
    const recovered = acquireDeliveryIndexLock(indexPath, 'after-kill-' + round);
    assertDeliveryLockUsable(indexPath, recovered);
    releaseDeliveryIndexLock(recovered);
  }
  assert.ok(observedLockAfterKill > 0,
    'no round caught the child holding the lock, so the kill window was never exercised');
});

function assertDeliveryLockUsable(indexPath, lock) {
  const bytes = readFileSync(lock.lockPath, 'utf8');
  assert.equal(bytes, lock.bytes);
  assert.equal(JSON.parse(bytes).protocol, PROTOCOL);
}

function statOrNull(target) {
  try { return statSync(target); } catch { return null; }
}

test('the published lock carries its owner record before any caller can observe it', (t) => {
  const root = fixtureRoot(t);
  const indexPath = path.join(root, 'index');
  writeFileSync(indexPath, 'fixture git index');
  const lock = acquireDeliveryIndexLock(indexPath, 'complete-at-publish');
  try {
    const owner = JSON.parse(readFileSync(lock.lockPath, 'utf8'));
    assert.equal(owner.protocol, PROTOCOL);
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.commandId, 'complete-at-publish');
    assert.equal(owner.fileIdentity, `${statSync(lock.lockPath, { bigint: true }).dev}:${statSync(lock.lockPath, { bigint: true }).ino}`);
  } finally {
    assert.equal(releaseDeliveryIndexLock(lock), true);
  }
  // No private publish artifact is left in the repository directory.
  assert.deepEqual(readdirSync(root).filter((name) => name.includes('.tmp-')), []);
});

test('an unattributable lock in the Git namespace is still never removed', (t) => {
  const root = fixtureRoot(t);
  const indexPath = path.join(root, 'index');
  writeFileSync(indexPath, 'fixture git index');
  const lockPath = `${indexPath}.lock`;
  for (const foreign of ['', 'not json', '{"protocol":"other"}']) {
    writeFileSync(lockPath, foreign);
    assert.throws(() => acquireDeliveryIndexLock(indexPath, 'foreign-' + foreign.length),
      { code: 'DELIVERY_INDEX_LOCKED' });
    assert.equal(readFileSync(lockPath, 'utf8'), foreign,
      'a lock this platform cannot attribute must stay exactly as found');
  }
});
