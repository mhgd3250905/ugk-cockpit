import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { registerProject } from '../src/core/projects.mjs';
import { probeGitWorktree } from '../src/git/probe.mjs';
import { SAFE_GIT_PREFIX } from '../src/git/probe.mjs';
import { findHostileRepositoryConfiguration } from '../src/git/repository-policy.mjs';
import { isLocalPath, validateRemoteUrlSecurity } from '../src/git/delivery-ops.mjs';
import { remoteAuthArguments } from '../src/git/remote-auth.mjs';
import { createSubmitNote } from '../src/core/submit-notes.mjs';
import { finishRun, startWriteRun, takeoverWriteRun } from '../src/core/runs.mjs';
import { createMcpServer } from '../src/mcp/stdio-protocol.mjs';
import { createCockpitHttpServer } from '../src/service/http-server.mjs';
import { KNOWN_DELIVERY_CODES } from '../src/core/delivery-messages.mjs';

// POSIX 的系统临时目录（/tmp、/var）本身是符号链接；产品路径授权按契约拒绝
// 穿越链接的路径，夹具必须建立在真实路径下，否则授权在业务断言前就失败。
function fixtureTempRoot() {
  return process.platform === 'win32' ? os.tmpdir() : realpathSync(os.tmpdir());
}

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function seedRepo(dir) {
  mkdirSync(dir, { recursive: true });
  git(path.dirname(dir), ['init', '-b', 'main', dir]);
  git(dir, ['config', 'user.name', 'UGK Test']);
  git(dir, ['config', 'user.email', 'test@example.invalid']);
  writeFileSync(path.join(dir, 'README.md'), '# seed\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '--quiet', '-m', 'seed']);
}

// ---------------------------------------------------------------------------
// 1. 仓库本地签名族 / merge 驱动 / diff.external 配置闸门
// ---------------------------------------------------------------------------

test('hostile config gate refuses signing programs and command-driving keys', async (t) => {
  const root = mkdtempSync(path.join(fixtureTempRoot(), 'ugk-audit12-gpg-'));
  t.after(() => { try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} });
  const repo = path.join(root, 'repo');
  seedRepo(repo);

  git(repo, ['config', 'push.gpgsign', 'true']);
  assert.deepEqual(await findHostileRepositoryConfiguration(repo), null,
    'push.gpgSign alone is not a program path; the gate resets it via -c instead');

  git(repo, ['config', 'gpg.program', path.join(repo, 'evil.exe')]);
  assert.equal((await findHostileRepositoryConfiguration(repo))?.kind, 'filter');

  git(repo, ['config', '--unset', 'gpg.program']);
  git(repo, ['config', 'gpg.ssh.program', path.join(repo, 'evil.exe')]);
  assert.equal((await findHostileRepositoryConfiguration(repo))?.kind, 'filter');

  git(repo, ['config', '--unset', 'gpg.ssh.program']);
  git(repo, ['config', 'diff.external', path.join(repo, 'evil.exe')]);
  assert.equal((await findHostileRepositoryConfiguration(repo))?.kind, 'filter');

  git(repo, ['config', '--unset', 'diff.external']);
  git(repo, ['config', 'merge.evil.driver', path.join(repo, 'evil.exe %O %A %B')]);
  assert.equal((await findHostileRepositoryConfiguration(repo))?.kind, 'filter');
});

test('safe git prefix neutralises the sign-everything toggles', () => {
  for (const key of ['commit.gpgsign=false', 'push.gpgsign=false', 'tag.gpgsign=false']) {
    assert.ok(SAFE_GIT_PREFIX.includes(key), `SAFE_GIT_PREFIX must reset ${key}`);
  }
});

test('raw fs error codes never pass as delivery codes', () => {
  for (const code of ['ENOENT', 'EACCES', 'EISDIR', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER']) {
    assert.equal(KNOWN_DELIVERY_CODES.has(code), false, `${code} must stay internal`);
  }
  assert.equal(KNOWN_DELIVERY_CODES.has('FOLDER_PICKER_BUSY'), true);
});

// ---------------------------------------------------------------------------
// 2. file:// authority 与 UNC 远程不再被当作本地路径
// ---------------------------------------------------------------------------

test('remote URLs naming a remote host are not local paths', () => {
  assert.equal(isLocalPath('file:///C:/test/repo.git'), true);
  assert.equal(isLocalPath('file://localhost/test/repo.git'), true);
  assert.equal(isLocalPath('file://evil.com/share/repo.git'), false);
  assert.equal(isLocalPath(String.raw`\\evil.com\share\repo.git`), false);
  assert.equal(isLocalPath('//evil.com/share/repo.git'), false);
  assert.equal(isLocalPath(String.raw`\\localhost\share\repo.git`), true);
  assert.equal(isLocalPath(String.raw`\\127.0.0.1\c$\repo`), true);
  assert.equal(isLocalPath('C:\\test\\repo.git'), true);

  assert.throws(() => validateRemoteUrlSecurity('file://evil.com/share/repo.git'), { code: 'UNSAFE_REMOTE_URL' });
  assert.throws(() => validateRemoteUrlSecurity(String.raw`\\evil.com\share\repo.git`), { code: 'UNSAFE_REMOTE_URL' });
  assert.doesNotThrow(() => validateRemoteUrlSecurity('file:///C:/test/repo.git'));
});

test('remote-auth keeps the POSIX no-op contract', async () => {
  assert.deepEqual(await remoteAuthArguments(['push'], 'linux'), []);
  assert.deepEqual(await remoteAuthArguments(['status'], 'win32'), []);
});

// ---------------------------------------------------------------------------
// 3. 已删除的注册目录让 submit-notes 得到受控错误，而不是裸 ENOENT
// ---------------------------------------------------------------------------

test('a vanished worktree directory degrades to PROJECT_NOT_FOUND, not raw ENOENT', async (t) => {
  const root = mkdtempSync(path.join(fixtureTempRoot(), 'ugk-audit12-sn-'));
  t.after(() => { try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} });
  const dirA = path.join(root, 'projectA');
  const dirB = path.join(root, 'projectB');
  seedRepo(dirA);
  seedRepo(dirB);

  const db = openCockpitDatabase(path.join(root, 'cockpit.db'));
  t.after(() => { try { db.close(); } catch {} });
  const obsA = await probeGitWorktree(dirA);
  registerProject(db, { commandId: 'reg-a', name: 'A', authorizedRoot: dirA, observation: obsA });
  const obsB = await probeGitWorktree(dirB);
  registerProject(db, { commandId: 'reg-b', name: 'B', authorizedRoot: dirB, observation: obsB });

  rmSync(dirB, { recursive: true, force: true });

  await assert.rejects(
    createSubmitNote(db, { clientRequestId: 'audit12-1', body: 'x', mcpWorkingDirectory: dirB }),
    (error) => {
      assert.equal(error.code, 'PROJECT_NOT_FOUND');
      assert.equal(typeof error.publicMessage, 'string');
      return true;
    },
  );

  const ok = await createSubmitNote(db, {
    clientRequestId: 'audit12-2', body: 'x', mcpWorkingDirectory: dirA,
  });
  assert.equal(ok.ok, true);
});

// ---------------------------------------------------------------------------
// 4. takeover 的 baseline 快照记录 lifecycle_epoch
// ---------------------------------------------------------------------------

test('takeover baseline snapshot carries the worktree lifecycle epoch', (t) => {
  const root = mkdtempSync(path.join(fixtureTempRoot(), 'ugk-audit12-takeover-'));
  t.after(() => { try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} });
  const db = openCockpitDatabase(path.join(root, 'cockpit.db'));
  t.after(() => { try { db.close(); } catch {} });

  const seed = { head: 'a'.repeat(40), branch: 'main', indexFingerprint: 'i', worktreeFingerprint: 't', coherence: 'coherent', lifecycleEpoch: 3, observedAt: new Date().toISOString() };
  // 预置一个 lifecycle_epoch=3 的 worktree：startWriteRun 的 OR IGNORE 会保留
  // 该行，它创建的 baseline 快照因此应携带 epoch 3。
  db.prepare(`
    INSERT INTO worktrees (id, canonical_path, repository_identity, identity_fingerprint, created_at, lifecycle_epoch)
    VALUES ('worktree-one', 'E:\\fixture\\audit12', 'repo-one', 'fp-one', ?, 3)
  `).run(new Date().toISOString());

  const first = startWriteRun(db, {
    commandId: 'start-first',
    runId: 'run-first',
    worktreeId: 'worktree-one',
    canonicalPath: 'E:\\fixture\\audit12',
    repositoryIdentity: 'repo-one',
    worktreeIdentity: 'fp-one',
    agentClaim: 'codex',
    goal: 'first writer',
    baseline: seed,
  });
  assert.equal(first.ok, true);

  const startEpoch = db.prepare('SELECT lifecycle_epoch FROM snapshots WHERE run_id = ? AND phase = ?')
    .get('run-first', 'baseline')?.lifecycle_epoch;
  assert.equal(startEpoch, 3);

  const takeover = takeoverWriteRun(db, {
    commandId: 'takeover-confirmed',
    worktreeId: 'worktree-one',
    previousRunId: 'run-first',
    expectedPreviousRevision: 1,
    newRunId: 'run-second',
    agentClaim: 'luna',
    goal: 'new writer',
    baseline: { ...seed, head: 'b'.repeat(40) },
    userConfirmed: true,
  });
  assert.equal(takeover.ok, true, takeover.code ?? 'takeover ok');

  const epoch = db.prepare('SELECT lifecycle_epoch FROM snapshots WHERE run_id = ? AND phase = ?')
    .get('run-second', 'baseline')?.lifecycle_epoch;
  assert.equal(epoch, 3);
});

// ---------------------------------------------------------------------------
// 5. stdio 传输：超长行被拒绝并丢弃，进程继续处理后续消息
// ---------------------------------------------------------------------------

test('stdio bridge drops an over-limit line and keeps serving', { timeout: 30000 }, async (t) => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let stdoutBuffer = '';
  stdout.on('data', (chunk) => { stdoutBuffer += chunk.toString('utf8'); });

  const handlers = {};
  const server = createMcpServer({ stdin, stdout, stderr, handlers });
  t.after(() => server.close());

  const overLimit = Buffer.alloc(25 * 1024 * 1024, 0x61);
  stdin.write(overLimit);
  stdin.write('\n');
  stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' })}\n`);

  await new Promise((resolve) => setTimeout(resolve, 500));
  const lines = stdoutBuffer.split('\n').filter((line) => line.trim().length > 0);
  assert.equal(lines.length, 2, 'one parse error for the dropped line plus one ping response');
  const overflow = JSON.parse(lines[0]);
  assert.equal(overflow.error.code, -32700);
  const pong = JSON.parse(lines[1]);
  assert.equal(pong.id, 7);
  assert.deepEqual(pong.result, {});
});

test('stdio bridge enforces the line limit across chunk boundaries', { timeout: 30000 }, async (t) => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let stdoutBuffer = '';
  stdout.on('data', (chunk) => { stdoutBuffer += chunk.toString('utf8'); });

  const server = createMcpServer({ stdin, stdout, stderr, handlers: {} });
  t.after(() => server.close());

  // 单个 chunk 各自低于上限，拼接后的完整行超过上限——上限必须仍然生效。
  stdin.write(Buffer.alloc(12 * 1024 * 1024, 0x61));
  stdin.write(Buffer.concat([Buffer.alloc(13 * 1024 * 1024, 0x62), Buffer.from('\n')]));
  stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'ping' })}\n`);

  await new Promise((resolve) => setTimeout(resolve, 500));
  const lines = stdoutBuffer.split('\n').filter((line) => line.trim().length > 0);
  assert.equal(lines.length, 2, 'overflow parse error plus the ping response, never the joined giant line');
  assert.equal(JSON.parse(lines[0]).error.code, -32700);
  assert.equal(JSON.parse(lines[1]).id, 8);
});

test('stdio bridge emits a trailing partial line at EOF like readline did', { timeout: 10000 }, async (t) => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let stdoutBuffer = '';
  stdout.on('data', (chunk) => { stdoutBuffer += chunk.toString('utf8'); });

  const server = createMcpServer({ stdin, stdout, stderr, handlers: {} });
  t.after(() => server.close());

  stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' })}`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const lines = stdoutBuffer.split('\n').filter((line) => line.trim().length > 0);
  assert.equal(lines.length, 1, 'the final newline-less message is still answered at EOF');
  assert.equal(JSON.parse(lines[0]).id, 9);
});

// ---------------------------------------------------------------------------
// 6. HTTP 层：HEAD /health、cookie Secure、会话驱逐、选择器忙
// ---------------------------------------------------------------------------

const TOKEN = 'audit-2026-09-12-test-token-that-is-long-enough';

async function bootstrapMcpSession(service, body) {
  const response = await fetch(`http://${service.host}:${service.port}/api/v1/mcp/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 201);
  return response.json();
}

test('HEAD /health answers 200 like GET', async (t) => {
  const root = mkdtempSync(path.join(fixtureTempRoot(), 'ugk-audit12-http-'));
  const service = await createCockpitHttpServer({ dbPath: path.join(root, 'cockpit.db'), token: TOKEN });
  t.after(async () => {
    await service.close();
    try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {}
  });

  const head = await fetch(`http://${service.host}:${service.port}/health`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  const get = await fetch(`http://${service.host}:${service.port}/health`);
  assert.equal(get.status, 200);
});

test('browser session cookie is marked Secure', async (t) => {
  const root = mkdtempSync(path.join(fixtureTempRoot(), 'ugk-audit12-cookie-'));
  const webRoot = path.join(root, 'web');
  mkdirSync(webRoot, { recursive: true });
  writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>x</title>');
  const service = await createCockpitHttpServer({ dbPath: path.join(root, 'cockpit.db'), token: TOKEN, webRoot });
  t.after(async () => {
    await service.close();
    try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {}
  });

  const response = await fetch(`http://${service.host}:${service.port}/`);
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie') ?? '';
  assert.match(cookie, /ugk_cockpit_session=/);
  assert.match(cookie, /Secure/i);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
});

test('anonymous bootstrap flood cannot evict a connection-handle session', async (t) => {
  const root = mkdtempSync(path.join(fixtureTempRoot(), 'ugk-audit12-evict-'));
  const service = await createCockpitHttpServer({ dbPath: path.join(root, 'cockpit.db'), token: TOKEN });
  t.after(async () => {
    await service.close();
    try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {}
  });

  const handleSession = await bootstrapMcpSession(service, { client: 'ugk-cockpit-stdio', connectionHandleVersion: 'v1' });
  for (let index = 0; index < 64; index += 1) {
    await bootstrapMcpSession(service, { client: 'ugk-cockpit-stdio' });
  }

  const probeResponse = await fetch(`http://${service.host}:${service.port}/api/v1/mcp/work/context`, {
    method: 'POST',
    headers: { authorization: `Bearer ${handleSession.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ mcpWorkingDirectory: 'C:\\nonexistent-audit12' }),
  });
  assert.notEqual(probeResponse.status, 401,
    'the handle-capable session must survive anonymous bootstrap churn');
});

test('a second folder-picker request is refused while one selection is pending', async (t) => {
  const root = mkdtempSync(path.join(fixtureTempRoot(), 'ugk-audit12-picker-'));
  let releasePicker;
  const gate = new Promise((resolve) => { releasePicker = resolve; });
  let calls = 0;
  const slowPicker = async () => {
    calls += 1;
    await gate;
    return null;
  };
  const service = await createCockpitHttpServer({
    dbPath: path.join(root, 'cockpit.db'),
    token: TOKEN,
    folderPicker: slowPicker,
  });
  t.after(async () => {
    releasePicker();
    await service.close();
    try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {}
  });

  const first = fetch(`http://${service.host}:${service.port}/api/v1/folders/select`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: '{}',
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const second = await fetch(`http://${service.host}:${service.port}/api/v1/folders/select`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(second.status, 409);
  const body = await second.json();
  assert.equal(body.code, 'FOLDER_PICKER_BUSY');

  releasePicker();
  const firstBody = await (await first).json();
  assert.equal(firstBody.ok, true);
  assert.equal(firstBody.cancelled, true);
  assert.equal(calls, 1);
});
