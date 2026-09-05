import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
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
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          try {
            closeSync(fd);
          } catch (error) {
            if (error?.code !== 'EBADF') throw error;
          }
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
      // 用原子 rename 把陈旧锁移走后再重建：两个并发获取者只有一个能
      // rename 成功，另一方在下一次尝试中重新观察现状，避免出现
      // “双方都删过对方新锁”的双实例竞态（release 使用同一所有权比对）。
      const stalePath = `${lockPath}.${ownerToken}.stale`;
      try {
        renameSync(lockPath, stalePath);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        continue;
      }
      try {
        unlinkSync(stalePath);
      } catch {}
      continue;
    }
  }
  // 只有并发获取者在两轮尝试中反复抢先时才会走到这里；
  // 给出带错误码的冲突结果而不是无码失败，调用方按“已有实例”处理。
  const conflict = new Error('UGK Cockpit 正在启动。');
  conflict.code = 'INSTANCE_ALREADY_RUNNING';
  throw conflict;
}
