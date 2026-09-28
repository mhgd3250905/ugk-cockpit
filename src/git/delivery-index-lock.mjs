import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  fsyncSync,
  linkSync,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const protocol = 'ugk-cockpit-delivery-index-lock-v1';
// `ownerState` distinguishes why a lock was refused, because the operator's
// next step differs completely: waiting is right for a live holder, while an
// unattributable lock never resolves on its own and a leaked lock of our own can
// be reclaimed the moment it is readable again. The code stays one code so the
// existing delivery contracts keep their meaning.
const refused = (message, ownerState) => Object.assign(
  new Error(message),
  { code: 'DELIVERY_INDEX_LOCKED', details: { ownerState } },
);
const locked = () => refused('The Git index is locked by another or unverified owner.', 'live-holder');
// A lock that carries no readable owner record cannot be shown to belong to a
// running process, but it cannot be shown to belong to a finished one either, so
// it stays in place: this is git's own `index.lock` namespace and a live `git`
// write puts an empty file there too. Refusing is right; reporting it as
// "another operation is running" is not, because that never resolves by waiting.
const unattributedLock = () => refused(
  'The Git index lock carries no readable owner record.',
  'unattributed',
);
// Our own record, still byte-identical, that the filesystem refused to delete.
// Nobody else can reproduce those bytes, so this one is ours to reclaim.
const stuckOwnLock = () => refused(
  'The Git index lock this process published could not be deleted.',
  'own-lock-stuck',
);
const identity = (stat) => `${stat.dev}:${stat.ino}`;
// Link errors that mean "this filesystem cannot hard link", as opposed to the
// EEXIST that means somebody else already published the lock.
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOSYS', 'ENOTSUP', 'EACCES', 'EXDEV', 'EINVAL', 'EOPNOTSUPP']);
const TEMP_SWEEP_AFTER_MS = 10 * 60 * 1000;
// Locks whose release this process could not complete, keyed by path. Bounded so
// a long-lived service cannot accumulate them; each entry is a path and the
// exact bytes we published.
const leakedOwnLocks = new Map();
const LEAKED_OWN_LOCK_LIMIT = 64;

function recordLeakedOwnLock(lock) {
  // Delete first so re-recording moves the path to the back of the eviction
  // order: a path that keeps leaking must not sit at the front and be the first
  // entry dropped.
  leakedOwnLocks.delete(lock.lockPath);
  if (leakedOwnLocks.size >= LEAKED_OWN_LOCK_LIMIT) {
    const oldest = leakedOwnLocks.keys().next();
    if (!oldest.done) leakedOwnLocks.delete(oldest.value);
  }
  leakedOwnLocks.set(lock.lockPath, { fileIdentity: lock.fileIdentity, bytes: lock.bytes });
}

function forgetLeakedOwnLock(lockPath) {
  leakedOwnLocks.delete(lockPath);
}

function sameFile(lockPath, fileIdentity, bytes) {
  try {
    const stat = lstatSync(lockPath, { bigint: true });
    return stat.isFile() && identity(stat) === fileIdentity && stat.size === BigInt(Buffer.byteLength(bytes))
      && readFileSync(lockPath, 'utf8') === bytes;
  } catch { return false; }
}

function reclaimExitedOwner(lockPath) {
  let fd;
  try {
    const stat = lstatSync(lockPath, { bigint: true });
    if (!stat.isFile() || stat.size > 4096n) return 'unattributed';
    fd = openSync(lockPath, 'r');
    const fileIdentity = identity(fstatSync(fd, { bigint: true }));
    const bytes = readFileSync(fd, 'utf8');
    let owner;
    try { owner = JSON.parse(bytes); } catch { return 'unattributed'; }
    if (owner.protocol !== protocol || typeof owner.commandId !== 'string' || !owner.commandId || owner.lockPath !== lockPath
      || owner.fileIdentity !== fileIdentity || typeof owner.owner !== 'string'
      || !/^[a-f0-9-]{36}$/.test(owner.owner) || !Number.isSafeInteger(owner.pid) || owner.pid < 1) return 'unattributed';
    try { process.kill(owner.pid, 0); return 'held'; }
    catch (error) { if (error.code !== 'ESRCH') return 'held'; }
    // A reused PID, an inaccessible process, or a replaced lock never proves an exited owner.
    // The delivery service holds its repository lock throughout this operation.
    if (!sameFile(lockPath, fileIdentity, bytes)) return 'held';
    closeSync(fd);
    fd = undefined;
    if (!sameFile(lockPath, fileIdentity, bytes)) return 'held';
    unlinkSync(lockPath);
    return 'reclaimed';
  } catch (error) {
    // The name disappeared under us: nothing is being protected any more, so the
    // caller may publish.
    if (error?.code === 'ENOENT') return 'reclaimed';
    // A record this platform cannot read is *not* proof that nobody owns it.
    // EBUSY/EPERM here usually means exactly the security software that caused
    // the leak in the first place, and telling the operator to handle the lock
    // themselves would invite deleting a live git index.lock. Stay conservative.
    return 'held';
  }
  finally { if (fd !== undefined) closeSync(fd); }
}

function ownerPayload(lockPath, fileIdentity, commandId) {
  return JSON.stringify({ protocol, owner: randomUUID(), pid: process.pid, commandId, lockPath, fileIdentity });
}

// One place decides what to do with a lock name that is already taken. Returns
// true when the name is free for the caller to publish; otherwise it refuses
// with the reason the operator can act on.
function reclaimContendedLock(lockPath, unlink = unlinkSync) {
  const leak = leakedOwnLocks.get(lockPath);
  if (leak) {
    // The owner record is a random UUID this process generated, so a
    // byte-identical file with the same device/inode can only be our own leak.
    // Reclaiming it is not a guess about somebody else's operation.
    if (!sameFile(lockPath, leak.fileIdentity, leak.bytes)) {
      forgetLeakedOwnLock(lockPath);
    } else {
      // Re-read immediately before deleting, as `reclaimExitedOwner` does: the
      // window between the two reads is where a foreign lock could otherwise be
      // mistaken for ours after a delete-and-recreate.
      if (!sameFile(lockPath, leak.fileIdentity, leak.bytes)) {
        forgetLeakedOwnLock(lockPath);
      } else {
        try {
          unlink(lockPath);
        } catch {
          // Still held (security software or an indexer on Windows). Say so: the
          // alternative reads as "wait for an operation that already finished".
          throw stuckOwnLock();
        }
        forgetLeakedOwnLock(lockPath);
        return true;
      }
    }
  }
  const outcome = reclaimExitedOwner(lockPath);
  if (outcome === 'reclaimed') return true;
  if (outcome === 'unattributed') throw unattributedLock();
  throw locked();
}

// A private name is written and fsynced first, then hard-linked into place, so
// the lock at `lockPath` is either absent or complete. Creating `lockPath`
// directly leaves a window where the file exists with no owner record, and a
// process killed inside it strands the repository: an unattributable lock in
// Git's own index.lock namespace can never be deleted automatically (a live
// `git` write uses the same shape), so every later delivery would report
// DELIVERY_INDEX_LOCKED forever with nothing to wait out.
// `faultInjector` is a test seam, matching the core's convention: it is called
// at named points so a test can terminate the process exactly inside the
// publish window instead of hoping a random kill lands there.
// 'delivery_index_lock.before_link' - publish artifact complete, not yet visible
// 'delivery_index_lock.after_create' - lock name exists, owner record not yet written
function publishAtomically(lockPath, commandId, faultInjector) {
  const tempPath = `${lockPath}.tmp-${randomUUID()}`;
  let fd;
  try {
    fd = openSync(tempPath, 'wx');
    const fileIdentity = identity(fstatSync(fd, { bigint: true }));
    const bytes = ownerPayload(lockPath, fileIdentity, commandId);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    // The artifact name is passed so a test can remove it, which is what the
    // stale-temp sweep does to a publisher that stalls for too long.
    faultInjector?.('delivery_index_lock.before_link', tempPath);
    linkSync(tempPath, lockPath);
    return { lockPath, fileIdentity, bytes };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch {} }
    try { unlinkSync(tempPath); } catch {}
  }
}

// Filesystems without hard links (FAT/exFAT) keep the previous in-place create.
// Exclusive creation is what makes two publishers choose one winner, and rename
// cannot replace it here without silently overwriting a lock a live `git` put in
// git's own namespace a moment earlier. That leaves the create-then-fill window
// this helper cannot close: a process killed inside it strands a lock no owner
// record can be read from, which stays unattributable by design and is now
// reported as such instead of as contention to wait out.
function acquireInPlace(lockPath, commandId, faultInjector, unlink) {
  let fd;
  try { fd = openSync(lockPath, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    reclaimContendedLock(lockPath, unlink);
    try { fd = openSync(lockPath, 'wx'); }
    catch (retryError) { if (retryError.code === 'EEXIST') throw locked(); throw retryError; }
  }
  const fileIdentity = identity(fstatSync(fd, { bigint: true }));
  const bytes = ownerPayload(lockPath, fileIdentity, commandId);
  faultInjector?.('delivery_index_lock.after_create');
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    // The write failed, so this file can never satisfy the ownership protocol
    // again — and while our own pid is recorded as alive, reclaimExitedOwner
    // would refuse it forever. Remove the artifact we just created (only if
    // it is still the file we opened) so one failed write cannot lock the
    // repository until the next service restart.
    try {
      const stat = lstatSync(lockPath, { bigint: true });
      if (stat.isFile() && identity(stat) === fileIdentity) unlinkSync(lockPath);
    } catch {}
    throw error;
  }
  return { fd, lockPath, fileIdentity, bytes };
}

function sweepStaleLockTemps(lockPath) {
  const directory = path.dirname(lockPath);
  const prefix = `${path.basename(lockPath)}.tmp-`;
  let names;
  try { names = readdirSync(directory); } catch { return; }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const candidate = path.join(directory, name);
    try {
      if (Date.now() - statSync(candidate).mtimeMs < TEMP_SWEEP_AFTER_MS) continue;
      unlinkSync(candidate);
    } catch {}
  }
}

// `unlink` is a test seam, matching `releaseDeliveryIndexLock`: the only way to
// exercise "the filesystem still refuses to delete our own leaked lock" without
// holding a handle from another process.
export function acquireDeliveryIndexLock(indexPath, commandId, { faultInjector, unlink = unlinkSync } = {}) {
  const lockPath = `${indexPath}.lock`;
  sweepStaleLockTemps(lockPath);
  // A reclaim is allowed once, so a successful reclaim is never answered as a
  // spurious "locked"; a second contention means someone else genuinely won.
  let reclaimed = false;
  // The private publish artifact may be swept while this process stalls between
  // writing it and linking it. That retry is separate from a reclaim, so a real
  // reclaim stays available afterwards.
  let retriedPublish = false;
  for (;;) {
    let published;
    try {
      published = publishAtomically(lockPath, commandId, faultInjector);
    } catch (error) {
      if (error.code === 'EEXIST') {
        if (reclaimed) throw locked();
        reclaimContendedLock(lockPath, unlink);
        reclaimed = true;
        continue;
      }
      if (error.code === 'ENOENT' && !retriedPublish) {
        // The publish artifact vanished before the link: the sweep can do that
        // to a creator stalled over ten minutes, and the link also fails while
        // somebody else already holds the name. Retry once so the second
        // attempt reports the contention as DELIVERY_INDEX_LOCKED; a missing
        // directory stays the real error it is.
        if (!existsSync(path.dirname(lockPath))) throw error;
        retriedPublish = true;
        continue;
      }
      if (LINK_UNSUPPORTED.has(error.code)) return acquireInPlace(lockPath, commandId, faultInjector, unlink);
      throw error;
    }
    // Keep a descriptor on the lock for the operation, as the in-place path does.
    let fd;
    try { fd = openSync(lockPath, 'r'); } catch { fd = undefined; }
    return { fd, ...published };
  }
  throw locked();
}


export function releaseDeliveryIndexLock(lock, { unlink = unlinkSync } = {}) {
  // Best effort: the caller's finally already holds the real outcome, and a
  // release error must not mask a saved commit (or its local_saved state).
  // A few immediate retries cover the shortest Windows transient refusals
  // (AV / indexer). What must never happen is the caller being the only one who
  // knows: the failed release is recorded so the next acquire in this process
  // can reclaim its own bytes (see `reclaimContendedLock`), and a release that
  // keeps failing is reported as our own stuck lock rather than as somebody
  // else's operation to wait for. A lock this process did not publish stays
  // untouched either way.
  try { closeSync(lock.fd); } catch {}
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!sameFile(lock.lockPath, lock.fileIdentity, lock.bytes)) {
      forgetLeakedOwnLock(lock.lockPath);
      return true;
    }
    try {
      unlink(lock.lockPath);
      forgetLeakedOwnLock(lock.lockPath);
      return true;
    } catch {
      recordLeakedOwnLock(lock);
    }
  }
  return false;
}

export function assertDeliveryIndexLock(lock) {
  if (!sameFile(lock.lockPath, lock.fileIdentity, lock.bytes)) throw locked();
}
