import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { pushSubmissionBranch } from '../src/git/submit-ops.mjs';
import { pushIntegratedMain } from '../src/git/integration-ops.mjs';
import { validateRemoteUrlSecurity } from '../src/git/delivery-ops.mjs';
import { probeGitWorktree } from '../src/git/probe.mjs';
import { acquireDeliveryIndexLock, releaseDeliveryIndexLock } from '../src/git/delivery-index-lock.mjs';
import { createMcpStdioServer } from '../src/mcp/stdio-protocol.mjs';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { registerProject } from '../src/core/projects.mjs';
import { createCockpitHttpServer } from '../src/service/http-server.mjs';

// POSIX 的系统临时目录（/tmp、/var）本身是符号链接；产品路径授权按契约拒绝
// 穿越链接的路径，夹具必须建立在真实路径下，否则授权在业务断言前就失败。
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

function createCommitFixture(t, prefix) {
  const root = mkdtempSync(path.join(fixtureTempRoot(), prefix));
  t.after(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  });
  gitSync(root, ['init', '-b', 'main', root]);
  gitSync(root, ['config', 'user.email', 'ugk@example.invalid']);
  gitSync(root, ['config', 'user.name', 'UGK Test']);
  writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  gitSync(root, ['add', 'README.md']);
  gitSync(root, ['commit', '--quiet', '-m', 'fixture']);
  return root;
}

test('push through submit path refuses a self-authorized ext:: remote without executing it', async (t) => {
  const base = mkdtempSync(path.join(fixtureTempRoot(), 'ugk-audit-ext-'));
  t.after(() => {
    try { rmSync(base, { recursive: true, force: true }); } catch {}
  });
  const repo = path.join(base, 'repo');
  const bare = path.join(base, 'remote.git');
  gitSync(base, ['init', '--bare', '-b', 'main', bare]);
  gitSync(base, ['init', '-b', 'main', repo]);
  gitSync(repo, ['config', 'user.email', 'ugk@example.invalid']);
  gitSync(repo, ['config', 'user.name', 'UGK Test']);
  writeFileSync(path.join(repo, 'a.txt'), 'content');
  gitSync(repo, ['add', 'a.txt']);
  gitSync(repo, ['commit', '--quiet', '-m', 'init']);
  gitSync(repo, ['remote', 'add', 'origin', bare]);

  // A hostile repository can set both values in its own local config.
  const marker = path.join(base, 'pwned.txt');
  const helperUrl = `ext::cmd /c echo PWNED > ${marker.split(path.sep).join('/')}`;
  gitSync(repo, ['config', 'protocol.ext.allow', 'always']);
  gitSync(repo, ['config', 'remote.origin.url', helperUrl]);

  await assert.rejects(
    () => pushSubmissionBranch(repo, { remote: 'origin', branch: 'main' }),
  );
  assert.equal(existsSync(marker), false,
    'repo-local protocol.ext.allow must not survive the hardened git prefix');

  // The integration merge/push path enforces the same URL policy.
  gitSync(repo, ['config', 'remote.origin.url', helperUrl]);
  await assert.rejects(
    () => pushIntegratedMain(repo, { remote: 'origin', branch: 'main' }),
  );
  assert.equal(existsSync(marker), false,
    'integration push must validate the resolved remote URL before any network op');

  // A pushInsteadOf rewrite redirects the push destination that plain
  // `remote get-url` never shows; the push-mode resolution must see it.
  const marker2 = path.join(base, 'pwned2.txt');
  const redirectUrl = `ext::cmd /c echo PWNED > ${marker2.split(path.sep).join('/')}`;
  gitSync(repo, ['config', 'remote.origin.url', bare]);
  gitSync(repo, ['config', `url.${redirectUrl.replace(/"/g, '')}.pushInsteadOf`, bare]);
  await assert.rejects(
    () => pushSubmissionBranch(repo, { remote: 'origin', branch: 'main' }),
    (error) => error.code === 'UNSAFE_REMOTE_URL',
  );
  assert.equal(existsSync(marker2), false,
    'pushInsteadOf-rewritten destinations must be validated before pushing');
  gitSync(repo, ['config', '--remove-section', `url.${redirectUrl}`]);

  // Positive control: the same hardened path still pushes to a plain local remote.
  gitSync(repo, ['config', 'remote.origin.url', bare]);
  await pushSubmissionBranch(repo, { remote: 'origin', branch: 'main' });
  const pushed = execFileSync('git', ['--git-dir', bare, 'rev-parse', 'refs/heads/main'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const local = gitSync(repo, ['rev-parse', 'refs/heads/main']);
  assert.equal(pushed, local);
  await pushIntegratedMain(repo, { remote: 'origin', branch: 'main' });
});

test('remote URL rejections never echo the submitted URL (credential hygiene)', () => {
  const secret = 'Sup3rSecret';
  const cases = [
    `ssh://user:${secret}@host::/x`,
    `https://user:${secret}@:80/x`,
    `https://user:${secret}@ho st/x`,
    `ssh://user:${secret}@-host/path`,
  ];
  for (const url of cases) {
    try {
      validateRemoteUrlSecurity(url);
      assert.fail(`expected rejection for ${new URL('https://redacted.invalid')}`);
    } catch (error) {
      assert.equal(error.message.includes(secret), false,
        `error message leaked credentials for a rejected remote URL: ${error.message}`);
    }
  }
});

test('probe reports unreadable history as an error, not a diverged topology claim', async (t) => {
  const root = createCommitFixture(t, 'ugk-audit-probe-');
  const observation = await probeGitWorktree(root);
  assert.equal(observation.headRelation, 'unknown');

  const bogusBaseline = 'f'.repeat(40);
  // An unreadable baseline is not a topology answer: the probe stays alive so
  // finish flows can still report precise identity errors, but reports the
  // honest 'unknown' instead of a fabricated 'diverged'.
  const unreadable = await probeGitWorktree(root, { expectedBaselineHead: bogusBaseline });
  assert.equal(unreadable.headRelation, 'unknown');
  // A real ancestor baseline still classifies normally.
  const firstCommit = gitSync(root, ['rev-parse', 'HEAD~0']);
  writeFileSync(path.join(root, 'more.txt'), 'x');
  gitSync(root, ['add', 'more.txt']);
  gitSync(root, ['commit', '--quiet', '-m', 'second']);
  const root2 = await probeGitWorktree(root, { expectedBaselineHead: firstCommit });
  assert.equal(root2.headRelation, 'descendant');
});

test('delivery index lock release never masks the caller outcome', (t) => {
  const root = mkdtempSync(path.join(fixtureTempRoot(), 'ugk-audit-lock-'));
  t.after(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  });
  const indexPath = path.join(root, 'index');

  const lock = acquireDeliveryIndexLock(indexPath, 'audit-command');
  assert.equal(releaseDeliveryIndexLock(lock), true);
  // Round trip: a released lock can be acquired again in the same process.
  const again = acquireDeliveryIndexLock(indexPath, 'audit-command-2');
  assert.equal(releaseDeliveryIndexLock(again), true);

  // A release whose fd is already gone (EBADF) must not throw: the caller's
  // finally block holds the real business result.
  const leaked = acquireDeliveryIndexLock(indexPath, 'audit-command-3');
  closeSync(leaked.fd);
  assert.doesNotThrow(() => releaseDeliveryIndexLock(leaked));
});

test('stdio bridge aborts in-flight work when the host closes stdin', async (t) => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdout.destroy();
  const stderr = new PassThrough();
  let shutdowns = 0;
  const server = createMcpStdioServer({
    stdin,
    stdout,
    stderr,
    handlers: {},
    onShutdown: () => { shutdowns += 1; },
  });
  t.after(() => {
    try { server.close(); } catch {}
  });

  // A destroyed stdout must not crash the process when a response is written.
  stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 50));

  stdin.end();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shutdowns, 1, 'stdin EOF must reach onShutdown exactly once');

  // close() after EOF stays idempotent.
  server.close();
  assert.equal(shutdowns, 1);
});

const TOKEN = 'audit-http-test-token-that-is-long-enough';

async function post(service, pathname, body) {
  return fetch(`http://${service.host}:${service.port}${pathname}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('transport accepts relay payloads at the stdio gate width (beyond the old 64KB cap)', async (t) => {
  const root = createCommitFixture(t, 'ugk-audit-relay-http-');
  const dbPath = path.join(root, 'cockpit.db');
  const { probeGitWorktree: probe } = await import('../src/git/probe.mjs');
  const observation = await probe(root);
  const db = openCockpitDatabase(dbPath);
  const project = registerProject(db, {
    commandId: 'register-audit-relay-fixture',
    name: 'Audit relay fixture',
    authorizedRoot: root,
    observation,
  });
  db.close();

  const service = await createCockpitHttpServer({ dbPath, token: TOKEN });
  t.after(async () => {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  });

  const assignmentResponse = await post(
    service,
    `/api/v1/projects/${project.projectId}/assignments`,
    { clientRequestId: 'audit-relay-assignment', agent: 'Codex', mode: 'init', task: '验证大载荷 relay' },
  );
  assert.equal(assignmentResponse.status, 201, await assignmentResponse.clone().text());
  const assignment = await assignmentResponse.json();
  const initCode = assignment.message.match(/initCode: "([^\"]+)"/)?.[1];
  assert.ok(initCode);

  const initResponse = await post(service, '/api/v1/mcp/work/init', {
    initCode,
    clientRequestId: 'audit-relay-init',
    currentTask: '验证大载荷 relay',
    currentState: '已接入',
    mcpWorkingDirectory: root,
  });
  assert.equal(initResponse.status, 200, await initResponse.clone().text());
  const initialized = await initResponse.json();

  // 20 items × 4000 chars ≈ 82KB of JSON: legal for the stdio gate and the
  // core contract (MAX_LIST_ITEMS=100, MAX_ITEM_LENGTH=4000), but larger than
  // the previous transport cap that rejected it with REQUEST_TOO_LARGE.
  const bigItems = Array.from({ length: 20 }, (_, index) => `${'x'.repeat(3990)}-${index}`);
  const relayResponse = await post(service, '/api/v1/mcp/work/relay', {
    sessionId: initialized.sessionId,
    clientRequestId: 'audit-relay-create',
    expectedRevision: initialized.revision,
    nextSessionFocus: '继续同一工作会话',
    summary: '已准备接力',
    currentState: '原会话仍 active 并持有写入权限',
    completedItems: bigItems,
    pendingItems: ['由新会话继续'],
    decisions: [],
    artifactRefs: [],
    risks: [],
    suggestedSkills: [],
  });
  assert.equal(relayResponse.status, 200, await relayResponse.clone().text());
  const prepared = await relayResponse.json();
  assert.equal(prepared.ok, true);
  assert.equal(prepared.relayPrepared, true);

  // A verbatim replay must reach the idempotency layer — that is exactly the
  // promise the stdio gate width exists to keep.
  const replayResponse = await post(service, '/api/v1/mcp/work/relay', {
    sessionId: initialized.sessionId,
    clientRequestId: 'audit-relay-create',
    expectedRevision: initialized.revision,
    nextSessionFocus: '继续同一工作会话',
    summary: '已准备接力',
    currentState: '原会话仍 active 并持有写入权限',
    completedItems: bigItems,
    pendingItems: ['由新会话继续'],
    decisions: [],
    artifactRefs: [],
    risks: [],
    suggestedSkills: [],
  });
  assert.equal(replayResponse.status, 200, await replayResponse.clone().text());
  const replayed = await replayResponse.json();
  assert.equal(replayed.ok, true);
  assert.equal(replayed.relayId, prepared.relayId);
});

test('transport accepts finish acknowledgements at the stdio gate width', async (t) => {
  const root = createCommitFixture(t, 'ugk-audit-finish-http-');
  const dbPath = path.join(root, 'cockpit.db');
  const observation = await probeGitWorktree(root);
  const db = openCockpitDatabase(dbPath);
  const project = registerProject(db, {
    commandId: 'register-audit-finish-fixture',
    name: 'Audit finish fixture',
    authorizedRoot: root,
    observation,
  });
  db.close();

  const service = await createCockpitHttpServer({ dbPath, token: TOKEN });
  t.after(async () => {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  });

  const assignmentResponse = await post(
    service,
    `/api/v1/projects/${project.projectId}/assignments`,
    { clientRequestId: 'audit-finish-assignment', agent: 'Codex', mode: 'init', task: '验证大载荷 finish' },
  );
  assert.equal(assignmentResponse.status, 201, await assignmentResponse.clone().text());
  const assignment = await assignmentResponse.json();
  const initCode = assignment.message.match(/initCode: "([^\"]+)"/)?.[1];
  assert.ok(initCode);

  const initResponse = await post(service, '/api/v1/mcp/work/init', {
    initCode,
    clientRequestId: 'audit-finish-init',
    currentTask: '验证大载荷 finish',
    currentState: '已接入',
    mcpWorkingDirectory: root,
  });
  assert.equal(initResponse.status, 200, await initResponse.clone().text());
  const initialized = await initResponse.json();

  // 100 × 4000 chars ≈ 400KB: admitted by the stdio gate for
  // acknowledgements, and wider than the previous 64KB transport cap.
  const acknowledgements = Array.from({ length: 100 }, (_, index) => `${'y'.repeat(3980)}-${index}`);
  const finishResponse = await post(service, '/api/v1/mcp/work/finish', {
    sessionId: initialized.sessionId,
    clientRequestId: 'audit-finish-complete',
    expectedRevision: initialized.revision,
    outcome: 'completed',
    summary: '本轮工作完成',
    nextStep: '等待用户安排',
    acknowledgements,
  });
  assert.equal(finishResponse.status, 200, await finishResponse.clone().text());
  const finished = await finishResponse.json();
  assert.equal(finished.ok, true);
  assert.equal(finished.cockpitVerified, true);
  assert.equal(finished.status, 'completed');
});

function remoteHeadOrNull(barePath) {
  try {
    return execFileSync('git', ['--git-dir', barePath, 'rev-parse', 'refs/heads/main'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

test('a safe first pushurl must not let a later helper-transport pushurl execute', async (t) => {
  const base = mkdtempSync(path.join(fixtureTempRoot(), 'ugk-audit-multiurl-'));
  t.after(() => {
    try { rmSync(base, { recursive: true, force: true }); } catch {}
  });
  const repo = path.join(base, 'repo');
  const bare = path.join(base, 'good.git');
  const helperDir = path.join(base, 'bin');
  mkdirSync(helperDir);
  gitSync(base, ['init', '--bare', '-b', 'main', bare]);
  gitSync(base, ['init', '-b', 'main', repo]);
  gitSync(repo, ['config', 'user.email', 'ugk@example.invalid']);
  gitSync(repo, ['config', 'user.name', 'UGK Test']);
  writeFileSync(path.join(repo, 'a.txt'), 'content');
  gitSync(repo, ['add', 'a.txt']);
  gitSync(repo, ['commit', '--quiet', '-m', 'init']);
  gitSync(repo, ['remote', 'add', 'origin', bare]);
  // git pushes to EVERY pushurl: the first destination is legitimate, the
  // second hides a self-authorized custom helper behind a safe-looking entry.
  gitSync(repo, ['config', '--add', 'remote.origin.pushurl', bare]);
  gitSync(repo, ['config', '--add', 'remote.origin.pushurl', 'auditprobe::target']);
  gitSync(repo, ['config', 'protocol.auditprobe.allow', 'always']);

  const helperScript = path.join(helperDir, 'git-remote-auditprobe');
  writeFileSync(helperScript, '#!/bin/sh\necho PWNED > "$0.marker"\nexit 0\n');
  chmodSync(helperScript, 0o755);
  const marker = `${helperScript}.marker`;
  const originalPath = process.env.PATH;
  process.env.PATH = `${helperDir}${path.delimiter}${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });

  await assert.rejects(
    () => pushSubmissionBranch(repo, { remote: 'origin', branch: 'main' }),
    (error) => error.code === 'UNSAFE_REMOTE_URL',
  );
  assert.equal(existsSync(marker), false,
    'validation must reject the helper-transport pushurl before any push starts');
  assert.equal(remoteHeadOrNull(bare), null,
    'a rejected multi-destination push must not have contacted the first (safe) destination either');

  await assert.rejects(
    () => pushIntegratedMain(repo, { remote: 'origin', branch: 'main' }),
    (error) => error.code === 'UNSAFE_REMOTE_URL',
  );
  assert.equal(existsSync(marker), false);
  assert.equal(remoteHeadOrNull(bare), null);
});

test('a worktree-relative remote path is resolved against the worktree, not the service cwd', async (t) => {
  const repo = mkdtempSync(path.join(fixtureTempRoot(), 'ugk-audit-relurl-'));
  t.after(() => {
    try { rmSync(repo, { recursive: true, force: true }); } catch {}
  });
  const bare = path.join(repo, 'remotes', 'local.git');
  mkdirSync(path.dirname(bare));
  gitSync(repo, ['init', '--bare', '-b', 'main', bare]);
  gitSync(repo, ['init', '-b', 'main', repo]);
  gitSync(repo, ['config', 'user.email', 'ugk@example.invalid']);
  gitSync(repo, ['config', 'user.name', 'UGK Test']);
  writeFileSync(path.join(repo, 'a.txt'), 'content');
  gitSync(repo, ['add', 'a.txt']);
  gitSync(repo, ['commit', '--quiet', '-m', 'init']);
  // No ./ prefix: git resolves this relative remote against its own cwd (the
  // worktree), and the validation must do the same instead of consulting the
  // service process's working directory.
  gitSync(repo, ['remote', 'add', 'origin', 'remotes/local.git']);
  assert.notEqual(process.cwd(), repo, 'fixture assumes the test process runs outside the worktree');

  await pushSubmissionBranch(repo, { remote: 'origin', branch: 'main' });
  const localHead = gitSync(repo, ['rev-parse', 'refs/heads/main']);
  assert.equal(remoteHeadOrNull(bare), localHead,
    'a legitimate worktree-relative remote must still receive the push');

  await pushIntegratedMain(repo, { remote: 'origin', branch: 'main' });
  assert.equal(remoteHeadOrNull(bare), localHead);
});
