// 孤儿写租约恢复：Agent 崩溃未 finish 后，用户可经工作台授权释放租约，
// 恢复该代码位置的开始/复用/移除。覆盖核心 fencing/确认日志/崩溃重放语义
// 与 HTTP 路由门禁（路径授权、确认要求、MCP token 拒绝）。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCockpitDatabase } from '../src/core/database.mjs';
import {
  finishRun,
  heartbeatWriteRun,
  releaseOrphanedWriteRun,
  startWriteRun,
} from '../src/core/runs.mjs';
import { createCockpitHttpServer } from '../src/service/http-server.mjs';

function baseline(marker) {
  return {
    head: marker.repeat(40),
    branch: 'main',
    indexFingerprint: `index-${marker}`,
    worktreeFingerprint: `tree-${marker}`,
    coherence: 'coherent',
  };
}

const START = {
  worktreeId: 'worktree-release',
  canonicalPath: 'E:\\fixture\\release',
  repositoryIdentity: 'repo-release',
  agentClaim: 'codex',
};

function releaseRequest(overrides = {}) {
  return {
    commandId: 'release-orphan',
    runId: 'run-crashed',
    expectedRevision: 1,
    leaseGeneration: 1,
    userConfirmed: true,
    ...overrides,
  };
}

test('releaseOrphanedWriteRun：崩溃后释放租约并解除阻塞，fencing 与幂等成立', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-release-core-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openCockpitDatabase(path.join(root, 'cockpit.db'));

  const started = startWriteRun(db, {
    commandId: 'start-crashed',
    runId: 'run-crashed',
    ...START,
    goal: 'writer dies without finishing',
    baseline: baseline('a'),
  });
  assert.equal(started.ok, true);

  // 崩溃：不 finish。新会话被拒。
  const conflict = startWriteRun(db, {
    commandId: 'start-next',
    runId: 'run-next',
    ...START,
    goal: 'continue after crash',
    baseline: baseline('b'),
  });
  assert.equal(conflict.code, 'WRITE_LEASE_CONFLICT');

  // 未确认的释放被拒绝，且拒绝本身落入命令日志（审计留痕），租约保持原状。
  const unconfirmed = releaseOrphanedWriteRun(db, releaseRequest({
    commandId: 'release-unconfirmed',
    userConfirmed: undefined,
  }));
  assert.equal(unconfirmed.ok, false);
  assert.equal(unconfirmed.code, 'RUN_LEASE_CONFIRMATION_REQUIRED');
  assert.equal(db.prepare('SELECT count(*) AS n FROM write_leases').get().n, 1);
  assert.equal(
    db.prepare("SELECT state FROM commands WHERE id = 'release-unconfirmed'").get().state,
    'failed',
  );

  // fencing：revision 或 leaseGeneration 不匹配时拒绝释放。
  const stale = releaseOrphanedWriteRun(db, releaseRequest({
    commandId: 'release-stale',
    expectedRevision: started.revision + 1,
  }));
  assert.equal(stale.code, 'STALE_WRITE_LEASE');
  const staleGeneration = releaseOrphanedWriteRun(db, releaseRequest({
    commandId: 'release-stale-gen',
    leaseGeneration: started.leaseGeneration + 1,
  }));
  assert.equal(staleGeneration.code, 'STALE_WRITE_LEASE');

  // 正确 fencing + 用户确认：释放成功，run 终态、租约删除。
  const released = releaseOrphanedWriteRun(db, releaseRequest());
  assert.equal(released.ok, true);
  assert.equal(released.status, 'abandoned');
  assert.equal(db.prepare('SELECT count(*) AS n FROM write_leases').get().n, 0);
  assert.equal(
    db.prepare('SELECT lifecycle FROM runs WHERE id = ?').get('run-crashed').lifecycle,
    'abandoned',
  );

  // 同 commandId 重放返回已提交结果（幂等）。
  const replay = releaseOrphanedWriteRun(db, releaseRequest());
  assert.equal(replay.ok, true);
  assert.equal(replay.runId, 'run-crashed');

  // 已终态的 run 不可再次释放。
  const again = releaseOrphanedWriteRun(db, releaseRequest({ commandId: 'release-again' }));
  assert.equal(again.code, 'RUN_NOT_FOUND');

  // 阻塞解除：新会话（新 commandId）可以开始工作。
  const resumed = startWriteRun(db, {
    commandId: 'start-after-release',
    runId: 'run-next',
    ...START,
    goal: 'continue after crash',
    baseline: baseline('b'),
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.leaseGeneration, started.leaseGeneration + 1);

  // 崩溃期间失败的命令重放仍返回原失败结果（命令日志语义未变）。
  const journalReplay = startWriteRun(db, {
    commandId: 'start-next',
    runId: 'run-next',
    ...START,
    goal: 'continue after crash',
    baseline: baseline('b'),
  });
  assert.equal(journalReplay.code, 'WRITE_LEASE_CONFLICT');

  // 被释放的旧会话再想 finish / heartbeat，都被 fencing 拒绝。
  const oldFinish = finishRun(db, {
    commandId: 'finish-crashed',
    runId: 'run-crashed',
    expectedRevision: started.revision,
    leaseGeneration: started.leaseGeneration,
    outcome: 'completed',
    summary: 'must stay fenced',
    finalSnapshot: { ...baseline('c'), repositoryIdentity: START.repositoryIdentity, worktreeIdentity: START.worktreeId },
  });
  assert.equal(oldFinish.code, 'STALE_WRITE_LEASE');
  const oldHeartbeat = heartbeatWriteRun(db, {
    commandId: 'heartbeat-crashed',
    runId: 'run-crashed',
    expectedRevision: started.revision,
    leaseGeneration: started.leaseGeneration,
  });
  assert.equal(oldHeartbeat.code, 'STALE_WRITE_LEASE');
  db.close();
});

test('releaseOrphanedWriteRun：崩溃窗口内租约不丢失，同一命令可安全重放', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-release-crash-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openCockpitDatabase(path.join(root, 'cockpit.db'));

  const started = startWriteRun(db, {
    commandId: 'start-crash-test',
    runId: 'run-crash-test',
    ...START,
    goal: 'crash window',
    baseline: baseline('a'),
  });
  assert.equal(started.ok, true);

  // 在 run CAS 已写入、租约未删除的瞬间进程终止：整个事务回滚。
  assert.throws(
    () => releaseOrphanedWriteRun(db, releaseRequest({
      commandId: 'release-crash',
      runId: 'run-crash-test',
    }), {
      faultInjector(point) {
        if (point === 'release.after_run_cas') throw new Error('process dies here');
      },
    }),
    /process dies here/,
  );
  assert.equal(
    db.prepare('SELECT lifecycle FROM runs WHERE id = ?').get('run-crash-test').lifecycle,
    'active',
  );
  assert.equal(db.prepare('SELECT count(*) AS n FROM write_leases').get().n, 1);

  // 同一命令重放（无故障）完整成功，不产生半释放状态。
  const replayed = releaseOrphanedWriteRun(db, releaseRequest({
    commandId: 'release-crash',
    runId: 'run-crash-test',
  }));
  assert.equal(replayed.ok, true);
  assert.equal(db.prepare('SELECT count(*) AS n FROM write_leases').get().n, 0);
  db.close();
});

test('POST /api/v1/runs/release-lease：路径授权、用户确认、fencing 与 MCP 拒绝', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-release-http-'));
  const fixtureRoot = path.join(root, 'projects');
  const worktreeDir = path.join(fixtureRoot, 'wt-a');
  mkdirSync(worktreeDir, { recursive: true });
  const apiToken = 'a'.repeat(32);
  const service = await createCockpitHttpServer({
    dbPath: path.join(root, 'cockpit.db'),
    token: apiToken,
    authorizedRoots: [fixtureRoot],
    serveWebAsset: async () => false,
  });
  t.after(async () => {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  });

  // 预置两个崩溃残留：A 在授权根内，B 在授权根外。
  const setupDb = openCockpitDatabase(path.join(root, 'cockpit.db'));
  const inside = startWriteRun(setupDb, {
    commandId: 'setup-inside',
    runId: 'run-inside',
    ...START,
    canonicalPath: worktreeDir,
    goal: 'crashed writer inside root',
    baseline: baseline('a'),
  });
  assert.equal(inside.ok, true);
  const outside = startWriteRun(setupDb, {
    commandId: 'setup-outside',
    runId: 'run-outside',
    ...START,
    worktreeId: 'worktree-outside',
    canonicalPath: 'E:\\fixture\\outside-root',
    repositoryIdentity: 'repo-outside',
    goal: 'crashed writer outside root',
    baseline: baseline('a'),
  });
  assert.equal(outside.ok, true);
  setupDb.close();

  const base = `http://127.0.0.1:${service.port}`;
  const releaseBody = {
    commandId: 'http-release',
    runId: 'run-inside',
    expectedRevision: inside.revision,
    leaseGeneration: inside.leaseGeneration,
  };

  // 未带用户确认 → 409，需要确认（由核心层落命令日志）。
  const unconfirmed = await fetch(`${base}/api/v1/runs/release-lease`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(releaseBody),
  });
  assert.equal(unconfirmed.status, 409);
  assert.equal((await unconfirmed.json()).code, 'RUN_LEASE_CONFIRMATION_REQUIRED');

  // 非法 body → 400。
  const invalid = await fetch(`${base}/api/v1/runs/release-lease`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...releaseBody, userConfirmed: true, expectedRevision: 0 }),
  });
  assert.equal(invalid.status, 400);

  // MCP scoped token 不可释放租约（路由不在 /api/v1/mcp/ 命名空间）。
  const bootstrap = await fetch(`${base}/api/v1/mcp/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client: 'ugk-cockpit-stdio' }),
  });
  assert.equal(bootstrap.status, 201);
  const { token: scopedToken } = await bootstrap.json();
  const mcpDenied = await fetch(`${base}/api/v1/runs/release-lease`, {
    method: 'POST',
    headers: { authorization: `Bearer ${scopedToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...releaseBody, userConfirmed: true }),
  });
  assert.equal(mcpDenied.status, 401);

  // 授权根之外的租约不可释放（跨主体滥用面回归测试）。
  const outsideAttempt = await fetch(`${base}/api/v1/runs/release-lease`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      commandId: 'http-release-outside',
      runId: 'run-outside',
      expectedRevision: outside.revision,
      leaseGeneration: outside.leaseGeneration,
      userConfirmed: true,
    }),
  });
  assert.equal(outsideAttempt.status, 403);
  assert.equal((await outsideAttempt.json()).code, 'PATH_NOT_AUTHORIZED');

  // fencing 不匹配 → 409 STALE_WRITE_LEASE。
  const stale = await fetch(`${base}/api/v1/runs/release-lease`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      ...releaseBody,
      commandId: 'http-release-stale',
      userConfirmed: true,
      expectedRevision: inside.revision + 5,
    }),
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, 'STALE_WRITE_LEASE');

  // 本机持有者（bearer）+ 明确确认 + 授权根内 → 释放成功。
  // （确认后的重试是新的操作请求，使用新的 commandId；同 commandId 重放
  // 会返回首次的未确认失败结果，这是命令日志的既有语义。）
  const confirmed = await fetch(`${base}/api/v1/runs/release-lease`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...releaseBody, commandId: 'http-release-confirmed', userConfirmed: true }),
  });
  assert.equal(confirmed.status, 200);
  const released = await confirmed.json();
  assert.equal(released.ok, true);
  assert.equal(released.status, 'abandoned');

  // 释放后 run-inside 的租约消失，run-outside 的租约不受影响。
  const verifyDb = openCockpitDatabase(path.join(root, 'cockpit.db'));
  assert.equal(
    verifyDb.prepare('SELECT count(*) AS n FROM write_leases WHERE run_id = ?').get('run-inside').n,
    0,
  );
  assert.equal(
    verifyDb.prepare('SELECT count(*) AS n FROM write_leases WHERE run_id = ?').get('run-outside').n,
    1,
  );
  verifyDb.close();
});
