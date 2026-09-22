import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  fsyncSync,
  linkSync,
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
const locked = () => Object.assign(new Error('The Git index is locked by another or unverified owner.'), { code: 'DELIVERY_INDEX_LOCKED' });
const identity = (stat) => `${stat.dev}:${stat.ino}`;
// Link errors that mean "this filesystem cannot hard link", as opposed to the
// EEXIST that means somebody else already published the lock.
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOSYS', 'ENOTSUP', 'EACCES', 'EXDEV', 'EINVAL', 'EOPNOTSUPP']);
const TEMP_SWEEP_AFTER_MS = 10 * 60 * 1000;

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
    if (!stat.isFile() || stat.size > 4096n) return false;
    fd = openSync(lockPath, 'r');
    const fileIdentity = identity(fstatSync(fd, { bigint: true }));
    const bytes = readFileSync(fd, 'utf8');
    const owner = JSON.parse(bytes);
    if (owner.protocol !== protocol || typeof owner.commandId !== 'string' || !owner.commandId || owner.lockPath !== lockPath
      || owner.fileIdentity !== fileIdentity || typeof owner.owner !== 'string'
      || !/^[a-f0-9-]{36}$/.test(owner.owner) || !Number.isSafeInteger(owner.pid) || owner.pid < 1) return false;
    try { process.kill(owner.pid, 0); return false; }
    catch (error) { if (error.code !== 'ESRCH') return false; }
    // A reused PID, an inaccessible process, or a replaced lock never proves an exited owner.
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

function ownerPayload(lockPath, fileIdentity, commandId) {
  return JSON.stringify({ protocol, owner: randomUUID(), pid: process.pid, commandId, lockPath, fileIdentity });
}

// A private name is written and fsynced first, then hard-linked into place, so
// the lock at `lockPath` is either absent or complete. Creating `lockPath`
// directly leaves a window where the file exists with no owner record, and a
// process killed inside it strands the repository: an unattributable lock in
// Git's own index.lock namespace can never be deleted automatically (a live
// `git` write uses the same shape), so every later delivery would report
// DELIVERY_INDEX_LOCKED forever with nothing to wait out.
function publishAtomically(lockPath, commandId) {
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
    linkSync(tempPath, lockPath);
    return { lockPath, fileIdentity, bytes };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch {} }
    try { unlinkSync(tempPath); } catch {}
  }
}

// Filesystems without hard links (FAT/exFAT) keep the previous in-place create.
function acquireInPlace(lockPath, commandId) {
  let fd;
  try { fd = openSync(lockPath, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!reclaimExitedOwner(lockPath)) throw locked();
    try { fd = openSync(lockPath, 'wx'); }
    catch (retryError) { if (retryError.code === 'EEXIST') throw locked(); throw retryError; }
  }
  const fileIdentity = identity(fstatSync(fd, { bigint: true }));
  const bytes = ownerPayload(lockPath, fileIdentity, commandId);
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

export function acquireDeliveryIndexLock(indexPath, commandId) {
  const lockPath = `${indexPath}.lock`;
  sweepStaleLockTemps(lockPath);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let published;
    try {
      published = publishAtomically(lockPath, commandId);
    } catch (error) {
      if (error.code === 'EEXIST') {
        if (!reclaimExitedOwner(lockPath)) throw locked();
        continue;
      }
      if (LINK_UNSUPPORTED.has(error.code)) return acquireInPlace(lockPath, commandId);
      throw error;
    }
    // Keep a descriptor on the lock for the operation, as the in-place path does.
    let fd;
    try { fd = openSync(lockPath, 'r'); } catch { fd = undefined; }
    return { fd, ...published };
  }
  throw locked();
}


export function releaseDeliveryIndexLock(lock) {
  // Best effort: the caller's finally already holds the real outcome, and a
  // release error must not mask a saved commit (or its local_saved state).
  // A few immediate retries cover the shortest Windows transient refusals
  // (AV / indexer); if the unlink still fails, the leaked lock is reclaimed
  // once the owning service process is gone — the pid liveness check in
  // reclaimExitedOwner stays the durable recovery path.
  try { closeSync(lock.fd); } catch {}
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!sameFile(lock.lockPath, lock.fileIdentity, lock.bytes)) return true;
    try {
      unlinkSync(lock.lockPath);
      return true;
    } catch {}
  }
  return false;
}

export function assertDeliveryIndexLock(lock) {
  if (!sameFile(lock.lockPath, lock.fileIdentity, lock.bytes)) throw locked();
}
