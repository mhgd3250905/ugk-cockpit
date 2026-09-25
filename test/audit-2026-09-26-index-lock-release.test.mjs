// Audit round 2026-09-26, finding 5 (P1, permanent delivery blockage).
//
// Releasing the lock can fail: on Windows a security product or an indexer can
// hold `<index>.lock` open long enough that all three unlink attempts fail. The
// return value was discarded, so the leaked lock stayed behind and every later
// delivery answered "another Git operation is using the index — wait for it and
// do not delete the lock file", which is un-actionable: the operation to wait
// for was the one that just finished, and the only recovery was a service
// restart. Meanwhile the same file blocks the user's own `git add`/`git commit`,
// because this lock deliberately lives in git's own `index.lock` namespace.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, unlinkSync, writeFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  acquireDeliveryIndexLock,
  releaseDeliveryIndexLock,
} from '../src/git/delivery-index-lock.mjs';
import { deliveryResponse } from '../src/core/delivery-messages.mjs';

const PROTOCOL = 'ugk-cockpit-delivery-index-lock-v1';

function fixture(t) {
  const base = process.platform === 'win32' ? os.tmpdir() : realpathSync(os.tmpdir());
  const root = mkdtempSync(path.join(base, 'ugk-index-lock-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  const indexPath = path.join(root, 'index');
  writeFileSync(indexPath, 'fixture git index');
  return { root, indexPath, lockPath: `${indexPath}.lock` };
}

const refusingUnlink = () => { throw Object.assign(new Error('busy'), { code: 'EPERM' }); };

test('a release the filesystem refused is reclaimed by the next delivery', (t) => {
  const { indexPath, lockPath } = fixture(t);
  const lock = acquireDeliveryIndexLock(indexPath, 'cmd-first');
  const owner = JSON.parse(readFileSync(lockPath, 'utf8'));
  assert.equal(owner.commandId, 'cmd-first');

  // Exactly what the old code did with the failure: nothing.
  assert.equal(releaseDeliveryIndexLock(lock, { unlink: refusingUnlink }), false);
  assert.equal(statSync(lockPath).isFile(), true, 'the lock was removed anyway');

  // The next save must not be told to wait for an operation that already ended.
  const next = acquireDeliveryIndexLock(indexPath, 'cmd-second');
  const reclaimed = JSON.parse(readFileSync(lockPath, 'utf8'));
  assert.equal(reclaimed.commandId, 'cmd-second');
  assert.equal(releaseDeliveryIndexLock(next), true);
  assert.throws(() => readFileSync(lockPath, 'utf8'), { code: 'ENOENT' });
});

test('the self-reclaim only ever accepts the bytes this process published', (t) => {
  const { indexPath, lockPath } = fixture(t);
  const mine = acquireDeliveryIndexLock(indexPath, 'cmd-mine');
  releaseDeliveryIndexLock(mine, { unlink: refusingUnlink });

  // Somebody else (a real git, or another Cockpit) now owns the name.
  unlinkSync(lockPath);
  writeFileSync(lockPath, 'an unrelated git index.lock');
  assert.throws(() => acquireDeliveryIndexLock(indexPath, 'cmd-next'), (error) => {
    assert.equal(error.code, 'DELIVERY_INDEX_LOCKED');
    // Not presented as our own recoverable leak.
    assert.notEqual(error.details?.ownerState, 'own-lock-stuck');
    return true;
  });
  assert.equal(readFileSync(lockPath, 'utf8'), 'an unrelated git index.lock',
    'a lock this process did not publish must stay exactly as found');
});

test('an unattributable lock is reported as one, not as contention to wait out', (t) => {
  const { indexPath, lockPath } = fixture(t);
  // The state a killed publisher leaves behind where hard links are missing, and
  // the state a user's own `touch .git/index.lock` produces.
  for (const foreign of ['', 'not json', '{"protocol":"other"}']) {
    writeFileSync(lockPath, foreign);
    assert.throws(() => acquireDeliveryIndexLock(indexPath, 'cmd-foreigh'), (error) => {
      assert.equal(error.code, 'DELIVERY_INDEX_LOCKED');
      assert.equal(error.details?.ownerState, 'unattributed', `got ${JSON.stringify(error.details)} for ${JSON.stringify(foreign)}`);
      return true;
    });
    assert.equal(readFileSync(lockPath, 'utf8'), foreign,
      'a lock this platform cannot attribute must stay exactly as found');
  }
});

test('a lock held by a live owner stays reported as live contention', (t) => {
  const { indexPath, lockPath } = fixture(t);
  writeFileSync(lockPath, 'placeholder');
  const stat = statSync(lockPath, { bigint: true });
  writeFileSync(lockPath, JSON.stringify({
    protocol: PROTOCOL,
    owner: '00000000-0000-4000-8000-000000000001',
    pid: process.pid,
    commandId: 'cmd-live',
    lockPath,
    fileIdentity: `${stat.dev}:${stat.ino}`,
  }));
  assert.throws(() => acquireDeliveryIndexLock(indexPath, 'cmd-blocked'), (error) => {
    assert.equal(error.code, 'DELIVERY_INDEX_LOCKED');
    assert.equal(error.details?.ownerState, 'live-holder');
    return true;
  });
});

test('a leaked lock the filesystem still refuses to delete says so', (t) => {
  const { indexPath, lockPath } = fixture(t);
  const lock = acquireDeliveryIndexLock(indexPath, 'cmd-stuck');
  releaseDeliveryIndexLock(lock, { unlink: refusingUnlink });

  // The reclaim itself fails: the operator must be told this is our own lock that
  // cannot be removed right now, not somebody else's operation to wait for.
  assert.throws(() => acquireDeliveryIndexLock(indexPath, 'cmd-retry', { unlink: refusingUnlink }), (error) => {
    assert.equal(error.code, 'DELIVERY_INDEX_LOCKED');
    assert.equal(error.details.ownerState, 'own-lock-stuck');
    return true;
  });
  assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).commandId, 'cmd-stuck',
    'a refused reclaim must leave the record untouched');

  // Once the unlink works again, the same command proceeds.
  const recovered = acquireDeliveryIndexLock(indexPath, 'cmd-retry');
  assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).commandId, 'cmd-retry');
  assert.equal(releaseDeliveryIndexLock(recovered), true);
});

test('the operator guidance separates waiting from an unattributable lock', () => {
  const waiting = deliveryResponse({ ok: false, code: 'DELIVERY_INDEX_LOCKED', details: { ownerState: 'live-holder' } });
  assert.match(waiting.required_action, /等/u, 'a live holder must still be described as worth waiting for');
  assert.match(waiting.required_action, /不要删除/u);

  const unattributed = deliveryResponse({ ok: false, code: 'DELIVERY_INDEX_LOCKED', details: { ownerState: 'unattributed' } });
  assert.notEqual(unattributed.required_action, waiting.required_action,
    'an unattributable lock is still answered with wait-for-the-other-operation advice');
  assert.match(unattributed.required_action, /不会消失|自行处理/u);
  assert.match(unattributed.message, /暂存区/u);

  const stuck = deliveryResponse({ ok: false, code: 'DELIVERY_INDEX_LOCKED', details: { ownerState: 'own-lock-stuck' } });
  assert.match(stuck.required_action, /平台会自动回收/u);
  assert.match(stuck.required_action, /不需要你手动删除/u);

  // No ownerState at all keeps the pre-existing contract.
  const plain = deliveryResponse({ ok: false, code: 'DELIVERY_INDEX_LOCKED' });
  assert.equal(plain.required_action, waiting.required_action);
});

test('a normal release still removes the lock and reports success', (t) => {
  const { indexPath, lockPath } = fixture(t);
  const lock = acquireDeliveryIndexLock(indexPath, 'cmd-plain');
  assert.equal(releaseDeliveryIndexLock(lock), true);
  assert.throws(() => statSync(lockPath), { code: 'ENOENT' });
  // A second acquire after a clean release is unaffected by the leak registry.
  const again = acquireDeliveryIndexLock(indexPath, 'cmd-again');
  assert.equal(releaseDeliveryIndexLock(again), true);
});
