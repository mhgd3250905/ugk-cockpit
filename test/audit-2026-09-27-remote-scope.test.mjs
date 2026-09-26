// 第 29 轮审计（2026-09-27）：远端地址策略必须把「网络地址」与「本机/网络共享路径」
// 分开对待。`validateRemoteUrlSecurity` 只按形状判断：任何看起来像文件路径的串都算
// local path 并放行，其中包括 `\\host\share\repo.git`。而 `readDeliveryLocation` 在
// 只读预检阶段就会对 local path 做 existsSync/realpathSync —— 于是一个仓库本地配置
// 就能让 Cockpit 在用户没有确认任何写入的情况下，用当前用户的 Windows 凭据去访问
// 攻击者指定的主机名（NTLM 单向认证外泄），并把该名字的解析阻塞在预检里。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateRemoteUrlSecurity, isLocalPath } from '../src/git/delivery-ops.mjs';
import { readDeliveryLocation } from '../src/git/delivery-ops.mjs';

process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';

const git = (cwd, args) => {
  try {
    return execFileSync('git', args, {
      cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    throw Object.assign(new Error(`git ${args.join(' ')}: ${error.stderr ?? error.message}`), { status: error.status });
  }
}

// Windows 上刚退出的 git 子进程会短暂占住目录句柄，删除要有限重试。
function removeWithRetry(target, attempts = 40) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      rmSync(target, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== 'EPERM' && error?.code !== 'EBUSY' && error?.code !== 'ENOTEMPTY') throw error;
      const waitUntil = Date.now() + 100;
      while (Date.now() < waitUntil) { /* bounded spin, no timer handle */ }
    }
  }
  // 仍被占用：改名让开后尽力删除，残留交给系统临时目录清理策略。
  try {
    const parked = `${target}.pending-${Date.now()}`;
    renameSync(target, parked);
    rmSync(parked, { recursive: true, force: true });
  } catch {
    throw lastError;
  }
}

function tempRepository(t, prefix) {
  const root = realpathSync(mkdtempSync(path.join(realpathSync(os.tmpdir()), prefix)));
  t.after(() => removeWithRetry(root));
  const repo = path.join(root, 'repository');
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'seed']);
  writeFileSync(path.join(repo, 'file.txt'), 'content\n');
  git(repo, ['add', 'file.txt']);
  git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'second']);
  return { root, repo };
}

test('a UNC remote is refused by the transport policy itself', () => {
  const unc = '\\\\ugk-audit-not-a-host.invalid\\share\\repository.git';
  assert.equal(isLocalPath(unc), true, '缺陷前提：这个形状今天被判定为 local path');
  assert.throws(
    () => validateRemoteUrlSecurity(unc),
    (error) => error.code === 'UNSAFE_REMOTE_URL',
    '网络共享地址不得进入本机文件路径通道',
  );
});

test('the read-only delivery inspection never hands a config-supplied UNC path to the filesystem', async (t) => {
  const { repo } = tempRepository(t, 'ugk-unc-inspect-');
  git(repo, ['remote', 'add', 'origin', '\\\\ugk-audit-not-a-host.invalid\\share\\repository.git']);
  let caught = null;
  try {
    await readDeliveryLocation(repo);
  } catch (error) {
    caught = error;
  }
  assert.equal(
    caught?.code,
    'UNSAFE_REMOTE_URL',
    `预检必须拒绝这个地址，而不是先去解析共享路径（实际: ${caught?.code ?? '没有抛错'}）`,
  );
});

test('the same share is refused in every spelling git would resolve', () => {
  // 复核线程实测：只判字面 \ 前缀会被 //host/share 绕过（git 在 Windows 上
  // 把它解析成同一个 UNC），file://otherhost/... 同理。
  const variants = [
    '\\ugk-audit-not-a-host.invalid\share\repository.git',
    '//ugk-audit-not-a-host.invalid/share/repository.git',
    'file://ugk-audit-not-a-host.invalid/share/repository.git',
  ];
  for (const url of variants) {
    assert.throws(
      () => validateRemoteUrlSecurity(url, { cwd: null }),
      (error) => error.code === 'UNSAFE_REMOTE_URL',
      `共享地址的每种写法都必须被拒绝: ${url}`,
    );
  }
});

test('the read-only inspection refuses a forward-slash share without touching it', async (t) => {
  const { repo } = tempRepository(t, 'ugk-unc-slash-');
  git(repo, ['remote', 'add', 'origin', '//ugk-audit-not-a-host.invalid/share/repository.git']);
  let caught = null;
  try {
    await readDeliveryLocation(repo);
  } catch (error) {
    caught = error;
  }
  assert.equal(caught?.code, 'UNSAFE_REMOTE_URL', `实际: ${caught?.code ?? '没有抛错'}`);
});

test('legitimate remote shapes keep being accepted', () => {
  // 本机裸仓库（跨盘送审的既有用法）与网络协议地址都不该被本轮修复误伤。
  for (const url of [
    'C:/ugk-audit/backup/repository.git',
    'file:///C:/ugk-audit/backup/repository.git',
    'file://localhost/C:/ugk-audit/backup/repository.git',
    'https://github.com/example/repository.git',
    'ssh://git@github.com/example/repository.git',
    'git@github.com:example/repository.git',
  ]) {
    validateRemoteUrlSecurity(url);
  }
});
