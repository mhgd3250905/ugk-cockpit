// 第 29 轮审计（2026-09-27）：工作台授权转交生成的「接手指令」必须指向会话真正所在的
// 工作副本。开发空间会话的工作副本是空间目录，而 `readProjectContext()` 按
// `projects.worktree_id` 联表，返回的永远是主项目目录；接手时平台按 `declaredWorkspace`
// 解析工作副本并与 `context.worktreeId` 比对，于是这条指令把目标聊天稳定地引向
// RELAY_BINDING_MISMATCH/DISPATCH_GRANT_BINDING_MISMATCH。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
    rmSync(root, { recursive: true, force: true });
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
