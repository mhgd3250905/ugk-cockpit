// 第 35 轮审计（2026-10-03）· 其二：错误码经真实 HTTP 回执回来的形状。
//
// 本文件刻意不 import 任何错误码表，只在真实服务上打分站请求，因此同一份用例
// 可以在修复前的树上逐条判红（而不是整文件在 import 阶段炸掉）。
//
// 缺陷：`sendError` 查不到 `PUBLIC_ERRORS[code]` 时把响应写成
// `{code:'REQUEST_FAILED', message:'本地操作没有完成。', impact:'…代码不会被
// 自动清理或覆盖。', requiredAction:'请刷新状态后重试…'}`。对 Git 探测超限这一
// 类失败，等于把「读不到状态」说成「操作没做完，刷新重试」，而工作副本仍在原地。
//
// 注入缝隙的选择：`createCockpitHttpServer({ probe })` 是生产工厂已有的注入点
// （main.mjs 用默认实现，测试用替身）。错误对象本身不是手抄的——由 `src/git/probe.mjs`
// 的 `git()` 在 maxBuffer 超限时真实构造，因此消息文本与 code 都来自生产产生者。
// 未被端到端证明的只有「真实 git 在一个工作副本里产出 >4MB 输出」这一步，见报告
// 的未证实条目。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCockpitHttpServer } from '../src/service/http-server.mjs';
import { git, probeGitWorktree } from '../src/git/probe.mjs';

const TOKEN = 'error-code-surfacing-token-long-enough-1234';

function gitSync(cwd, args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

// POSIX 的系统临时目录本身可能是符号链接；路径授权按契约拒绝穿越链接的路径。
function realTemp(prefix) {
  return realpathSync(mkdtempSync(path.join(realpathSync(os.tmpdir()), prefix)));
}

async function startedService(t, { probe } = {}) {
  const container = realTemp('ugk-error-code-');
  const folder = path.join(container, 'project');
  mkdirSync(folder);
  gitSync(folder, ['init', '-q']);
  writeFileSync(path.join(folder, 'tracked.txt'), 'keep\n');
  gitSync(folder, ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'add', 'tracked.txt']);
  gitSync(folder, ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-q', '-m', 'fixture']);
  const dbPath = path.join(container, 'cockpit.db');
  const service = await createCockpitHttpServer({
    dbPath, token: TOKEN, folderPicker: async () => folder, ...(probe ? { probe } : {}),
  });
  t.after(async () => {
    // Windows：SQLite 句柄未关就删目录会 EPERM，顺序必须是先关服务与库、再删。
    await service.close();
    rmSync(container, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  const request = async (route, body) => {
    const response = await fetch(`http://${service.host}:${service.port}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const selected = await request('/api/v1/folders/select', {});
  assert.equal(selected.status, 200, JSON.stringify(selected.body));
  const registered = await request('/api/v1/projects', {
    commandId: 'register-error-code-fixture', grantId: selected.body.grantId, name: '错误码夹具',
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  return { folder, request, projectId: registered.body.projectId };
}

test('Git 输出超限经真实刷新路由回来时带着自己的码，而不是通用 REQUEST_FAILED', async (t) => {
  let armed = false;
  const f = await startedService(t, {
    probe: async (candidate, options) => {
      // 8 字节上限使真实 `git status --porcelain` 输出必然超限，由生产产生者
      // 构造出 GIT_BUFFER_LIMIT_EXCEEDED。
      if (armed) await git(candidate, ['status', '--porcelain'], { maxBuffer: 8 });
      return probeGitWorktree(candidate, options);
    },
  });
  writeFileSync(path.join(f.folder, 'untracked-output.txt'), 'more\n');
  armed = true;

  const refreshed = await f.request(`/api/v1/projects/${f.projectId}/refresh`, { commandId: 'refresh-oversized' });
  assert.equal(refreshed.body.code, 'GIT_BUFFER_LIMIT_EXCEEDED', JSON.stringify(refreshed.body));
  assert.equal(refreshed.status, 503);
  assert.notEqual(refreshed.body.message, '本地操作没有完成。', 'still answered with the generic receipt');
  // 三件套齐全（AGENTS.md：每个异常必须回答发生了什么、代码是否受影响、下一步）。
  for (const field of ['message', 'impact', 'required_action']) {
    assert.equal(typeof refreshed.body[field], 'string', `${field} missing`);
    assert.ok(refreshed.body[field].trim().length > 0, `${field} empty`);
  }
});

test('没有码的探测失败仍然只能得到通用回执，且不回显原始错误文本', async (t) => {
  // 守卫的另一侧（双向实测）：登记只针对「带码」的失败。无码错误必须继续降级，
  // 且降级时不得把 err.message 漏进回执。这一条在主干上即绿。
  let armed = false;
  const f = await startedService(t, {
    probe: async (candidate, options) => {
      if (armed) throw new Error('private marker leaked in message');
      return probeGitWorktree(candidate, options);
    },
  });
  armed = true;
  const refreshed = await f.request(`/api/v1/projects/${f.projectId}/refresh`, { commandId: 'refresh-uncoded' });
  assert.equal(refreshed.status, 400);
  assert.equal(refreshed.body.code, 'REQUEST_FAILED');
  assert.doesNotMatch(JSON.stringify(refreshed.body), /private marker leaked/);
});

test('通用回执的 reason 永远等于通用码，不带出内部码名或子进程退出码', async (t) => {
  // 本轮把「末尾 catch 先塌一次码」删掉时引入过一个真实回归：sendError 的 `code`
  // 字段仍然收束，但 `reason` 的回退用的是**原始**参数，于是 /refresh 会把
  // `GIT_WORKTREE_SWITCH_FAILED` 甚至数字退出码 128 直接写进响应。这一条在主干上
  // 即绿（主干那层重复塌码恰好挡住了它），在本轮中间提交上判红，因此它是本轮
  // 自造回归的钉，不是旧缺陷的复现。
  const cases = [
    ['worktree switch failed', 'GIT_WORKTREE_SWITCH_FAILED', 'named'],
    ['git rev-parse exited with code 128', 128, 'numeric'],
  ];
  for (const [message, code, label] of cases) {
    let armed = false;
    const f = await startedService(t, {
      probe: async (candidate, options) => {
        if (armed) throw Object.assign(new Error(message), { code });
        return probeGitWorktree(candidate, options);
      },
    });
    armed = true;
    const refreshed = await f.request(`/api/v1/projects/${f.projectId}/refresh`, {
      commandId: `refresh-reason-${label}`,
    });
    const text = JSON.stringify(refreshed.body);
    assert.equal(refreshed.body.code, 'REQUEST_FAILED', text);
    assert.equal(refreshed.body.reason, 'REQUEST_FAILED', `reason leaked ${String(code)}: ${text}`);
    assert.doesNotMatch(text, /GIT_WORKTREE_SWITCH_FAILED/, 'raw internal code name reached the client');
    assert.doesNotMatch(text, /\b128\b/, 'raw child-process exit status reached the client');
  }
});

test('已登记的码把 reason 也带着走（不许只改 code 字段）', async (t) => {
  let armed = false;
  const f = await startedService(t, {
    probe: async (candidate, options) => {
      if (armed) await git(candidate, ['status', '--porcelain'], { maxBuffer: 8 });
      return probeGitWorktree(candidate, options);
    },
  });
  writeFileSync(path.join(f.folder, 'untracked-reason.txt'), 'more\n');
  armed = true;
  const refreshed = await f.request(`/api/v1/projects/${f.projectId}/refresh`, { commandId: 'refresh-reason-curated' });
  assert.equal(refreshed.body.code, 'GIT_BUFFER_LIMIT_EXCEEDED', JSON.stringify(refreshed.body));
  assert.equal(refreshed.body.reason, 'GIT_BUFFER_LIMIT_EXCEEDED');
});

test('已经登记的码不会触发 uncurated 告警（误红面）', async (t) => {  // 误红的守卫会被人删掉，比没守卫更糟：登记过的码走完整条 sendError 路径也不许
  // 留下一行告警。这里用 PROJECT_NOT_FOUND——它是回执链路上最常走的一类码。
  const f = await startedService(t);
  const writes = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    const text = String(chunk);
    if (text.includes('uncurated error code')) writes.push(text);
    return original(chunk);
  };
  try {
    const missing = await f.request(`/api/v1/projects/project-does-not-exist/refresh`, { commandId: 'refresh-missing' });
    assert.equal(missing.body.code, 'PROJECT_NOT_FOUND', JSON.stringify(missing.body));
  } finally {
    process.stderr.write = original;
  }
  assert.deepEqual(writes, [], 'a curated code was reported as uncurated');
});

test('确实未登记的产品错误码在降级时被点名告警（接线面）', async (t) => {
  // 上一条款件证明「登记过的不告警」，这一条证明「没登记的会告警」，两者都要走过
  // 真实的 sendError 才算钉住了接线：只把 sendError 里那一行删掉，本用例必须变红，
  // 而 helper 自己的用例仍会全绿（那是假覆盖）。
  // 用的码必须是产品里真实存在、且刻意不进 HTTP 白名单的常量：`LOCK_ID_MISMATCH`
  // 由 `src/core/integrations.mjs` 的 releaseRepositoryLock 返回，其结果在
  // `mergeApprovedSubmission` / `reuseDevelopmentWorkspace` 的 finally 里被丢弃，
  // 所以它拿不到登记——正是这一款用例要的样本。
  const UNCURATION_SAMPLE = 'LOCK_ID_MISMATCH';
  let armed = false;
  const f = await startedService(t, {
    probe: async (candidate, options) => {
      if (armed) throw Object.assign(new Error('worktree switch failed'), { code: UNCURATION_SAMPLE });
      return probeGitWorktree(candidate, options);
    },
  });
  armed = true;
  const writes = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    const text = String(chunk);
    if (text.includes('uncurated error code')) writes.push(text);
    return original(chunk);
  };
  let refreshed;
  try {
    refreshed = await f.request(`/api/v1/projects/${f.projectId}/refresh`, { commandId: 'refresh-uncurated' });
  } finally {
    process.stderr.write = original;
  }
  assert.equal(refreshed.body.code, 'REQUEST_FAILED', JSON.stringify(refreshed.body));
  assert.equal(refreshed.status, 400);
  assert.equal(writes.length, 1, JSON.stringify(writes));
  assert.match(writes[0], new RegExp(UNCURATION_SAMPLE));
});
