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
const MAX_ACQUIRE_ATTEMPTS = 8;

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return { vanished: true };
    return null;
  }
}

function fileAgeMs(filePath) {
  try {
    return Date.now() - statSync(filePath).mtimeMs;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function instanceConflict(state) {
  const conflict = new Error(state === 'running'
    ? 'UGK Cockpit 已经在运行。'
    : 'UGK Cockpit 正在启动。');
  conflict.code = 'INSTANCE_ALREADY_RUNNING';
  return conflict;
}

// 陈旧锁的回收必须串行且有二次确认：O_EXCL 选举标记保证同一时刻只有一
// 个回收者；回收者赢得选举后重读死主再 rename，期间文件不可能被替换——
// 只有选举赢家有权移走锁文件，而普通创建者在锁文件存在期间无法创建。
// 没有这套约束时，多个进程可以同时读到死主并各自重建锁（双实例），迟到的
// rename 也可能把另一位竞争者刚创建的活锁偷走。
function reclaimStaleLock(lockPath, pid) {
  const markerPath = `${lockPath}.reclaim`;
  let markerFd;
  try {
    markerFd = openSync(markerPath, 'wx');
    writeFileSync(markerFd, JSON.stringify({ pid }), 'utf8');
    fsyncSync(markerFd);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const holder = readJsonFile(markerPath);
    if (holder?.vanished) return 'retry';
    if (!holder) {
      // 标记存在但没有可读内容：创建者可能恰在写入前中断。
      const age = fileAgeMs(markerPath);
      if (age !== null && age < INCOMPLETE_LOCK_GRACE_MS) return 'busy';
      try {
        unlinkSync(markerPath);
      } catch {}
      return 'retry';
    }
    if (processExists(holder.pid)) return 'busy';
    const age = fileAgeMs(markerPath);
    if (age !== null && age < INCOMPLETE_LOCK_GRACE_MS) return 'busy';
    // 回收者已死亡或标记陈旧：移除后由下一轮尝试重新选举。
    try {
      unlinkSync(markerPath);
    } catch {}
    return 'retry';
  } finally {
    if (markerFd !== undefined) {
      try {
        closeSync(markerFd);
      } catch (error) {
        if (error?.code !== 'EBADF') throw error;
      }
    }
  }

  try {
    // 赢得选举后重读：此刻不可能有其他回收者或直接创建者改动 lockPath。
    const owner = readJsonFile(lockPath);
    if (owner?.vanished) return 'retry';
    if (!owner) {
      const age = fileAgeMs(lockPath);
      if (age !== null && age < INCOMPLETE_LOCK_GRACE_MS) return 'busy';
    } else if (processExists(owner.pid)) {
      throw instanceConflict('running');
    }
    const stalePath = `${lockPath}.${randomUUID()}.stale`;
    try {
      renameSync(lockPath, stalePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      return 'retry';
    }
    try {
      unlinkSync(stalePath);
    } catch {}
    return 'retry';
  } finally {
    try {
      unlinkSync(markerPath);
    } catch {}
  }
}

export function acquireInstanceLock(lockPath, { pid = process.pid } = {}) {
  const ownerToken = randomUUID();
  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
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
      const owner = readJsonFile(lockPath);
      if (owner?.vanished) continue;
      if (owner && processExists(owner.pid)) throw instanceConflict('running');
      if (!owner) {
        const age = fileAgeMs(lockPath);
        if (age === null) continue;
        if (age < INCOMPLETE_LOCK_GRACE_MS) throw instanceConflict('starting');
      }
      // 死主或陈旧的锁文件：进入串行回收，然后重试创建。
      const reclaimed = reclaimStaleLock(lockPath, pid);
      if (reclaimed === 'busy') throw instanceConflict('starting');
    }
  }
  throw instanceConflict('starting');
}
