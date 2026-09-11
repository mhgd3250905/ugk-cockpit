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

// A live PID alone does not prove the owner is Cockpit, because operating
// systems recycle PIDs. Elapsed time proves even less: a healthy instance may
// run for weeks, and a clock jump or a suspended machine makes any deadline
// guess wrong. Stealing a lock from a running instance is far worse than
// refusing to start, so reclaiming requires positive evidence that the process
// now holding the PID is not the one that took the lock.
//
// Where the platform exposes a boot-relative process start time it can be
// compared exactly; where it does not, there is no reliable identity to compare
// and a live PID stays authoritative (the pre-existing behaviour). The lock
// additionally records the creator's own `performance.timeOrigin`: when the
// recorded pid equals this process's pid but the origin differs, this very
// process is the reuse — positive proof the original owner is gone, valid on
// every platform.
function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform !== 'linux') return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The command name may contain spaces and is wrapped in parentheses; the
    // start time is field 22, i.e. the 20th field after the closing paren.
    const rest = stat.slice(stat.lastIndexOf(')') + 1).trimStart();
    const starttime = rest.split(' ')[19];
    return starttime && /^\d+$/.test(starttime) ? starttime : null;
  } catch {
    return null;
  }
}

function ownProcessStartMs() {
  return Number.isFinite(performance.timeOrigin) ? Math.floor(performance.timeOrigin) : null;
}

// True only when the lock names this very pid AND a start instant different
// from ours — that combination proves the pid was recycled onto this process
// and the recorded owner cannot be alive.
function recordedOwnerIsOurRecycledPid(owner) {
  if (owner?.pid !== process.pid) return false;
  const recorded = owner?.processStartMs;
  const own = ownProcessStartMs();
  return typeof recorded === 'number' && own !== null && recorded !== own;
}

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

function ownerAlive(owner) {
  if (recordedOwnerIsOurRecycledPid(owner)) return false;
  if (!processExists(owner?.pid)) return false;
  // Reclaim only on a positive mismatch. An unknown identity on either side
  // leaves the lock in place.
  const current = processIdentity(owner.pid);
  const recorded = typeof owner.processIdentity === 'string' ? owner.processIdentity : null;
  if (current === null || recorded === null) return true;
  return current === recorded;
}

function instanceConflict(state, lockPath) {
  const conflict = new Error(state === 'running'
    ? `UGK Cockpit 已经在运行。锁文件：${lockPath}；确认没有运行中的实例后可删除它重试。`
    : `UGK Cockpit 正在启动。锁文件：${lockPath}。`);
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
    } else if (ownerAlive(owner)) {
      throw instanceConflict('running', lockPath);
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
        processIdentity: processIdentity(pid),
        processStartMs: pid === process.pid ? ownProcessStartMs() : null,
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
      if (owner && ownerAlive(owner)) throw instanceConflict('running', lockPath);
      if (!owner) {
        const age = fileAgeMs(lockPath);
        if (age === null) continue;
        if (age < INCOMPLETE_LOCK_GRACE_MS) throw instanceConflict('starting', lockPath);
      }
      // 死主或陈旧的锁文件：进入串行回收，然后重试创建。
      const reclaimed = reclaimStaleLock(lockPath, pid);
      if (reclaimed === 'busy') throw instanceConflict('starting', lockPath);
    }
  }
  throw instanceConflict('starting', lockPath);
}
