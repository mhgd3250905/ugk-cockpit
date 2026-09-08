import { randomUUID } from 'node:crypto';
import { closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

const protocol = 'ugk-cockpit-delivery-index-lock-v1';
const locked = () => Object.assign(new Error('The Git index is locked by another or unverified owner.'), { code: 'DELIVERY_INDEX_LOCKED' });
const identity = (stat) => `${stat.dev}:${stat.ino}`;

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
