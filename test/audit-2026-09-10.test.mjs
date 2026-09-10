// 2026-09-10 external audit round: root-cause fixes for five verified defects.
//
// 1. Repository-local `http.*` transport configuration was neither detected nor
//    neutralised, so a repository the user merely added could redirect the
//    connection, disable TLS verification, or inject request headers into a
//    fetch/push that carries the user's real Git credentials.
// 2. `remote.<name>.mirror = true` made every managed push die with
//    "--mirror can't be combined with refspecs".
// 3. The Host allow-list accepted `[::1]` while the Origin allow-list did not,
//    which made the whole API unusable over IPv6 loopback.
// 4. The non-terminal progress status enum was enforced only in the MCP bridge,
//    leaving the HTTP boundary accepting privileged/arbitrary statuses.
// 5. The legacy `/api/v1/runs/*` routes authorised against a constructor list
//    that the real entry point never populates, so the documented
//    user-confirmed release path for a crashed write lease was unreachable in
//    production while the suite (which injects the roots) passed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openCockpitDatabase } from '../src/core/database.mjs';
import { startWriteRun } from '../src/core/runs.mjs';
import { PROGRESS_STATUSES } from '../src/core/assignments-contract.mjs';
import { SAFE_GIT_PREFIX } from '../src/git/probe.mjs';
import { mirrorResetArguments } from '../src/git/delivery-ops.mjs';
import { pushSubmissionBranch } from '../src/git/submit-ops.mjs';
import { findHostileRepositoryConfiguration } from '../src/git/repository-policy.mjs';
import { createCockpitHttpServer } from '../src/service/http-server.mjs';

// POSIX 的系统临时目录本身可能是符号链接；产品路径授权按契约拒绝穿越链接的
// 路径，夹具必须建立在真实路径下。
function fixtureTempRoot() {
  return process.platform === 'win32' ? os.tmpdir() : realpathSync(os.tmpdir());
}

function gitSync(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createFixture(t, prefix) {
  const base = mkdtempSync(path.join(fixtureTempRoot(), prefix));
  t.after(() => {
    try { rmSync(base, { recursive: true, force: true }); } catch {}
  });
  const repo = path.join(base, 'repo');
  const bare = path.join(base, 'remote.git');
  gitSync(base, ['init', '--bare', '-b', 'main', bare]);
  gitSync(base, ['init', '-b', 'main', repo]);
  gitSync(repo, ['config', 'user.email', 'ugk@example.invalid']);
  gitSync(repo, ['config', 'user.name', 'UGK Test']);
  writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  gitSync(repo, ['add', 'README.md']);
  gitSync(repo, ['-c', 'user.email=ugk@example.invalid', '-c', 'user.name=UGK Test', 'commit', '-m', 'fixture']);
  gitSync(repo, ['remote', 'add', 'origin', bare]);
  return { base, repo, bare };
}

// ---------------------------------------------------------------- transport

// 仓库本地的 http.* 传输配置此前完全不在守卫的枚举范围内：它既能重定向连接
// （proxy / curloptResolve），也能取消对端证明（sslVerify / sslCAInfo /
// pinnedPubkey），还能注入请求头，而带凭据的 fetch/push 会把这些一起送出去。
test('repository-local http.* transport config is reported as hostile', async (t) => {
  for (const [key, value] of [
    ['http.proxy', 'http://127.0.0.1:9'],
    ['http.sslVerify', 'false'],
    ['http.extraHeader', 'Authorization: Bearer attacker'],
    ['http.curloptResolve', 'example.invalid:443:203.0.113.9'],
    ['https.proxy', 'http://127.0.0.1:9'],
    // url 作用域的写法优先于通用键，且从同一作用域读取。
    ['http.https://example.invalid/.proxy', 'http://127.0.0.1:9'],
    ['http.https://example.invalid/.sslVerify', 'false'],
  ]) {
    const { repo } = createFixture(t, 'ugk-audit-transport-');
    gitSync(repo, ['config', '--local', key, value]);
    assert.deepEqual(
      await findHostileRepositoryConfiguration(repo),
      { kind: 'transport' },
      `${key} must be reported as hostile transport configuration`,
    );
  }
});

// 键名大小写由 Git 归一化，模式必须按 Git 的规则匹配而不是字面量。
test('transport detection is case-insensitive like git config keys', async (t) => {
  const { repo } = createFixture(t, 'ugk-audit-transport-case-');
  gitSync(repo, ['config', '--local', 'http.SSLVerify', 'false']);
  assert.deepEqual(await findHostileRepositoryConfiguration(repo), { kind: 'transport' });
});

// 性能类 http.* 键不改变对端，误报会直接锁死普通仓库。
test('benign http.* performance settings are not treated as hostile', async (t) => {
  const { repo } = createFixture(t, 'ugk-audit-transport-benign-');
  for (const [key, value] of [
    ['http.postBuffer', '524288000'],
    ['http.version', 'HTTP/1.1'],
    ['http.userAgent', 'git/2.0'],
    ['http.lowSpeedLimit', '1000'],
    ['http.maxRequests', '5'],
  ]) {
    gitSync(repo, ['config', '--local', key, value]);
  }
  assert.equal(await findHostileRepositoryConfiguration(repo), null);
});

// 这是本轮最容易再犯的错误：`git config --get-regexp` 也会报告命令行 -c 值，
// 而 SAFE_GIT_PREFIX 现在为中和通用键而传这三个 -c。若按无作用域方式查询，
// 每个干净仓库都会被判为 hostile。守卫必须像 filter 模式一样按仓库作用域查询。
test('the transport resets in SAFE_GIT_PREFIX do not make clean repositories hostile', async (t) => {
  const { repo } = createFixture(t, 'ugk-audit-transport-selfmatch-');
  assert.equal(await findHostileRepositoryConfiguration(repo), null);
  // 前提核对：这些 -c 确实存在于每次 Git 调用的命令线上，否则本用例没有意义。
  const listed = gitSync(repo, [...SAFE_GIT_PREFIX, 'config', '--list']);
  for (const key of ['http.proxy=', 'http.sslverify=true', 'http.extraheader=']) {
    assert.ok(listed.includes(`${key}\n`) || listed.endsWith(key), `${key} must be on the command line`);
  }
});

test('SAFE_GIT_PREFIX neutralises the generic transport keys', () => {
  for (const expected of [['-c', 'http.proxy='], ['-c', 'http.sslVerify=true'], ['-c', 'http.extraHeader=']]) {
    assert.ok(
      SAFE_GIT_PREFIX.includes(expected[0]) && SAFE_GIT_PREFIX.includes(expected[1]),
      `${expected.join(' ')} must be part of every Git invocation`,
    );
  }
});

// ------------------------------------------------------------------- mirror

test('mirrorResetArguments resets only the named remote', () => {
  assert.deepEqual(mirrorResetArguments('origin'), ['-c', 'remote.origin.mirror=false']);
});

// `git clone --mirror` 会把 remote.<name>.mirror=true 写进配置，而 Git 在处理
// refspec 之前就采纳它，于是产品固定的显式 refspec 必然以
// "--mirror can't be combined with refspecs" 失败：镜像克隆永远无法送审或接入，
// 且只得到可无限重试的 PUSH_FAILED。
test('a mirror-configured remote still pushes exactly the requested branch', async (t) => {
  const { repo, bare } = createFixture(t, 'ugk-audit-mirror-');
  gitSync(repo, ['checkout', '-q', '-b', 'cockpit/work/mirrortest01']);
  gitSync(repo, ['config', '--local', 'remote.origin.mirror', 'true']);

  await pushSubmissionBranch(repo, { remote: 'origin', branch: 'cockpit/work/mirrortest01' });

  assert.equal(
    gitSync(bare, ['rev-parse', '--verify', 'refs/heads/cockpit/work/mirrortest01']),
    gitSync(repo, ['rev-parse', 'HEAD']),
    'the branch must actually reach the remote',
  );
  // 复位只针对该 remote,不得改变仓库里的原始设置。
  assert.equal(gitSync(repo, ['config', '--local', '--get', 'remote.origin.mirror']), 'true');
});

// --------------------------------------------------------------- http layer

function baseline(marker) {
  return {
    head: marker.repeat(40),
    branch: 'main',
    indexFingerprint: `index-${marker}`,
    worktreeFingerprint: `tree-${marker}`,
    coherence: 'coherent',
  };
}

async function startService(t, { authorizedRoots } = {}) {
  const root = mkdtempSync(path.join(fixtureTempRoot(), 'ugk-audit-http-'));
  const token = 'b'.repeat(32);
  const service = await createCockpitHttpServer({
    dbPath: path.join(root, 'cockpit.db'),
    token,
    ...(authorizedRoots ? { authorizedRoots } : {}),
    serveWebAsset: async () => false,
  });
  t.after(async () => {
    await service.close();
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  });
  return { root, token, service, base: `http://${service.host}:${service.port}` };
}

// Host 白名单接受 [::1]，Origin 白名单却只认 127.0.0.1 与 localhost：页面能
// 打开、能拿到会话 Cookie，随后每个 /api/v1 请求都被判为"其他网页的控制请求"。
test('the IPv6 loopback origin is accepted, matching the Host allow-list', async (t) => {
  const { token, service, base } = await startService(t);
  const dashboard = (origin) => fetch(`${base}/api/v1/dashboard`, {
    headers: { authorization: `Bearer ${token}`, ...(origin ? { origin } : {}) },
  });

  assert.equal((await dashboard(`http://[::1]:${service.port}`)).status, 200);
  assert.equal((await dashboard()).status, 200);
  // 域外 Origin 仍必须拒绝。
  const foreign = await dashboard(`http://evil.example:${service.port}`);
  assert.equal(foreign.status, 403);
  assert.equal((await foreign.json()).code, 'ORIGIN_REJECTED');
});

// 非终态枚举此前只存在于 MCP 桥；HTTP 边界直接可达，而核心只拒绝终态，
// 于是 'adopted' 这类仅由 init 路径写入的特权状态可被伪造进时间线。
test('progress rejects statuses the MCP gate never allows', async (t) => {
  const { token, base } = await startService(t);
  const identity = Buffer.from(JSON.stringify({ host: 'zcode', id: 'audit-chat' })).toString('base64url');
  const bootstrap = await fetch(`${base}/api/v1/mcp/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client: 'ugk-cockpit-stdio' }),
  });
  assert.equal(bootstrap.status, 201);
  const { token: scopedToken } = await bootstrap.json();

  const progress = (status) => fetch(`${base}/api/v1/mcp/work/progress`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${scopedToken}`,
      'content-type': 'application/json',
      'x-ugk-conversation': identity,
    },
    body: JSON.stringify({
      sessionId: 'session-does-not-exist',
      clientRequestId: `audit-${status}`,
      expectedRevision: 1,
      status,
      summary: 'audit probe',
    }),
  });

  for (const status of ['adopted', 'completed', 'anything']) {
    const response = await progress(status);
    assert.equal(response.status, 400, `status ${status} must be refused at the HTTP boundary`);
    assert.equal((await response.json()).code, 'INVALID_REQUEST');
  }
  // 合法状态必须越过校验（这里因会话不存在而失败，但不是 400 校验错误）。
  const allowed = await progress('working');
  assert.notEqual(allowed.status, 400);
});

test('the progress enum has a single definition shared by both gates', () => {
  assert.deepEqual([...PROGRESS_STATUSES], ['working', 'in_progress']);
  assert.ok(Object.isFrozen(PROGRESS_STATUSES));
});

// 真实入口 main.mjs 从不传 authorizedRoots，因此 findGrant 对每个生产请求都抛
// PATH_NOT_AUTHORIZED：上一轮交付的"用户确认释放残留写租约"路径在生产环境完全
// 不可达，只有注入夹具根的测试能通过。授权根必须来自用户实际授予的持久事实。
test('legacy run routes authorise against granted folders without injected roots', async (t) => {
  const { root, token, base } = await startService(t);
  const grantedRoot = path.join(root, 'projects');
  const insideDir = path.join(grantedRoot, 'wt-inside');
  mkdirSync(insideDir, { recursive: true });

  const setup = openCockpitDatabase(path.join(root, 'cockpit.db'));
  const inside = startWriteRun(setup, {
    commandId: 'audit-setup-inside',
    runId: 'run-inside',
    worktreeId: 'worktree-inside',
    canonicalPath: insideDir,
    repositoryIdentity: 'repo-inside',
    agentClaim: 'codex',
    goal: 'crashed writer inside granted root',
    baseline: baseline('a'),
  });
  assert.equal(inside.ok, true);
  const outside = startWriteRun(setup, {
    commandId: 'audit-setup-outside',
    runId: 'run-outside',
    worktreeId: 'worktree-outside',
    canonicalPath: path.join(root, 'not-granted'),
    repositoryIdentity: 'repo-outside',
    agentClaim: 'codex',
    goal: 'crashed writer outside every granted root',
    baseline: baseline('b'),
  });
  assert.equal(outside.ok, true);
  // 用户选过这个文件夹：project 行记录它，这就是生产环境里的授权事实。
  setup.prepare(`
    INSERT INTO projects (
      id, name, stage, worktree_id, status, status_reason,
      last_observed_at, created_at, updated_at, authorized_root
    ) VALUES ('p-inside', 'granted', 'development', ?, 'active', '', 'now', 'now', 'now', ?)
  `).run('worktree-inside', grantedRoot);
  setup.close();

  const release = (body) => fetch(`${base}/api/v1/runs/release-lease`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  // 授权已通过：进入"需要用户确认"分支，而不是 PATH_NOT_AUTHORIZED。
  const insideResponse = await release({
    commandId: 'audit-release-inside',
    runId: 'run-inside',
    expectedRevision: inside.revision,
    leaseGeneration: inside.leaseGeneration,
  });
  assert.equal(insideResponse.status, 409);
  assert.equal((await insideResponse.json()).code, 'RUN_LEASE_CONFIRMATION_REQUIRED');

  // 未授予的路径仍然 fail closed。
  const outsideResponse = await release({
    commandId: 'audit-release-outside',
    runId: 'run-outside',
    expectedRevision: outside.revision,
    leaseGeneration: outside.leaseGeneration,
  });
  assert.equal(outsideResponse.status, 403);
  assert.equal((await outsideResponse.json()).code, 'PATH_NOT_AUTHORIZED');
});
