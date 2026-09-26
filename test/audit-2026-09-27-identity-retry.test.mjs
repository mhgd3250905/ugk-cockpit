// 第 29 轮审计（2026-09-27）：schema v30 的旧指纹改写必须可重复执行并最终收敛。
// AGENTS.md 的工程规则写明「数据库迁移必须可重复执行」。v30 的逐行改写在某条路径
// 瞬时不可达（盘符抖动、共享断连、改名中途崩溃、git 暂时缺失、敌意配置事后被清除）时
// 仍会把 user_version 盖章为已迁移：该行永久留在旧格式，只能靠人工确认位置；同时
// 每次开库都会重新探测那些已经判定为「不可改写」的真漂移行。
// 本轮要求：失败按行留痕、后续开库重试留痕行、已判定行不再重复探测。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openCockpitDatabase, SUPPORTED_SCHEMA_VERSION } from '../src/core/database.mjs';
import { probeGitWorktree } from '../src/git/probe.mjs';
import { registerProject, refreshProject } from '../src/core/projects.mjs';
import { statIdentityPair } from '../src/core/identity-migration.mjs';

function runCleanupLifo(cleanup) {
  return async () => {
    let firstError = null;
    for (let index = cleanup.length - 1; index >= 0; index -= 1) {
      try {
        await cleanup[index]();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
  };
}

function realTemp(cleanup, prefix) {
  const root = realpathSync(mkdtempSync(path.join(realpathSync(os.tmpdir()), prefix)));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function gitSync(cwd, args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function initGit(root) {
  mkdirSync(root, { recursive: true });
  gitSync(root, ['init', '-q', '-b', 'main']);
  gitSync(root, ['-c', 'user.email=fixture@example.com', '-c', 'user.name=fixture', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return root;
}

// Windows 上刚退出的 git 子进程可能暂时占住目录句柄，改名会瞬时 EPERM。
function renameWithRetry(from, to, attempts = 20) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== 'EPERM' && error?.code !== 'EBUSY' && error?.code !== 'ENOTEMPTY') throw error;
      const waitUntil = Date.now() + 50;
      while (Date.now() < waitUntil) { /* bounded spin, no timer handle */ }
    }
  }
  throw lastError;
}

// 以 schema 29 库存的身份形态建档：指纹含 device，版本号与迁移台账一起回拨。
function stampLegacyIdentities(db, { canonicalPath, worktreeHash, repositoryHash, projectId }) {
  db.prepare('UPDATE worktrees SET identity_fingerprint = ?, repository_identity = ? WHERE canonical_path = ?')
    .run(worktreeHash, repositoryHash, canonicalPath);
  if (projectId) {
    db.prepare('UPDATE projects SET repository_identity = ? WHERE id = ?').run(repositoryHash, projectId);
  }
  db.prepare('DELETE FROM schema_migrations WHERE version >= 30').run();
  db.exec('PRAGMA user_version = 29');
}

function legacyHashesOf(repo) {
  return {
    directory: statIdentityPair(repo).legacy,
    common: statIdentityPair(path.join(repo, '.git')).legacy,
  };
}

async function identities(db, canonicalPath) {
  const row = db.prepare('SELECT identity_fingerprint AS w, repository_identity AS r FROM worktrees WHERE canonical_path = ?')
    .get(canonicalPath);
  return row ? { w: row.w, r: row.r } : null;
}

test('a worktree unreachable during the v30 rewrite converges once its path returns', async (t) => {
  const cleanup = [];
  t.after(runCleanupLifo(cleanup));
  const container = realTemp(cleanup, 'ugk-v30-transient-');
  const repo = initGit(path.join(container, 'repository'));
  const dbPath = path.join(container, 'data', 'cockpit.db');

  let db = openCockpitDatabase(dbPath);
  cleanup.push(() => { try { db.close(); } catch { /* 已显式关闭 */ } });
  const probe = await probeGitWorktree(repo);
  const registered = registerProject(db, { commandId: 'reg-transient', name: 'Transient', observation: probe });
  const legacy = legacyHashesOf(repo);
  stampLegacyIdentities(db, {
    canonicalPath: probe.canonicalPath,
    worktreeHash: legacy.directory,
    repositoryHash: legacy.common,
    projectId: registered.projectId,
  });
  db.close();

  // 迁移发生的那一刻这条路径恰好不可见。
  const hidden = path.join(container, 'repository.offline');
  renameWithRetry(repo, hidden);

  db = openCockpitDatabase(dbPath);
  assert.equal(
    Number(db.prepare('PRAGMA user_version').get().user_version),
    SUPPORTED_SCHEMA_VERSION,
    '一行不可达不能让服务起不来',
  );
  assert.deepEqual(
    await identities(db, probe.canonicalPath),
    { w: legacy.directory, r: legacy.common },
    '不可达的行改不了，必须保持 fail-closed',
  );
  db.close();

  // 路径恢复：同一目录、同一 inode 与创建时间，只是重新可见。
  renameWithRetry(hidden, repo);
  assert.equal(statIdentityPair(repo).legacy, legacy.directory, '恢复后的目录正是该行描述的那个目录');

  db = openCockpitDatabase(dbPath);
  const live = await probeGitWorktree(repo);
  assert.deepEqual(
    await identities(db, probe.canonicalPath),
    { w: live.worktreeIdentity, r: live.repositoryIdentity },
    '后来的开库必须补完被瞬时失败打断的改写',
  );
  assert.equal(
    db.prepare('SELECT repository_identity AS v FROM projects WHERE id = ?').get(registered.projectId).v,
    live.repositoryIdentity,
    '项目绑定要跟工作副本行一起收敛',
  );

  const refreshed = refreshProject(db, { commandId: 'refresh-transient', projectId: registered.projectId, observation: live });
  assert.equal(refreshed.ok, true, `恢复后的行不得再要求人工确认位置: ${JSON.stringify(refreshed)}`);
  db.close();
});

test('a hostile configuration removed later converges the row instead of stranding it', async (t) => {
  const cleanup = [];
  t.after(runCleanupLifo(cleanup));
  const container = realTemp(cleanup, 'ugk-v30-hostile-retry-');
  const repo = initGit(path.join(container, 'repository'));
  const dbPath = path.join(container, 'data', 'cockpit.db');

  let db = openCockpitDatabase(dbPath);
  cleanup.push(() => { try { db.close(); } catch { /* 已显式关闭 */ } });
  const probe = await probeGitWorktree(repo);
  const registered = registerProject(db, { commandId: 'reg-hostile', name: 'Hostile', observation: probe });
  const legacy = legacyHashesOf(repo);
  stampLegacyIdentities(db, {
    canonicalPath: probe.canonicalPath,
    worktreeHash: legacy.directory,
    repositoryHash: legacy.common,
    projectId: registered.projectId,
  });
  db.close();

  // 敌意仓库永远不允许被迁移探测（既有安全契约），因此这一次开库什么也不改。
  gitSync(repo, ['config', '--local', 'filter.evil.clean', 'touch /tmp/ugk-pwned']);
  db = openCockpitDatabase(dbPath);
  assert.deepEqual(
    await identities(db, probe.canonicalPath),
    { w: legacy.directory, r: legacy.common },
    '敌意配置下不得探测、不得改写',
  );
  db.close();

  // 用户清掉了敌意配置：这一行现在是可以收敛的。
  gitSync(repo, ['config', '--local', '--unset', 'filter.evil.clean']);
  db = openCockpitDatabase(dbPath);
  const live = await probeGitWorktree(repo);
  assert.deepEqual(
    await identities(db, probe.canonicalPath),
    { w: live.worktreeIdentity, r: live.repositoryIdentity },
    '敌意配置被清除后必须自行收敛，而不是永久留在旧格式',
  );
  db.close();
});

test('a genuinely drifted row is judged once and never re-probed by later opens', async (t) => {
  const cleanup = [];
  t.after(runCleanupLifo(cleanup));
  const container = realTemp(cleanup, 'ugk-v30-drift-');
  const repo = initGit(path.join(container, 'repository'));
  const dbPath = path.join(container, 'data', 'cockpit.db');

  let db = openCockpitDatabase(dbPath);
  cleanup.push(() => { try { db.close(); } catch { /* 已显式关闭 */ } });
  const probe = await probeGitWorktree(repo);
  const registered = registerProject(db, { commandId: 'reg-drift', name: 'Drift', observation: probe });
  const legacy = legacyHashesOf(repo);
  // 旧 device 已不可知：任何重算都不可能命中，诚实的结论是「保持原样，走人工确认」。
  const driftedDirectory = `${legacy.directory.slice(0, 56)}deadbeef`;
  const driftedCommon = `${legacy.common.slice(0, 56)}cafebabe`;
  stampLegacyIdentities(db, {
    canonicalPath: probe.canonicalPath,
    worktreeHash: driftedDirectory,
    repositoryHash: driftedCommon,
  });
  db.close();

  db = openCockpitDatabase(dbPath);
  assert.deepEqual(
    await identities(db, probe.canonicalPath),
    { w: driftedDirectory, r: driftedCommon },
    '无法重算的哈希绝不能被猜掉',
  );
  const { identityMigrationBacklog } = await import('../src/core/identity-migration.mjs');
  assert.equal(
    typeof identityMigrationBacklog,
    'function',
    '留痕台账是本轮契约的一部分',
  );
  assert.deepEqual(
    identityMigrationBacklog(db).filter((entry) => entry.canonicalPath === probe.canonicalPath),
    [],
    '已成功判定过的行不得进入重试队列，避免每次开库重复 git 探测',
  );

  const blocked = refreshProject(db, { commandId: 'refresh-drift', projectId: registered.projectId, observation: probe });
  assert.equal(blocked.ok, false, '真漂移仍保留人工确认出路');
  assert.equal(blocked.code, 'WORKTREE_IDENTITY_CHANGED');
  db.close();
});

test('a settled row is skipped outright, not re-probed, on later opens', async (t) => {
  const cleanup = [];
  t.after(runCleanupLifo(cleanup));
  const container = realTemp(cleanup, 'ugk-v30-settled-');
  const repo = initGit(path.join(container, 'repository'));
  const dbPath = path.join(container, 'data', 'cockpit.db');
  const { identityMigrationBacklog } = await import('../src/core/identity-migration.mjs');

  let db = openCockpitDatabase(dbPath);
  cleanup.push(() => { try { db.close(); } catch { /* 已显式关闭 */ } });
  const probe = await probeGitWorktree(repo);
  registerProject(db, { commandId: 'reg-settled', name: 'Settled', observation: probe });
  const legacy = legacyHashesOf(repo);
  stampLegacyIdentities(db, {
    canonicalPath: probe.canonicalPath,
    worktreeHash: `${legacy.directory.slice(0, 56)}0000beef`,
    repositoryHash: `${legacy.common.slice(0, 56)}1111cafe`,
  });
  db.close();

  // 第一次开库判定这一行「无法重算」，写入 settled。
  db = openCockpitDatabase(dbPath);
  assert.deepEqual(
    identityMigrationBacklog(db).filter((entry) => entry.canonicalPath === probe.canonicalPath),
    [],
    '判定成功的行不得留在重试台账',
  );
  db.close();

  // 观察缝隙：真漂移行原本每次开库都要过一次敌意配置闸门。事后给仓库加上敌意
  // 配置，如果实现仍去重新判定这一行，闸门会抛错并把行送回 retry 台账；跳过它
  // 才说明「已判定」真的省掉了重复探测。
  gitSync(repo, ['config', '--local', 'filter.evil.clean', 'touch /tmp/ugk-pwned']);
  db = openCockpitDatabase(dbPath);
  assert.deepEqual(
    identityMigrationBacklog(db).filter((entry) => entry.canonicalPath === probe.canonicalPath),
    [],
    '已判定过的行必须被直接跳过，不能再吃一次 git 探测',
  );
  assert.deepEqual(
    await identities(db, probe.canonicalPath),
    { w: `${legacy.directory.slice(0, 56)}0000beef`, r: `${legacy.common.slice(0, 56)}1111cafe` },
    '跳过判定不得改变任何库存值',
  );
  db.close();
});

test('the retry backlog is bounded: converged rows leave it and stale paths are pruned', async (t) => {
  const cleanup = [];
  t.after(runCleanupLifo(cleanup));
  const container = realTemp(cleanup, 'ugk-v30-backlog-');
  const repoA = initGit(path.join(container, 'alpha'));
  const repoB = initGit(path.join(container, 'beta'));
  const dbPath = path.join(container, 'data', 'cockpit.db');

  let db = openCockpitDatabase(dbPath);
  cleanup.push(() => { try { db.close(); } catch { /* 已显式关闭 */ } });
  const probeA = await probeGitWorktree(repoA);
  const probeB = await probeGitWorktree(repoB);
  const legacyA = legacyHashesOf(repoA);
  const legacyB = legacyHashesOf(repoB);
  const registeredA = registerProject(db, { commandId: 'reg-backlog-a', name: 'Alpha', observation: probeA });
  registerProject(db, { commandId: 'reg-backlog-b', name: 'Beta', observation: probeB });
  stampLegacyIdentities(db, {
    canonicalPath: probeA.canonicalPath, worktreeHash: legacyA.directory, repositoryHash: legacyA.common,
    projectId: registeredA.projectId,
  });
  db.prepare('UPDATE worktrees SET identity_fingerprint = ?, repository_identity = ? WHERE canonical_path = ?')
    .run(legacyB.directory, legacyB.common, probeB.canonicalPath);
  db.close();

  // 两行同时不可达：都应当被留痕，而不是静默丢弃。
  const hiddenA = path.join(container, 'alpha.offline');
  const hiddenB = path.join(container, 'beta.offline');
  renameWithRetry(repoA, hiddenA);
  renameWithRetry(repoB, hiddenB);
  db = openCockpitDatabase(dbPath);
  const { identityMigrationBacklog } = await import('../src/core/identity-migration.mjs');
  assert.equal(typeof identityMigrationBacklog, 'function', '留痕台账是本轮契约的一部分');
  const firstBacklog = identityMigrationBacklog(db);
  assert.deepEqual(
    firstBacklog.map((entry) => entry.canonicalPath).sort(),
    [probeA.canonicalPath, probeB.canonicalPath].sort(),
    '两条失败行都要留痕',
  );
  db.close();

  // 只恢复其中一条：收敛的那条必须离开队列，未恢复的那条继续留痕。
  renameWithRetry(hiddenA, repoA);
  db = openCockpitDatabase(dbPath);
  const liveA = await probeGitWorktree(repoA);
  assert.deepEqual(
    await identities(db, probeA.canonicalPath),
    { w: liveA.worktreeIdentity, r: liveA.repositoryIdentity },
    '恢复的那条要在本次开库收敛',
  );
  const afterA = identityMigrationBacklog(db);
  assert.deepEqual(
    afterA.map((entry) => entry.canonicalPath),
    [probeB.canonicalPath],
    '收敛后要出队，未恢复的继续留痕',
  );

  // 工作副本行被删除后，它的留痕也必须一起清掉（不得无界增长）。
  db.prepare('DELETE FROM project_observations WHERE project_id IN (SELECT id FROM projects WHERE worktree_id IN (SELECT id FROM worktrees WHERE canonical_path = ?))').run(probeB.canonicalPath);
  db.prepare('DELETE FROM projects WHERE worktree_id IN (SELECT id FROM worktrees WHERE canonical_path = ?)').run(probeB.canonicalPath);
  db.prepare('DELETE FROM worktrees WHERE canonical_path = ?').run(probeB.canonicalPath);
  db.close();
  db = openCockpitDatabase(dbPath);
  assert.deepEqual(
    identityMigrationBacklog(db),
    [],
    '路径已不属于任何工作副本时，留痕不得继续累积',
  );
  db.close();
});

test('rows skipped for budget stay owed and remain visible', async (t) => {
  const cleanup = [];
  t.after(runCleanupLifo(cleanup));
  const container = realTemp(cleanup, 'ugk-v30-budget-');
  const repoA = initGit(path.join(container, 'alpha'));
  const repoB = initGit(path.join(container, 'beta'));
  const dbPath = path.join(container, 'data', 'cockpit.db');

  let db = openCockpitDatabase(dbPath);
  cleanup.push(() => { try { db.close(); } catch { /* 已显式关闭 */ } });
  const probeA = await probeGitWorktree(repoA);
  const probeB = await probeGitWorktree(repoB);
  const legacyA = legacyHashesOf(repoA);
  const legacyB = legacyHashesOf(repoB);
  registerProject(db, { commandId: 'reg-budget-a', name: 'Alpha', observation: probeA });
  registerProject(db, { commandId: 'reg-budget-b', name: 'Beta', observation: probeB });
  stampLegacyIdentities(db, { canonicalPath: probeA.canonicalPath, worktreeHash: legacyA.directory, repositoryHash: legacyA.common });
  db.prepare('UPDATE worktrees SET identity_fingerprint = ?, repository_identity = ? WHERE canonical_path = ?')
    .run(legacyB.directory, legacyB.common, probeB.canonicalPath);
  db.close();

  renameWithRetry(repoA, path.join(container, 'alpha.offline'));
  renameWithRetry(repoB, path.join(container, 'beta.offline'));
  db = openCockpitDatabase(dbPath);
  const { identityMigrationBacklog, identityRewriteOwed, migrateLegacyFileIdentities } =
    await import('../src/core/identity-migration.mjs');
  const first = identityMigrationBacklog(db);
  assert.deepEqual(first.map((entry) => entry.canonicalPath).sort(),
    [probeA.canonicalPath, probeB.canonicalPath].sort(), '两条失败行都要留痕');
  const attemptsBefore = Object.fromEntries(first.map((entry) => [entry.canonicalPath, entry.attempts]));
  assert.equal(identityRewriteOwed(db), true, '仍欠工作时必须判定为 owed');

  // 预算为 0：仍要尝试一行（否则永不前进），其余行必须留在台账里而不是被当作已收敛。
  const pass = migrateLegacyFileIdentities(db, { budgetMs: 0, persistFailures: true });
  assert.equal(pass.deferred >= 1, true, JSON.stringify(pass));
  assert.equal(pass.owed >= 1, true, JSON.stringify(pass));
  const after = Object.fromEntries(identityMigrationBacklog(db).map((entry) => [entry.canonicalPath, entry]));
  assert.equal(Object.keys(after).length, 2, '被跳过的行不得从台账里消失');
  for (const canonicalPath of [probeA.canonicalPath, probeB.canonicalPath]) {
    assert.ok(after[canonicalPath], `${canonicalPath} 仍在台账`);
    // 尝试次数只在真实尝试后增长：预算跳过不得伪造进度。
    assert.ok(after[canonicalPath].attempts >= attemptsBefore[canonicalPath], JSON.stringify(after[canonicalPath]));
  }
  assert.ok(
    Object.values(after).some((entry) => entry.reason === 'ENOENT' || entry.reason === 'EPERM'),
    `失败原因必须保留，不能被 deferred 覆盖: ${JSON.stringify(Object.values(after).map((entry) => entry.reason))}`,
  );
  db.close();
});

test('a converged stock has nothing owed, so an open needs no write transaction', async (t) => {
  const cleanup = [];
  t.after(runCleanupLifo(cleanup));
  const container = realTemp(cleanup, 'ugk-v30-converged-');
  const repo = initGit(path.join(container, 'repository'));
  const dbPath = path.join(container, 'data', 'cockpit.db');
  const { identityRewriteOwed } = await import('../src/core/identity-migration.mjs');

  let db = openCockpitDatabase(dbPath);
  cleanup.push(() => { try { db.close(); } catch { /* 已显式关闭 */ } });
  const probe = await probeGitWorktree(repo);
  registerProject(db, { commandId: 'reg-converged', name: 'Converged', observation: probe });
  assert.equal(identityRewriteOwed(db), true, '未判定过的行仍然是欠的，哪怕格式已经正确');
  db.close();
  // 第一次开库完成判定并写台账之后，才算「什么都不欠」。
  db = openCockpitDatabase(dbPath);
  assert.equal(identityRewriteOwed(db), false, '全部 settled 后不该再欠任何工作');
  db.close();

  // 另一个连接持写事务时，开库仍必须成功，而且不能靠「抢锁失败被吞掉」来成功：
  // 断言没有产生收敛告警，才证明这条路径根本没去抢写锁。
  const holder = new DatabaseSync(dbPath);
  cleanup.push(() => { try { holder.close(); } catch { /* 已关闭 */ } });
  holder.exec('BEGIN IMMEDIATE');
  const written = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => { written.push(String(chunk)); return true; };
  let opened;
  try {
    opened = openCockpitDatabase(dbPath);
  } finally {
    process.stderr.write = originalWrite;
    holder.exec('ROLLBACK');
  }
  cleanup.push(() => { try { opened.close(); } catch { /* 已关闭 */ } });
  assert.equal(Number(opened.prepare('PRAGMA user_version').get().user_version), SUPPORTED_SCHEMA_VERSION);
  assert.deepEqual(
    written.filter((line) => line.includes('identity reconcile deferred')),
    [],
    `已收敛的开库不应尝试收敛（更不应靠吞掉抢锁失败来成功）: ${JSON.stringify(written)}`,
  );
});

test('a broken ledger table cannot prevent the service from opening', async (t) => {
  const cleanup = [];
  t.after(runCleanupLifo(cleanup));
  const container = realTemp(cleanup, 'ugk-v30-broken-ledger-');
  const repo = initGit(path.join(container, 'repository'));
  const dbPath = path.join(container, 'data', 'cockpit.db');

  let db = openCockpitDatabase(dbPath);
  cleanup.push(() => { try { db.close(); } catch { /* 已显式关闭 */ } });
  const probe = await probeGitWorktree(repo);
  registerProject(db, { commandId: 'reg-broken', name: 'Broken', observation: probe });
  db.exec('DROP TABLE identity_migration_state');
  db.exec('CREATE TABLE identity_migration_state (canonical_path TEXT PRIMARY KEY) STRICT');
  db.close();

  db = openCockpitDatabase(dbPath);
  cleanup.push(() => { try { db.close(); } catch { /* 已显式关闭 */ } });
  assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), SUPPORTED_SCHEMA_VERSION);
  assert.deepEqual(
    await identities(db, probe.canonicalPath),
    { w: probe.worktreeIdentity, r: probe.repositoryIdentity },
    '台账坏了也不能改动已收敛的身份值',
  );
});
