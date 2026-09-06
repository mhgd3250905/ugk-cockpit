import { randomUUID } from 'node:crypto';
import { closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

const protocol = 'ugk-cockpit-delivery-index-lock-v1';
const locked = () => Object.assign(new Error('The Git index is locked by another or unverified owner.'), { code: 'DELIVERY_INDEX_LOCKED' });
const identity = (stat) => `${stat.dev}:${stat.ino}`;

// A lock whose ownership record cannot be parsed can only come from a crashed
// create/write — git's own index.lock and ours both live far below this bound.
const MALFORMED_LOCK_RECLAIM_AGE_MS = 60_000;
// A well-formed lock whose recorded PID still exists may simply have been a PID
// reuse after a crash. A live save is bounded by per-operation git timeouts and
// the repository lock TTL, so beyond this ceiling the lock is a crash leftover.
const STALE_OWNER_RECLAIM_AGE_MS = 60 * 60_000;

function sameFile(lockPath, fileIdentity, bytes) {
  try {
    const stat = lstatSync(lockPath, { bigint: true });
    return stat.isFile() && identity(stat) === fileIdentity && stat.size === BigInt(Buffer.byteLength(bytes))
      && readFileSync(lockPath, 'utf8') === bytes;
  } catch { return false; }
}

function lockAgeMs(lockPath) {
  try {
    return Date.now() - lstatSync(lockPath).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function parseOwner(bytes, fileIdentity, lockPath) {
  let owner;
  try {
    owner = JSON.parse(bytes);
  } catch {
    return null;
  }
  if (owner.protocol !== protocol || typeof owner.commandId !== 'string' || !owner.commandId || owner.lockPath !== lockPath
    || owner.fileIdentity !== fileIdentity || typeof owner.owner !== 'string'
    || !/^[a-f0-9-]{36}$/.test(owner.owner) || !Number.isSafeInteger(owner.pid) || owner.pid < 1) return null;
  return owner;
}

function reclaimExitedOwner(lockPath) {
  let fd;
  try {
    const stat = lstatSync(lockPath, { bigint: true });
    if (!stat.isFile() || stat.size > 4096n) return false;
    fd = openSync(lockPath, 'r');
    const fileIdentity = identity(fstatSync(fd, { bigint: true }));
    const bytes = readFileSync(fd, 'utf8');
    const owner = parseOwner(bytes, fileIdentity, lockPath);
    if (!owner) {
      // Empty or unreadable ownership record: recoverable only once it is far
      // older than any legitimate create→write window could ever be.
      if (lockAgeMs(lockPath) < MALFORMED_LOCK_RECLAIM_AGE_MS) return false;
    } else {
      let exited = false;
      try { process.kill(owner.pid, 0); } catch (error) { exited = error.code === 'ESRCH'; }
      // A reused PID, an inaccessible process, or a live owner never proves the
      // holder still exists; only the hard age ceiling breaks the tie.
      if (!exited && lockAgeMs(lockPath) < STALE_OWNER_RECLAIM_AGE_MS) return false;
    }
    // The delivery service holds its repository lock throughout this operation.
    if (!sameFile(lockPath, fileIdentity, bytes)) return false;
    closeSync(fd);
    fd = undefined;
    if (!sameFile(lockPath, fileIdentity, bytes)) return false;
    unlinkSync(lockPath);
    return true;
  } catch { return false; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function acquireDeliveryIndexLock(indexPath, commandId) {
  const lockPath = `${indexPath}.lock`;
  let fd;
  try { fd = openSync(lockPath, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!reclaimExitedOwner(lockPath)) throw locked();
    try { fd = openSync(lockPath, 'wx'); }
    catch (retryError) { if (retryError.code === 'EEXIST') throw locked(); throw retryError; }
  }
  const fileIdentity = identity(fstatSync(fd, { bigint: true }));
  const bytes = JSON.stringify({ protocol, owner: randomUUID(), pid: process.pid, commandId, lockPath, fileIdentity });
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    // An incomplete ownership record is left behind deliberately; the reclaim
    // path above recovers it automatically once it ages past the bound.
    throw error;
  }
  return { fd, lockPath, fileIdentity, bytes };
}

export function releaseDeliveryIndexLock(lock) {
  try {
    closeSync(lock.fd);
  } catch {
    // The fd is best-effort; a double release must never mask a real error.
  }
  try {
    if (sameFile(lock.lockPath, lock.fileIdentity, lock.bytes)) unlinkSync(lock.lockPath);
  } catch {
    // Best effort only: a leftover lock is reclaimed by age on the next acquire.
  }
}

export function assertDeliveryIndexLock(lock) {
  if (!sameFile(lock.lockPath, lock.fileIdentity, lock.bytes)) throw locked();
}
