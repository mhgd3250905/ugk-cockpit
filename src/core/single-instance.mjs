import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';

const INCOMPLETE_LOCK_GRACE_MS = 5_000;

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export function acquireInstanceLock(lockPath, { pid = process.pid } = {}) {
  const ownerToken = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeFileSync(fd, JSON.stringify({
        pid,
        ownerToken,
        createdAt: new Date().toISOString(),
      }), 'utf8');
      fsyncSync(fd);
      return {
        release() {
          closeSync(fd);
          try {
            const current = JSON.parse(readFileSync(lockPath, 'utf8'));
            if (current.ownerToken === ownerToken) unlinkSync(lockPath);
          } catch (error) {
            if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
          }
        },
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let owner;
      try {
        owner = JSON.parse(readFileSync(lockPath, 'utf8'));
      } catch {
        owner = null;
      }
      if (!owner) {
        const ageMs = Date.now() - statSync(lockPath).mtimeMs;
        if (ageMs < INCOMPLETE_LOCK_GRACE_MS) {
          const conflict = new Error('UGK Cockpit 正在启动。');
          conflict.code = 'INSTANCE_ALREADY_RUNNING';
          throw conflict;
        }
      }
      if (owner && processExists(owner.pid)) {
        const conflict = new Error('UGK Cockpit 已经在运行。');
        conflict.code = 'INSTANCE_ALREADY_RUNNING';
        throw conflict;
      }
      unlinkSync(lockPath);
    }
  }
  throw new Error('Unable to acquire instance lock.');
}
