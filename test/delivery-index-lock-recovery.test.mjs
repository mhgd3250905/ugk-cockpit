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

// The publish window is sub-millisecond, so a random kill cannot be aimed at it.
// The module exposes a `faultInjector` seam (same convention the core commands
// use) so a real process can be terminated at the exact instant the publish
// artifact is complete but not yet visible, which is the state that used to
// strand a repository.
test('a process killed inside the publish window leaves no partial lock', async (t) => {
  const { indexPath, lockPath } = fixture(t);
  const script = `
    const { acquireDeliveryIndexLock, releaseDeliveryIndexLock } = await import(process.argv[1]);
    process.send({ entering: true });
    const lock = acquireDeliveryIndexLock(process.argv[2], 'publish-window-victim', {
      faultInjector: (point) => {
        if (point !== 'delivery_index_lock.before_link') return;
        process.send({ insidePublishWindow: true });
        const until = Date.now() + 500;
        while (Date.now() < until) { /* hold the window open for the kill */ }
      },
    });
    process.send({ survived: true });
    releaseDeliveryIndexLock(lock);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script, LOCK_MODULE, indexPath], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
  });
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited.catch(() => {});
  });
  const messages = [];
  child.on('message', (message) => messages.push(message));
  // The seam announcing itself is the coverage proof: a module that publishes by
  // create-then-fill never reaches this point, so the wait below would fail.
  const inside = await Promise.race([
    new Promise((resolve) => {
      const check = () => {
        if (messages.some((message) => message.insidePublishWindow)) resolve(true);
        else setTimeout(check, 5);
      };
      check();
    }),
    Promise.all([new Promise((r) => setTimeout(r, 4000)), once(child, 'exit')]).then(() => false),
  ]);
  assert.ok(inside, `the publish seam never ran (survived=${messages.some((m) => m.survived)}) ${stderr.slice(0, 200)}`);
  child.kill('SIGKILL');
  await exited;
  assert.equal(child.signalCode, 'SIGKILL');

  // Killed with the artifact written but unlinked: nothing may be visible under
  // the lock name, because a 0-byte or half-written lock in git's namespace can
  // never be attributed and therefore can never be reclaimed.
  assert.equal(sizeOrNull(lockPath), null,
    'a killed publisher exposed a lock it had not finished writing');
  const leftovers = readdirSync(path.dirname(lockPath)).filter((name) => name.includes('.tmp-'));
  assert.equal(leftovers.length, 1, 'the unlinked publish artifact should still be awaiting its sweep');
  // ...and the repository is still usable: the next acquirer gets in immediately.
  releaseDeliveryIndexLock(acquireDeliveryIndexLock(indexPath, 'after-publish-kill'));
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
