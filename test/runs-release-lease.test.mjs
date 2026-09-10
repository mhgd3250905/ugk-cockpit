// 孤儿写租约恢复：Agent 崩溃未 finish 后，用户可经工作台授权释放租约，
// 恢复该代码位置的开始/复用/移除。覆盖核心 fencing 语义与 HTTP 路由门禁。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { finishRun, releaseOrphanedWriteRun, startWriteRun } from '../src/core/runs.mjs';
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

  // fencing：revision 或 leaseGeneration 不匹配时拒绝释放。
  const stale = releaseOrphanedWriteRun(db, {
    commandId: 'release-stale',
    runId: 'run-crashed',
    expectedRevision: started.revision + 1,
    leaseGeneration: started.leaseGeneration,
  });
  assert.equal(stale.code, 'STALE_WRITE_LEASE');
  const staleGeneration = releaseOrphanedWriteRun(db, {
    commandId: 'release-stale-gen',
    runId: 'run-crashed',
    expectedRevision: started.revision,
    leaseGeneration: started.leaseGeneration + 1,
  });
  assert.equal(staleGeneration.code, 'STALE_WRITE_LEASE');

  // 正确 fencing：释放成功，run 终态、租约删除。
  const released = releaseOrphanedWriteRun(db, {
    commandId: 'release-orphan',
    runId: 'run-crashed',
    expectedRevision: started.revision,
    leaseGeneration: started.leaseGeneration,
  });
  assert.equal(released.ok, true);
  assert.equal(released.status, 'abandoned');
  assert.equal(db.prepare('SELECT count(*) AS n FROM write_leases').get().n, 0);
  assert.equal(
    db.prepare('SELECT lifecycle FROM runs WHERE id = ?').get('run-crashed').lifecycle,
    'abandoned',
  );

  // 同 commandId 重放返回已提交结果（幂等）。
  const replay = releaseOrphanedWriteRun(db, {
    commandId: 'release-orphan',
    runId: 'run-crashed',
    expectedRevision: started.revision,
    leaseGeneration: started.leaseGeneration,
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.runId, 'run-crashed');

  // 已终态的 run 不可再次释放。
  const again = releaseOrphanedWriteRun(db, {
    commandId: 'release-again',
    runId: 'run-crashed',
    expectedRevision: started.revision,
    leaseGeneration: started.leaseGeneration,
  });
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

  // 被释放的旧会话再想 finish，被 fencing 拒绝。
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
  db.close();
});

test('POST /api/v1/runs/release-lease：需用户确认；MCP token 不可调用', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-release-http-'));
  const apiToken = 'a'.repeat(32);
  const service = await createCockpitHttpServer({
    dbPath: path.join(root, 'cockpit.db'),
    token: apiToken,
    serveWebAsset: async () => false,
  });
  t.after(async () => {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  });

  // 预置一个崩溃残留的活跃租约（另一连接直写核心层，模拟崩溃现场）。
  const setupDb = openCockpitDatabase(path.join(root, 'cockpit.db'));
  const started = startWriteRun(setupDb, {
    commandId: 'setup-start',
    runId: 'setup-run',
    ...START,
    goal: 'crashed writer',
    baseline: baseline('a'),
  });
  assert.equal(started.ok, true);
  setupDb.close();

  const base = `http://127.0.0.1:${service.port}`;
  const releaseBody = {
    commandId: 'http-release',
    runId: 'setup-run',
    expectedRevision: started.revision,
    leaseGeneration: started.leaseGeneration,
  };

  // 未带用户确认 → 409，需要确认。
  const unconfirmed = await fetch(`${base}/api/v1/runs/release-lease`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(releaseBody),
  });
  assert.equal(unconfirmed.status, 409);
  assert.equal((await unconfirmed.json()).code, 'RUN_LEASE_CONFIRMATION_REQUIRED');

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

  // 本机持有者（bearer）+ 明确确认 → 释放成功。
  const confirmed = await fetch(`${base}/api/v1/runs/release-lease`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...releaseBody, userConfirmed: true }),
  });
  assert.equal(confirmed.status, 200);
  const released = await confirmed.json();
  assert.equal(released.ok, true);
  assert.equal(released.status, 'abandoned');

  // 释放后同一 run 的租约确实消失。
  const verifyDb = openCockpitDatabase(path.join(root, 'cockpit.db'));
  assert.equal(verifyDb.prepare('SELECT count(*) AS n FROM write_leases').get().n, 0);
  verifyDb.close();
});
