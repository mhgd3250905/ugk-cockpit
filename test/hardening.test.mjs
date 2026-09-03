import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acquireInstanceLock } from '../src/core/single-instance.mjs';
import { serveWebAsset } from '../src/service/web-assets.mjs';
import {
  createSubmissionCommit,
  ensureLocalCommitIdentity,
  pushSubmissionBranch,
} from '../src/git/submit-ops.mjs';
import { pushIntegratedMain } from '../src/git/integration-ops.mjs';
import { remoteAuthArguments } from '../src/git/remote-auth.mjs';

function createMockResponse() {
  let statusCode = null;
  let headers = {};
  let body = null;
  return {
    writeHead(status, hdrs) {
      statusCode = status;
      headers = { ...headers, ...hdrs };
    },
    end(content) {
      body = content;
    },
    get status() {
      return statusCode;
    },
    get headers() {
      return headers;
    },
    get body() {
      return body;
    },
  };
}

test('single-instance: lock.release() is idempotent and does not throw on multiple calls', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-lock-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lockFile = path.join(root, 'service.lock');
  const lock = acquireInstanceLock(lockFile);

  assert.doesNotThrow(() => {
    lock.release();
  });
  // Second release should be a safe no-op, never throwing EBADF
  assert.doesNotThrow(() => {
    lock.release();
  });
});

test('web-assets: dist/web 存在时优先提供 dist 资源（不降级）', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-dist-web-priority-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const customDist = path.join(root, 'dist-web');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(customDist, { recursive: true });
  writeFileSync(path.join(customDist, 'index.html'), '<!DOCTYPE html><html><head><title>Dist Priority Build</title></head><body>Dist</body></html>');

  const response = createMockResponse();
  const served = await serveWebAsset({
    request: { method: 'GET' },
    response,
    pathname: '/',
    webRoot: customDist,
    sessionToken: 'test-session-token-dist',
  });

  assert.equal(served, true);
  assert.equal(response.status, 200);
  assert.match(response.body.toString('utf8'), /Dist Priority Build/);
  assert.doesNotMatch(response.body.toString('utf8'), /UGK Cockpit/);
});

test('web-assets: serveWebAsset falls back to source web/ when dist/web does not exist', async () => {
  const nonexistentWebRoot = path.resolve('nonexistent-dist-web-dir-' + Date.now());
  const response = createMockResponse();

  const served = await serveWebAsset({
    request: { method: 'GET' },
    response,
    pathname: '/',
    webRoot: nonexistentWebRoot,
    sessionToken: 'test-session-token-123',
  });

  assert.equal(served, true);
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /text\/html/);
  assert.match(response.headers['set-cookie'], /ugk_cockpit_session=test-session-token-123/);
  assert.match(response.body.toString('utf8'), /UGK Cockpit/);

  // Also test asset fallback
  const assetResponse = createMockResponse();
  const assetServed = await serveWebAsset({
    request: { method: 'GET' },
    response: assetResponse,
    pathname: '/assets/theme-boot.js',
    webRoot: nonexistentWebRoot,
    sessionToken: 'test-session-token-123',
  });

  assert.equal(assetServed, true);
  assert.equal(assetResponse.status, 200);
  assert.match(assetResponse.headers['content-type'], /javascript/);
  assert.match(assetResponse.body.toString('utf8'), /ugk-cockpit-theme/);
});

test('submit-ops: ensureLocalCommitIdentity 用 GIT_CONFIG_GLOBAL fixture 固定身份来源解析', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-git-identity-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // Create isolated global gitconfig fixture
  const fixtureGitConfig = path.join(root, 'fixture.gitconfig');
  writeFileSync(fixtureGitConfig, `[user]\n\tname = Fixture Author\n\temail = fixture@example.org\n`);

  const repo = path.join(root, 'repo');
  execFileSync('git', ['init', '-b', 'main', repo], { windowsHide: true, stdio: 'ignore' });

  // Resolve identity using the isolated fixture config
  const identity = await ensureLocalCommitIdentity(repo, { globalConfigPath: fixtureGitConfig });
  assert.equal(identity.name, 'Fixture Author');
  assert.equal(identity.email, 'fixture@example.org');
});

test('submit-ops: ensureLocalCommitIdentity throws COMMIT_IDENTITY_MISSING when git author cannot be found', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-no-identity-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  execFileSync('git', ['init', '-b', 'main', repo], { windowsHide: true, stdio: 'ignore' });

  const emptyConfig = path.join(root, 'empty.gitconfig');
  writeFileSync(emptyConfig, '');

  const originalAuthorName = process.env.GIT_AUTHOR_NAME;
  const originalAuthorEmail = process.env.GIT_AUTHOR_EMAIL;
  const originalCommitterName = process.env.GIT_COMMITTER_NAME;
  const originalCommitterEmail = process.env.GIT_COMMITTER_EMAIL;

  delete process.env.GIT_AUTHOR_NAME;
  delete process.env.GIT_AUTHOR_EMAIL;
  delete process.env.GIT_COMMITTER_NAME;
  delete process.env.GIT_COMMITTER_EMAIL;

  try {
    await assert.rejects(async () => {
      await ensureLocalCommitIdentity(repo, { globalConfigPath: emptyConfig });
    }, (err) => {
      assert.equal(err.code, 'COMMIT_IDENTITY_MISSING');
      return true;
    });
  } finally {
    if (originalAuthorName !== undefined) process.env.GIT_AUTHOR_NAME = originalAuthorName;
    if (originalAuthorEmail !== undefined) process.env.GIT_AUTHOR_EMAIL = originalAuthorEmail;
    if (originalCommitterName !== undefined) process.env.GIT_COMMITTER_NAME = originalCommitterName;
    if (originalCommitterEmail !== undefined) process.env.GIT_COMMITTER_EMAIL = originalCommitterEmail;
  }
});

test('submit-ops: createSubmissionCommit commits cleanly under sandboxed environment using discovered identity', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-git-commit-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  execFileSync('git', ['init', '-b', 'main', repo], { windowsHide: true, stdio: 'ignore' });

  const fixtureGitConfig = path.join(root, 'fixture.gitconfig');
  writeFileSync(fixtureGitConfig, `[user]\n\tname = Sandbox Committer\n\temail = sandbox@example.org\n`);

  const identity = await ensureLocalCommitIdentity(repo, { globalConfigPath: fixtureGitConfig });
  writeFileSync(path.join(repo, 'file.txt'), 'content\n');
  execFileSync('git', ['add', 'file.txt'], { cwd: repo, windowsHide: true, stdio: 'ignore' });

  await assert.doesNotReject(async () => {
    await createSubmissionCommit(repo, {
      summary: 'test commit',
      commandId: 'cmd-test-123',
      authorName: identity.name,
      authorEmail: identity.email,
    });
  });

  const log = execFileSync('git', ['log', '-1', '--format=%an <%ae>%n%B'], { cwd: repo, encoding: 'utf8', windowsHide: true });
  assert.match(log, /Sandbox Committer <sandbox@example.org>/);
  assert.match(log, /UGK-Cockpit-Command: cmd-test-123/);
});

test('push-ops: remoteAuthArguments provides credential helper for push on win32 and push succeeds', async (t) => {
  // Test remoteAuthArguments behavior
  const nonPushArgs = await remoteAuthArguments(['status'], 'win32');
  assert.deepEqual(nonPushArgs, []);

  const nonWinPush = await remoteAuthArguments(['push'], 'linux');
  assert.deepEqual(nonWinPush, []);

  if (process.platform === 'win32') {
    const winPush = await remoteAuthArguments(['push'], 'win32');
    if (winPush.length > 0) {
      assert.equal(winPush[0], '-c');
      assert.match(winPush[1], /credential\.helper=/);
    }
  }

  // Verify end-to-end push with remoteAuthArguments
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-git-push-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bareRemote = path.join(root, 'remote.git');
  const repo = path.join(root, 'repo');

  execFileSync('git', ['init', '--bare', bareRemote], { windowsHide: true, stdio: 'ignore' });
  execFileSync('git', ['init', '-b', 'main', repo], { windowsHide: true, stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', bareRemote], { cwd: repo, windowsHide: true, stdio: 'ignore' });

  const fixtureGitConfig = path.join(root, 'fixture.gitconfig');
  writeFileSync(fixtureGitConfig, `[user]\n\tname = Pusher\n\temail = pusher@example.org\n`);

  const identity = await ensureLocalCommitIdentity(repo, { globalConfigPath: fixtureGitConfig });
  writeFileSync(path.join(repo, 'file.txt'), 'hello\n');
  execFileSync('git', ['add', 'file.txt'], { cwd: repo, windowsHide: true, stdio: 'ignore' });
  await createSubmissionCommit(repo, {
    summary: 'seed commit',
    commandId: 'cmd-seed',
    authorName: identity.name,
    authorEmail: identity.email,
  });

  await assert.doesNotReject(async () => {
    await pushSubmissionBranch(repo, { remote: 'origin', branch: 'main' });
  });

  writeFileSync(path.join(repo, 'file2.txt'), 'hello2\n');
  execFileSync('git', ['add', 'file2.txt'], { cwd: repo, windowsHide: true, stdio: 'ignore' });
  await createSubmissionCommit(repo, {
    summary: 'second commit',
    commandId: 'cmd-second',
    authorName: identity.name,
    authorEmail: identity.email,
  });

  await assert.doesNotReject(async () => {
    await pushIntegratedMain(repo, { remote: 'origin', branch: 'main' });
  });
});

test('http-server: GET / returns 503 SERVICE_UNAVAILABLE when assets cannot be served', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-http-503-test-'));
  const { createCockpitHttpServer } = await import('../src/service/http-server.mjs');
  const service = await createCockpitHttpServer({
    dbPath: path.join(root, 'cockpit.db'),
    token: 'a'.repeat(32),
    serveWebAsset: async () => false,
  });
  t.after(async () => {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  });

  const response = await fetch(`http://127.0.0.1:${service.port}/`, {
    headers: { accept: 'text/html' },
  });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.code, 'SERVICE_UNAVAILABLE');
  assert.match(body.message, /本地控制台静态资源暂不可用/);
  assert.equal(body.impact, '代码和已有记录都没有被修改。');
  assert.equal(body.required_action, '请确认前端资源已构建或服务环境完整后重试。');
});
