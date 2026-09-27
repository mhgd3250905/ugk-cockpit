// 第 30 轮审计（2026-09-28）：仓库内容不得指名一个由平台代跑的 Git 程序。
// SAFE_GIT_PREFIX 已经为该族键逐一钉死了默认值——core.sshCommand、core.hooksPath、
// credential.helper、filter.lfs.*——但 `core.askpass` 不在其中：认证质询（远端回 401）
// 时 git 会按 GIT_ASKPASS → core.askpass → SSH_ASKPASS 的顺序取一个**程序**执行来拿
// 凭据，且这一步不受 GIT_TERMINAL_PROMPT=0 保护（本机以产品自己的 git() 封装实测：
// 仓库本地 core.askpass 指向夹具脚本，MARKER 被写出）。SSH_ASKPASS 同样活着——
// safeGitEnvironment 只剥 GIT_* 前缀。修法与前几轮同族一致：前缀钉死该键的默认值，
// 环境构造剥掉继承的 SSH_ASKPASS。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import https from 'node:https';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { git, safeGitEnvironment, SAFE_GIT_PREFIX } from '../src/git/probe.mjs';

process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';

function fixtureTempRoot() {
  return process.platform === 'win32' ? os.tmpdir() : realpathSync(os.tmpdir());
}

function cleanupLifo(cleanup) {
  return () => {
    for (const fn of [...cleanup].reverse()) {
      try { fn(); } catch { /* best effort */ }
    }
  };
}

const plainGit = (cwd, args) => execFileSync('git', args, {
  cwd,
  encoding: 'utf8',
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

function hasPin(key) {
  return SAFE_GIT_PREFIX.some((value, index) => (
    SAFE_GIT_PREFIX[index] === '-c' && SAFE_GIT_PREFIX[index + 1] === key
  ));
}

test('the pinned prefix neutralizes repository-local core.askpass', () => {
  // 与 core.sshCommand=ssh / core.hooksPath=NUL 同族：仓库不得用一行本地配置
  // 指定一个在认证质询时被执行、并带走用户名密码的程序。
  assert.ok(
    hasPin('core.askPass='),
    'SAFE_GIT_PREFIX must pin core.askPass to git\'s default (empty) so no repository can name an askpass program',
  );
});

test('the git environment does not carry an inherited SSH_ASKPASS', () => {
  const previous = process.env.SSH_ASKPASS;
  process.env.SSH_ASKPASS = path.join('E:', 'definitely-not-a-real-askpass.bat');
  try {
    const environment = safeGitEnvironment();
    assert.ok(!('SSH_ASKPASS' in environment), 'SSH_ASKPASS must be stripped like GIT_ASKPASS');
    assert.equal(environment.GIT_TERMINAL_PROMPT, '0');
  } finally {
    if (previous === undefined) delete process.env.SSH_ASKPASS;
    else process.env.SSH_ASKPASS = previous;
  }
});

function findOpenssl() {
  const candidates = [
    'openssl',
    'D:/Git/mingw64/bin/openssl.exe',
    'D:/Git/usr/bin/openssl.exe',
    'C:/Program Files/Git/mingw64/bin/openssl.exe',
    'C:/Program Files/Git/usr/bin/openssl.exe',
    '/usr/bin/openssl',
  ];
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['version'], { stdio: 'ignore', timeout: 10_000 });
      return candidate;
    } catch { /* next */ }
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// An HTTPS endpoint that always answers 401 Basic — exactly what a private
// remote returns. Without a TLS-trust escape the product's own pinned
// http.sslVerify=true would kill the connection before the challenge, so the
// fixture writes the url-scoped spelling `http.<url>.sslVerify=false` into the
// repository — the same repository-local config family the transport detector
// refuses by name. This test is about the ASKPASS layer, which no gate covers.
function buildChallengeFixture(t, root, port, { withRepoAskpass, payloadPath }) {
  const openssl = findOpenssl();
  if (!openssl) {
    t.skip('openssl unavailable — cannot mint a local TLS endpoint');
    return null;
  }
  execFileSync(openssl, [
    'req', '-x509', '-newkey', 'rsa:2048',
    '-keyout', path.join(root, 'server.key'),
    '-out', path.join(root, 'server.crt'),
    '-days', '2', '-nodes',
    '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { stdio: 'ignore', timeout: 60_000 });
  const repo = path.join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  plainGit(repo, ['init', '-q', '-b', 'main']);
  plainGit(repo, ['-c', 'user.name=UGK Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'seed']);
  if (withRepoAskpass) plainGit(repo, ['config', 'core.askpass', payloadPath]);
  plainGit(repo, ['config', `http.https://127.0.0.1:${port}/.sslVerify`, 'false']);
  plainGit(repo, ['remote', 'add', 'origin', `https://127.0.0.1:${port}/x.git`]);
  const server = https.createServer(
    { key: readFileSync(path.join(root, 'server.key')), cert: readFileSync(path.join(root, 'server.crt')) },
    (_request, response) => {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fixture"' });
      response.end();
    },
  );
  return { repo, server };
}

function askpassPayload(root, marker, tag) {
  if (process.platform === 'win32') {
    const bat = path.join(root, `ask-${tag}.bat`);
    writeFileSync(bat, `@echo off\r\necho executed > "${marker}"\r\necho somebody\r\n`);
    return bat;
  }
  const sh = path.join(root, `ask-${tag}.sh`);
  writeFileSync(sh, `#!/bin/sh\necho executed > "${marker}"\necho somebody\n`);
  chmodSync(sh, 0o755);
  return sh;
}

async function runProductLsRemote(repo) {
  try {
    const result = await git(repo, ['ls-remote', '--', 'origin'], { timeoutMs: 25_000 });
    return { threw: false, result };
  } catch (error) {
    return { threw: true, code: error.code };
  }
}

test('a repository-local core.askpass cannot execute during a product ls-remote', async (t) => {
  const cleanup = [];
  t.after(cleanupLifo(cleanup));
  const root = mkdtempSync(path.join(fixtureTempRoot(), 'ugk-askpass-repo-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const marker = path.join(root, 'MARKER');
  const payload = askpassPayload(root, marker, 'repo');
  const port = await freePort();
  const fixture = buildChallengeFixture(t, root, port, { withRepoAskpass: true, payloadPath: payload });
  if (!fixture) return;
  cleanup.push(() => fixture.server.close());
  await new Promise((resolve) => fixture.server.listen(port, '127.0.0.1', resolve));

  const outcome = await runProductLsRemote(fixture.repo);
  // 修复前本机实测：exit 128 且 MARKER 存在——仓库内容指名了一个被执行、
  // 会以用户身份回答凭据质询的程序。
  assert.equal(existsSync(marker), false,
    `repository-local core.askpass executed through the product git() wrapper (port ${port})`);
  assert.ok(outcome.threw, 'the refused auth challenge must still fail closed');
});

test('an inherited SSH_ASKPASS cannot execute during a product ls-remote',
  { skip: process.platform !== 'win32' && 'the SSH_ASKPASS fallback runs without DISPLAY only on Windows' },
  async (t) => {
    const cleanup = [];
    t.after(cleanupLifo(cleanup));
    const root = mkdtempSync(path.join(fixtureTempRoot(), 'ugk-askpass-env-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const marker = path.join(root, 'MARKER');
    const payload = askpassPayload(root, marker, 'env');
    const port = await freePort();
    const fixture = buildChallengeFixture(t, root, port, { withRepoAskpass: false, payloadPath: payload });
    if (!fixture) return;
    cleanup.push(() => fixture.server.close());
    await new Promise((resolve) => fixture.server.listen(port, '127.0.0.1', resolve));

    const previous = process.env.SSH_ASKPASS;
    process.env.SSH_ASKPASS = payload;
    cleanup.push(() => {
      if (previous === undefined) delete process.env.SSH_ASKPASS;
      else process.env.SSH_ASKPASS = previous;
    });
    const outcome = await runProductLsRemote(fixture.repo);
    assert.equal(existsSync(marker), false, 'inherited SSH_ASKPASS executed through the product git() wrapper');
    assert.ok(outcome.threw, 'the refused auth challenge must still fail closed');
  });

test('the delivery-side environment builder shares the single hardened constructor', async (t) => {
  // Round-30 independent review: delivery-ops kept a second copy of the env
  // builder that silently did not strip SSH_ASKPASS — the delivery chain's
  // only defense was one -c token plus git's resolution order. The builder
  // now delegates to probe's constructor, and no extraEnv can re-inject it.
  const delivery = await import('../src/git/delivery-ops.mjs');
  const previous = process.env.SSH_ASKPASS;
  process.env.SSH_ASKPASS = 'E:\\definitely-not-a-real-askpass.bat';
  try {
    const fromBase = delivery.safeGitEnvironment();
    assert.ok(!('SSH_ASKPASS' in fromBase), 'delivery env must not inherit SSH_ASKPASS');
    const viaExtra = delivery.safeGitEnvironment({ SSH_ASKPASS: 'E:\\via-extra-env.bat' });
    assert.ok(!('SSH_ASKPASS' in viaExtra), 'extraEnv must not re-introduce SSH_ASKPASS');
    assert.equal(fromBase.GIT_TERMINAL_PROMPT, '0');
    assert.equal(fromBase.GIT_CONFIG_NOSYSTEM, '1');
  } finally {
    if (previous === undefined) delete process.env.SSH_ASKPASS;
    else process.env.SSH_ASKPASS = previous;
  }
});

test('GIT_ASKPASS remains stripped (neighbouring channel already closed)', async (t) => {
  const cleanup = [];
  t.after(cleanupLifo(cleanup));
  const root = mkdtempSync(path.join(fixtureTempRoot(), 'ugk-askpass-git-env-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const marker = path.join(root, 'MARKER');
  const payload = askpassPayload(root, marker, 'git');
  const port = await freePort();
  const fixture = buildChallengeFixture(t, root, port, { withRepoAskpass: false, payloadPath: payload });
  if (!fixture) return;
  cleanup.push(() => fixture.server.close());
  await new Promise((resolve) => fixture.server.listen(port, '127.0.0.1', resolve));
  const previous = process.env.GIT_ASKPASS;
  process.env.GIT_ASKPASS = payload;
  cleanup.push(() => {
    if (previous === undefined) delete process.env.GIT_ASKPASS;
    else process.env.GIT_ASKPASS = previous;
  });
  await runProductLsRemote(fixture.repo);
  assert.equal(existsSync(marker), false);
});

test('pinning core.askPass does not break ordinary ls-remote against a local remote', async (t) => {
  // 反向界：钉的是「仓库自持的 askpass 程序」，不是取凭据机制本身。
  // 文件传输的 ls-remote 在修复前后都必须照常成功。
  const cleanup = [];
  t.after(cleanupLifo(cleanup));
  const root = mkdtempSync(path.join(fixtureTempRoot(), 'ugk-askpass-ok-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  plainGit(repo, ['init', '-q', '-b', 'main']);
  plainGit(repo, ['-c', 'user.name=UGK Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'seed']);
  const bare = path.join(root, 'upstream.git');
  plainGit(root, ['clone', '--bare', '-q', repo, bare]);
  plainGit(repo, ['remote', 'add', 'origin', bare]);
  plainGit(repo, ['push', '-q', 'origin', 'main']);
  const result = await git(repo, ['ls-remote', '--', 'origin'], { timeoutMs: 25_000 });
  assert.match(result.stdout, /refs\/heads\/main/);
});
