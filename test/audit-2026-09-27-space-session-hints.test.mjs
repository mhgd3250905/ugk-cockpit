// 第 29 轮审计（2026-09-27）：工作台授权转交生成的「接手指令」必须指向会话真正所在的
// 工作副本。开发空间会话的工作副本是空间目录，而 `readProjectContext()` 按
// `projects.worktree_id` 联表，返回的永远是主项目目录；接手时平台按 `declaredWorkspace`
// 解析工作副本并与 `context.worktreeId` 比对，于是这条指令把目标聊天稳定地引向
// RELAY_BINDING_MISMATCH/DISPATCH_GRANT_BINDING_MISMATCH。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { registerProject, readProjectContext, worktreeIdFor } from '../src/core/projects.mjs';
import { createDevelopmentSpace } from '../src/core/spaces.mjs';
import { startWriteRun } from '../src/core/runs.mjs';
import { probeGitWorktree } from '../src/git/probe.mjs';
import { createCockpitHttpServer } from '../src/service/http-server.mjs';

const TOKEN = 'space-session-hint-test-token-that-is-long-enough';

const git = (cwd, args) => {
  try {
    return execFileSync('git', args, {
      cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    throw Object.assign(new Error(`git ${args.join(' ')}: ${error.stderr ?? error.message}`), { status: error.status });
  }
};

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

function snapshot(observation) {
  return {
    head: observation.after.head,
    branch: observation.after.branch,
    indexFingerprint: observation.after.indexFingerprint,
    worktreeFingerprint: observation.after.worktreeFingerprint,
    repositoryIdentity: observation.repositoryIdentity,
    worktreeIdentity: observation.worktreeIdentity,
    headRelation: 'same',
    coherence: observation.coherence,
    observedAt: observation.observedAt,
  };
}

test('the transfer instruction names the session workspace, not the main project', async (t) => {
  const root = realpathSync(mkdtempSync(path.join(realpathSync(os.tmpdir()), 'ugk-space-hint-')));
  const mainPath = path.join(root, 'main');
  mkdirSync(mainPath, { recursive: true });
  git(mainPath, ['init', '-q', '-b', 'main']);
  git(mainPath, ['config', 'user.name', 'UGK Fixture']);
  git(mainPath, ['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(path.join(mainPath, 'README.md'), 'seed\n');
  git(mainPath, ['add', 'README.md']);
  git(mainPath, ['commit', '-q', '-m', 'seed']);
  const spacePath = path.join(root, 'space');
  git(mainPath, ['worktree', 'add', '-q', '-b', 'cockpit/work/hint', spacePath, 'HEAD']);

  const dbPath = path.join(root, 'cockpit.db');
  const db = openCockpitDatabase(dbPath);
  const mainObservation = await probeGitWorktree(mainPath);
  const spaceObservation = await probeGitWorktree(spacePath);
  const registered = registerProject(db, {
    commandId: 'register-hint-project', name: 'Hint Project', observation: mainObservation, authorizedRoot: mainPath,
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  const spaceWorktreeId = worktreeIdFor(spaceObservation.worktreeIdentity);
  const space = createDevelopmentSpace(db, {
    commandId: 'create-hint-space',
    projectId: registered.projectId,
    name: 'Hint Space',
    branch: spaceObservation.after.branch,
    baseCommit: spaceObservation.after.head,
    worktreeId: spaceWorktreeId,
    canonicalPath: spaceObservation.canonicalPath,
    repositoryIdentity: spaceObservation.repositoryIdentity,
    worktreeIdentity: spaceObservation.worktreeIdentity,
  });
  assert.equal(space.ok, true, JSON.stringify(space));

  const sessionId = 'session-hint';
  const timestamp = new Date().toISOString();
  db.prepare(`
    INSERT INTO assignments (
      id, project_id, worktree_id, agent_id, task_id, scope_json,
      status, revision, session_id, created_at, updated_at
    ) VALUES (?, ?, ?, 'Codex', 'Implement hint', '{"mode":"write"}', 'active', 1, ?, ?, ?)
  `).run('assignment-hint', registered.projectId, spaceWorktreeId, sessionId, timestamp, timestamp);
  const started = startWriteRun(db, {
    commandId: 'start-hint-run',
    runId: sessionId,
    worktreeId: spaceWorktreeId,
    canonicalPath: spaceObservation.canonicalPath,
    repositoryIdentity: spaceObservation.repositoryIdentity,
    worktreeIdentity: spaceObservation.worktreeIdentity,
    agentClaim: 'Codex',
    goal: 'Implement hint',
    baseline: snapshot(spaceObservation),
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  // 缺陷前提：会话所在工作副本与主项目目录确实是两个不同路径。
  const mainCanonicalPath = readProjectContext(db, registered.projectId).canonical_path;
  assert.notEqual(mainCanonicalPath, spaceObservation.canonicalPath);
  db.prepare(`
    INSERT INTO conversation_bindings (
      conversation_key, worktree_id, session_id, relay_id, relay_sequence,
      accepted_revision, revoked, bound_at, binding_kind, owner_host, owner_locator
    ) VALUES (?, ?, ?, NULL, NULL, 1, 0, ?, 'host', 'codex', 'chat-owner')
  `).run('key-hint-owner', spaceWorktreeId, sessionId, timestamp);
  db.close();

  const service = await createCockpitHttpServer({ dbPath, token: TOKEN });
  t.after(async () => {
    await service.close();
    removeWithRetry(root);
  });
  const baseUrl = `http://${service.host}:${service.port}`;
  const shell = await fetch(`${baseUrl}/`);
  const cookie = shell.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie, '夹具需要浏览器会话 cookie');

  const response = await fetch(
    `${baseUrl}/api/v1/projects/${registered.projectId}/conversation-control/${sessionId}/transfer`,
    {
      method: 'POST',
      headers: {
        cookie, origin: baseUrl, 'sec-fetch-site': 'same-origin',
        'x-ugk-client-id': 'space-hint-browser', 'content-type': 'application/json',
      },
      body: JSON.stringify({ clientRequestId: 'transfer-hint-1', expectedRevision: 1 }),
    },
  );
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.ok(result.transferCode, JSON.stringify(result));
  assert.ok(
    result.continueMessage.includes(spaceObservation.canonicalPath),
    `接手指令必须给出会话所在的工作副本目录: ${result.continueMessage}`,
  );
  assert.ok(
    !result.continueMessage.includes(mainCanonicalPath),
    '接手指令不得把主项目目录当作目标项目目录',
  );
});

// 反向界：主检出上的会话仍要拿到主项目目录，修复不得把提示改偏。
test('a session on the main checkout still gets the main directory', async (t) => {
  const root = realpathSync(mkdtempSync(path.join(realpathSync(os.tmpdir()), 'ugk-main-hint-')));
  const mainPath = path.join(root, 'main');
  mkdirSync(mainPath, { recursive: true });
  git(mainPath, ['init', '-q', '-b', 'main']);
  git(mainPath, ['config', 'user.name', 'UGK Fixture']);
  git(mainPath, ['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(path.join(mainPath, 'README.md'), 'seed\n');
  git(mainPath, ['add', 'README.md']);
  git(mainPath, ['commit', '-q', '-m', 'seed']);

  const dbPath = path.join(root, 'cockpit.db');
  const db = openCockpitDatabase(dbPath);
  const mainObservation = await probeGitWorktree(mainPath);
  const registered = registerProject(db, {
    commandId: 'register-main-hint', name: 'Main Hint', observation: mainObservation, authorizedRoot: mainPath,
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  const mainWorktreeId = worktreeIdFor(mainObservation.worktreeIdentity);
  const sessionId = 'session-main-hint';
  const timestamp = new Date().toISOString();
  db.prepare(`
    INSERT INTO assignments (
      id, project_id, worktree_id, agent_id, task_id, scope_json,
      status, revision, session_id, created_at, updated_at
    ) VALUES (?, ?, ?, 'Codex', 'Implement main', '{"mode":"write"}', 'active', 1, ?, ?, ?)
  `).run('assignment-main-hint', registered.projectId, mainWorktreeId, sessionId, timestamp, timestamp);
  const started = startWriteRun(db, {
    commandId: 'start-main-hint-run',
    runId: sessionId,
    worktreeId: mainWorktreeId,
    canonicalPath: mainObservation.canonicalPath,
    repositoryIdentity: mainObservation.repositoryIdentity,
    worktreeIdentity: mainObservation.worktreeIdentity,
    agentClaim: 'Codex',
    goal: 'Implement main',
    baseline: snapshot(mainObservation),
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  db.prepare(`
    INSERT INTO conversation_bindings (
      conversation_key, worktree_id, session_id, relay_id, relay_sequence,
      accepted_revision, revoked, bound_at, binding_kind, owner_host, owner_locator
    ) VALUES (?, ?, ?, NULL, NULL, 1, 0, ?, 'host', 'codex', 'chat-owner-main')
  `).run('key-main-hint-owner', mainWorktreeId, sessionId, timestamp);
  db.close();

  const service = await createCockpitHttpServer({ dbPath, token: TOKEN });
  t.after(async () => {
    await service.close();
    removeWithRetry(root);
  });
  const baseUrl = `http://${service.host}:${service.port}`;
  const shell = await fetch(`${baseUrl}/`);
  const cookie = shell.headers.get('set-cookie')?.split(';')[0];
  const response = await fetch(
    `${baseUrl}/api/v1/projects/${registered.projectId}/conversation-control/${sessionId}/transfer`,
    {
      method: 'POST',
      headers: {
        cookie, origin: baseUrl, 'sec-fetch-site': 'same-origin',
        'x-ugk-client-id': 'main-hint-browser', 'content-type': 'application/json',
      },
      body: JSON.stringify({ clientRequestId: 'transfer-main-hint-1', expectedRevision: 1 }),
    },
  );
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.ok(result.continueMessage.includes(mainObservation.canonicalPath), result.continueMessage);
});

// 重发 init 指令（adopt）也必须落在会话所在的工作副本上。
test('a reissued init instruction names the assigned workspace', async (t) => {
  const root = realpathSync(mkdtempSync(path.join(realpathSync(os.tmpdir()), 'ugk-reissue-hint-')));
  const mainPath = path.join(root, 'main');
  mkdirSync(mainPath, { recursive: true });
  git(mainPath, ['init', '-q', '-b', 'main']);
  git(mainPath, ['config', 'user.name', 'UGK Fixture']);
  git(mainPath, ['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(path.join(mainPath, 'README.md'), 'seed\n');
  git(mainPath, ['add', 'README.md']);
  git(mainPath, ['commit', '-q', '-m', 'seed']);
  const spacePath = path.join(root, 'space');
  git(mainPath, ['worktree', 'add', '-q', '-b', 'cockpit/work/reissue', spacePath, 'HEAD']);

  const dbPath = path.join(root, 'cockpit.db');
  const db = openCockpitDatabase(dbPath);
  const mainObservation = await probeGitWorktree(mainPath);
  const spaceObservation = await probeGitWorktree(spacePath);
  const registered = registerProject(db, {
    commandId: 'register-reissue', name: 'Reissue', observation: mainObservation, authorizedRoot: mainPath,
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  const spaceWorktreeId = worktreeIdFor(spaceObservation.worktreeIdentity);
  const space = createDevelopmentSpace(db, {
    commandId: 'create-reissue-space',
    projectId: registered.projectId,
    name: 'Reissue Space',
    branch: spaceObservation.after.branch,
    baseCommit: spaceObservation.after.head,
    worktreeId: spaceWorktreeId,
    canonicalPath: spaceObservation.canonicalPath,
    repositoryIdentity: spaceObservation.repositoryIdentity,
    worktreeIdentity: spaceObservation.worktreeIdentity,
  });
  assert.equal(space.ok, true, JSON.stringify(space));
  db.close();

  const service = await createCockpitHttpServer({ dbPath, token: TOKEN });
  t.after(async () => {
    await service.close();
    removeWithRetry(root);
  });
  const baseUrl = `http://${service.host}:${service.port}`;
  const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  const created = await fetch(`${baseUrl}/api/v1/projects/${registered.projectId}/assignments`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      clientRequestId: 'reissue-assign-1', agent: 'Codex', mode: 'init',
      task: '重发指令核对', spaceId: space.spaceId,
    }),
  });
  const createdBody = await created.json();
  assert.equal(created.status, 201, JSON.stringify(createdBody));
  assert.ok(
    createdBody.message.includes(spaceObservation.canonicalPath),
    `新建 init 指令要指向空间目录: ${createdBody.message}`,
  );

  const reissued = await fetch(`${baseUrl}/api/v1/projects/${registered.projectId}/assignments/reissue`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ clientRequestId: 'reissue-1', mode: 'init', spaceId: space.spaceId }),
  });
  const reissueBody = await reissued.json();
  assert.equal(reissued.status, 200, JSON.stringify(reissueBody));
  assert.ok(
    reissueBody.message?.includes(spaceObservation.canonicalPath),
    `重发的 init 指令必须仍指向空间目录，否则接手必然错配: ${reissueBody.message}`,
  );
  assert.ok(!reissueBody.message.includes(mainObservation.canonicalPath), '重发指令不得给出主检出目录');
});
