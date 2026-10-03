// 第 36 轮审计（2026-10-04）· 已了结命令的重放必须按流水里的历史事实判定。
//
// `POST /api/v1/projects` 的重放分支要核对「当年这个 commandId 注册的是哪个项目」。
// 它原先把这件事问给了**活的**授权表：`basename(activeFolderGrants.read(grantId))`。
// 而 `pruneSpentFolderGrants` 会在下次开库时删掉超过保留期的 consumed 行，行没了
// 这个表达式就成了 ''，与冻结的派生名不相等 → 同一份载荷的重放被判
// COMMAND_CONFLICT（回执原文「这个操作编号已经用于另一项操作」，并要用户换个新编号
// 重做一遍已经成功的项目添加）。相邻的 confirm-location 分支只比对冻结字段，注释还
// 写着「same rule as confirm-location」——规则对、实现不对。
//
// 判据按两个方向钉：被清掉行的同号重放必须回到 200；载荷真的变了必须仍然 409
// （否则这条修复把幂等保护本身削掉了）。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { pruneSpentFolderGrants } from '../src/core/database.mjs';
import { createCockpitHttpServer } from '../src/service/http-server.mjs';

const TOKEN = 'register-replay-token-long-enough-for-the-service';
const DAY_MS = 24 * 3600_000;

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function harness(t) {
  const container = realpathSync(mkdtempSync(path.join(realpathSync(os.tmpdir()), 'ugk-register-replay-')));
  const folder = path.join(container, 'my-project');
  mkdirSync(folder);
  git(folder, ['init', '-q']);
  writeFileSync(path.join(folder, 'tracked.txt'), 'seed\n');
  git(folder, ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'add', 'tracked.txt']);
  git(folder, ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-q', '-m', 'fixture']);
  const dbPath = path.join(container, 'cockpit.db');
  const service = await createCockpitHttpServer({
    dbPath, token: TOKEN, folderPicker: async () => folder,
  });
  // Windows: the SQLite handle must close before the directory can be removed,
  // and the service has to stop before the handle. One hook, ordered by hand.
  t.after(async () => {
    await service.close();
    rmSync(container, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  const call = async (body) => {
    const response = await fetch(`http://${service.host}:${service.port}/api/v1/projects`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const newGrant = async () => {
    const response = await fetch(`http://${service.host}:${service.port}/api/v1/folders/select`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: '{}',
    });
    const selected = await response.json();
    return selected.grantId;
  };
  // Ages out and sweeps the grant rows through a second handle, which is what a
  // service restart does on open (`pruneSpentFolderGrants` takes the clock so the
  // 24 h window does not have to be waited out here).
  const pruneAgedGrants = () => {
    const db = new DatabaseSync(dbPath);
    try {
      return pruneSpentFolderGrants(db, Date.now() + 25 * DAY_MS);
    } finally {
      db.close();
    }
  };
  return { call, newGrant, pruneAgedGrants };
}

test('反向对照：授权行仍在时同号重放就是 200（主干与修复后都成立）', async (t) => {
  const h = await harness(t);
  const grantId = await h.newGrant();
  const first = await h.call({ commandId: 'cmd-nameless-live', grantId });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.name, 'my-project', 'the route is supposed to derive the folder name');

  const replay = await h.call({ commandId: 'cmd-nameless-live', grantId });
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.projectId, first.body.projectId);
});

test('被清理掉的授权行不得让同名同号的重放变成 COMMAND_CONFLICT', async (t) => {
  const h = await harness(t);
  const grantId = await h.newGrant();
  const first = await h.call({ commandId: 'cmd-nameless-pruned', grantId });
  assert.equal(first.status, 201, JSON.stringify(first.body));

  assert.ok(h.pruneAgedGrants() >= 1, 'fixture did not have a prunable consumed row');
  const replay = await h.call({ commandId: 'cmd-nameless-pruned', grantId });
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.projectId, first.body.projectId);
  assert.equal(replay.body.name, 'my-project');
  assert.equal(replay.body.code, undefined, 'a same-payload replay must not be an error receipt');
});

// 守卫不许因为这条修复变弱：载荷真的换了项目/换了名字，同号仍必须拒绝。
test('反向对照：重放守卫仍然拒绝真正换了内容的同号请求', async (t) => {
  const h = await harness(t);
  const grantId = await h.newGrant();
  const first = await h.call({ commandId: 'cmd-same-id', grantId });
  assert.equal(first.status, 201, JSON.stringify(first.body));

  const renamed = await h.call({ commandId: 'cmd-same-id', grantId, name: '另一个名字' });
  assert.equal(renamed.status, 409, JSON.stringify(renamed.body));
  assert.equal(renamed.body.code, 'COMMAND_CONFLICT');

  const otherGrant = await h.newGrant();
  const rebound = await h.call({ commandId: 'cmd-same-id', grantId: otherGrant });
  assert.equal(rebound.status, 409, JSON.stringify(rebound.body));
  assert.equal(rebound.body.code, 'COMMAND_CONFLICT');
});

test('显式命名与带 stage 的同号重放不受影响', async (t) => {
  const h = await harness(t);
  const grantId = await h.newGrant();
  const first = await h.call({ commandId: 'cmd-explicit', grantId, name: '显式项目名', stage: 'paused' });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  h.pruneAgedGrants();
  const replay = await h.call({ commandId: 'cmd-explicit', grantId, name: '显式项目名', stage: 'paused' });
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.stage, 'paused');
});
