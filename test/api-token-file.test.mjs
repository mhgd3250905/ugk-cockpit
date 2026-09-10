// api-token 持久化：唯一随机临时名 + 失败清理 + 崩溃恢复。
// 真实进程终止（SIGKILL）留下的临时文件不得阻塞后续启动——这正是
// 统筹复审指出的 PID 复用恢复缺口。
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { loadOrCreateToken } from '../src/core/token-file.mjs';

const run = promisify(execFile);

test('loadOrCreateToken 首次创建并持久化，重载返回同一 token', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-token-basic-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tokenPath = path.join(root, 'api-token');

  const first = loadOrCreateToken(tokenPath);
  assert.ok(first.length >= 32, 'token must satisfy the 32-character service minimum');
  assert.match(first, /^[A-Za-z0-9_-]+$/, 'base64url token shape');
  const second = loadOrCreateToken(tokenPath);
  assert.equal(second, first);
  assert.ok(existsSync(tokenPath));
});

test('真实进程终止留下的临时文件（含 PID 复用形态）不阻塞后续启动', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-token-crash-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tokenPath = path.join(root, 'api-token');

  // 形态一：旧实现的固定命名 api-token.<pid>.tmp——后续进程恰好复用该 PID
  // 时旧实现会因 wx + EEXIST 启动失败。
  const pidCollision = `${tokenPath}.${process.pid}.tmp`;
  writeFileSync(pidCollision, 'truncated-junk\n');

  // 形态二：真实子进程写入临时文件后被 SIGKILL 硬终止（rename 从未执行）。
  const killedLeftover = `${tokenPath}.777777.cafef00d.tmp`;
  const childScript = `
    const fs = require('node:fs');
    fs.writeFileSync(process.argv[1], 'crash-before-rename\\n');
    process.kill(process.pid, 'SIGKILL');
  `;
  await assert.rejects(run(process.execPath, ['-e', childScript, killedLeftover]));
  assert.equal(existsSync(killedLeftover), true, 'killed process must leave its temp file behind');

  // 残留全部在场的情况下，token 加载照常成功。
  const token = loadOrCreateToken(tokenPath);
  assert.ok(token.length >= 32);
  assert.equal(loadOrCreateToken(tokenPath), token);
  assert.ok(existsSync(tokenPath));
  // 残留文件保持原样（无害垃圾，不阻塞也不被吞掉）。
  assert.equal(existsSync(pidCollision), true);
  assert.equal(existsSync(killedLeftover), true);
});

test('打开临时文件失败时不产生任何残留', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-token-fail-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // 中间目录缺失：readFileSync 报 ENOENT 走创建分支，openSync 随即失败。
  const tokenPath = path.join(root, 'missing-dir', 'api-token');
  assert.throws(() => loadOrCreateToken(tokenPath));
  const entries = readdirSync(root);
  assert.deepEqual(entries, [], 'no temp file may be left behind');
});
