import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { createCockpitHttpServer } from '../src/service/http-server.mjs';

const TOKEN = 'folder-project-test-token-that-is-long-enough';

function directoryContents(root) {
  return readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map((entry) => ({
    name: entry.name,
    content: entry.isDirectory()
      ? directoryContents(path.join(root, entry.name))
      : readFileSync(path.join(root, entry.name)).toString('base64'),
  }));
}

async function fixture(t) {
  const container = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'ugk-folder-project-'));
  const folder = path.join(container, 'selected-folder');
  mkdirSync(folder);
  const dbPath = path.join(container, 'cockpit.db');
  let service;
  const start = async () => {
    service = await createCockpitHttpServer({ dbPath, token: TOKEN, folderPicker: async () => folder });
  };
  t.after(async () => {
    await service?.close();
    rmSync(container, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await start();
  return {
    container, folder, dbPath,
    async restart() {
      await service.close();
      service = null;
      await start();
    },
    async request(route, body) {
      const response = await fetch(`http://${service.host}:${service.port}${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

async function select(f) {
  const result = await f.request('/api/v1/folders/select', {});
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.ok(result.body.grantId);
  return result.body.grantId;
}

async function assertVisible(f, projectId) {
  const dashboard = await f.request('/api/v1/dashboard');
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.body.projects.length, 1);
  const project = dashboard.body.projects[0];
  assert.equal(project.id, projectId);
  assert.equal(project.path, realpathSync(f.folder));
  assert.equal(project.status, 'ready');
  assert.equal(project.statusReason, 'folder_ready');
  assert.equal(project.git.available, false);
  assert.equal(project.git.hasChanges, null);
  assert.equal(project.git.coherence, 'unknown');
  const detail = await f.request(`/api/v1/projects/${projectId}`);
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.equal(detail.body.project.id, projectId);
  assert.equal(detail.body.project.path, realpathSync(f.folder));
  assert.equal(detail.body.project.git.available, false);
}

for (const kind of ['empty', 'documents']) {
  test(`${kind} folder: select, register, read and refresh survive service reconstruction without changing files`, async (t) => {
    const f = await fixture(t);
    if (kind === 'documents') {
      mkdirSync(path.join(f.folder, '资料'));
      writeFileSync(path.join(f.folder, '说明.txt'), '普通文档项目，无需 Git。\n');
      writeFileSync(path.join(f.folder, '资料', 'sample.bin'), Buffer.from([0, 255, 10, 128]));
    }
    const before = directoryContents(f.folder);
    const grantId = await select(f);
    // Persisted selection must remain usable after the HTTP service and its DB
    // connection have both been reconstructed.
    await f.restart();
    const registered = await f.request('/api/v1/projects', { commandId: `register-${kind}`, grantId, name: `${kind} 项目` });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    const projectId = registered.body.projectId;
    assert.ok(projectId);
    await assertVisible(f, projectId);
    let refreshed = await f.request(`/api/v1/projects/${projectId}/refresh`, { commandId: `refresh-${kind}` });
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
    await assertVisible(f, projectId);
    await f.restart();
    refreshed = await f.request(`/api/v1/projects/${projectId}/refresh`, { commandId: `refresh-restarted-${kind}` });
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
    await assertVisible(f, projectId);
    assert.deepEqual(directoryContents(f.folder), before, 'registration and refresh must neither initialize .git nor alter project files');
  });
}

test('replacing a selected ordinary folder before confirmation rejects the stale selection', async (t) => {
  const f = await fixture(t);
  writeFileSync(path.join(f.folder, 'original.txt'), 'preserve original');
  const grantId = await select(f);
  const previous = path.join(f.container, 'original-folder');
  renameSync(f.folder, previous);
  mkdirSync(f.folder);
  writeFileSync(path.join(f.folder, 'replacement.txt'), 'preserve replacement');
  const replacementContents = directoryContents(f.folder);
  const registered = await f.request('/api/v1/projects', { commandId: 'register-replaced', grantId });
  assert.equal(registered.status, 409, JSON.stringify(registered.body));
  assert.equal(registered.body.code, 'FOLDER_SELECTION_CHANGED');
  const dashboard = await f.request('/api/v1/dashboard');
  assert.deepEqual(dashboard.body.projects, []);
  assert.deepEqual(directoryContents(f.folder), replacementContents);
  assert.equal(readFileSync(path.join(previous, 'original.txt'), 'utf8'), 'preserve original');
});

test('selecting a plain subfolder inside a Git repository registers the selected folder, not its parent', async (t) => {
  const f = await fixture(t);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: f.container, windowsHide: true, stdio: 'pipe', timeout: 10000 });
  writeFileSync(path.join(f.folder, 'notes.txt'), 'nested ordinary project');
  const before = directoryContents(f.folder);
  const gitBefore = directoryContents(path.join(f.container, '.git'));
  const grantId = await select(f);
  const registered = await f.request('/api/v1/projects', { commandId: 'register-nested', grantId });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  await assertVisible(f, registered.body.projectId);
  const refreshed = await f.request(`/api/v1/projects/${registered.body.projectId}/refresh`, { commandId: 'refresh-nested' });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
  assert.deepEqual(directoryContents(f.folder), before);
  assert.deepEqual(directoryContents(path.join(f.container, '.git')), gitBefore);
});

test('ordinary folder supports MCP init, progress and acknowledged handoff without inventing Git evidence', async (t) => {
  const f = await fixture(t);
  writeFileSync(path.join(f.folder, 'notes.txt'), 'existing document');
  const before = directoryContents(f.folder);
  const grantId = await select(f);
  const registered = await f.request('/api/v1/projects', { commandId: 'register-mcp-folder', grantId });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  const assignment = await f.request(`/api/v1/projects/${registered.body.projectId}/assignments`, {
    clientRequestId: 'folder-assignment', agent: 'Codex', mode: 'init', task: '整理普通文件夹文档',
  });
  assert.equal(assignment.status, 201, JSON.stringify(assignment.body));
  const initCode = assignment.body.message.match(/initCode: "([^"]+)"/)?.[1];
  assert.ok(initCode);
  const initialized = await f.request('/api/v1/mcp/work/init', {
    initCode, clientRequestId: 'folder-init', currentTask: '整理普通文件夹文档',
    currentState: '保留既有文档', mcpWorkingDirectory: f.folder,
  });
  assert.equal(initialized.status, 200, JSON.stringify(initialized.body));
  assert.equal(initialized.body.status, 'active');
  const sessionId = initialized.body.sessionId;
  assert.ok(sessionId);
  const progress = await f.request('/api/v1/mcp/work/progress', {
    sessionId, clientRequestId: 'folder-progress', expectedRevision: initialized.body.revision,
    status: 'working', summary: '文档已检查',
  });
  assert.equal(progress.status, 200, JSON.stringify(progress.body));
  assert.equal(progress.body.revision, initialized.body.revision + 1);
  assert.equal(progress.body.git.head, null);
  assert.equal(progress.body.git.branch, null);
  assert.equal(progress.body.git.coherence, 'unknown');
  const stale = await f.request('/api/v1/mcp/work/progress', {
    sessionId, clientRequestId: 'folder-stale-progress', expectedRevision: initialized.body.revision,
    status: 'working', summary: '过期请求不可覆盖最新进度',
  });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));

  const handoff = {
    sessionId, expectedRevision: progress.body.revision, outcome: 'completed',
    nextSessionFocus: '等待下一步安排', summary: '文档检查完成', currentState: '既有文件保留',
    completedItems: ['检查文档'], pendingItems: [], decisions: ['保留普通目录'],
    artifactRefs: ['notes.txt'], risks: ['无 Git 修改归属证据'], suggestedSkills: [],
  };
  const unacknowledged = await f.request('/api/v1/mcp/work/handoff', {
    ...handoff, clientRequestId: 'folder-handoff-unacknowledged', acknowledgements: [],
  });
  assert.equal(unacknowledged.body.code, 'UNATTRIBUTED_CHANGES_REQUIRE_CONFIRMATION');
  const finished = await f.request('/api/v1/mcp/work/handoff', {
    ...handoff, clientRequestId: 'folder-handoff', acknowledgements: ['unattributed_changes'],
  });
  assert.equal(finished.status, 200, JSON.stringify(finished.body));
  assert.equal(finished.body.revision, progress.body.revision + 1);
  const db = openCockpitDatabase(f.dbPath, { migrate: false });
  try {
    const snapshots = db.prepare('SELECT head, branch, coherence FROM snapshots WHERE run_id = ? ORDER BY phase').all(sessionId);
    assert.equal(snapshots.length, 2, 'baseline and final snapshots must both be retained');
    for (const snapshot of snapshots) {
      assert.equal(snapshot.head, null);
      assert.equal(snapshot.branch, null);
      assert.equal(snapshot.coherence, 'unknown');
    }
  } finally {
    db.close();
  }
  await assertVisible(f, registered.body.projectId);
  assert.deepEqual(directoryContents(f.folder), before);
});

test('an unborn Git repository registers as a folder and later Git initialization preserves an existing folder identity', async (t) => {
  const f = await fixture(t);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: f.folder, windowsHide: true, stdio: 'pipe', timeout: 10000 });
  const before = directoryContents(f.folder);
  const grantId = await select(f);
  const registered = await f.request('/api/v1/projects', { commandId: 'register-unborn', grantId });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  await assertVisible(f, registered.body.projectId);
  const refresh = await f.request(`/api/v1/projects/${registered.body.projectId}/refresh`, { commandId: 'refresh-unborn' });
  assert.equal(refresh.status, 200, JSON.stringify(refresh.body));
  assert.deepEqual(directoryContents(f.folder), before, 'probing an unborn repository must not create an index or commit');

  const plain = await fixture(t);
  const plainGrant = await select(plain);
  const plainProject = await plain.request('/api/v1/projects', { commandId: 'register-before-git', grantId: plainGrant });
  assert.equal(plainProject.status, 201, JSON.stringify(plainProject.body));
  const readIdentity = () => {
    const db = openCockpitDatabase(plain.dbPath, { migrate: false });
    try {
      return db.prepare('SELECT repository_identity FROM projects WHERE id = ?').get(plainProject.body.projectId).repository_identity;
    } finally { db.close(); }
  };
  const identity = readIdentity();
  assert.match(identity, /^folder:/);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: plain.folder, windowsHide: true, stdio: 'pipe', timeout: 10000 });
  const afterInit = directoryContents(plain.folder);
  await plain.restart();
  const afterInitRefresh = await plain.request(`/api/v1/projects/${plainProject.body.projectId}/refresh`, { commandId: 'refresh-after-user-git-init' });
  assert.equal(afterInitRefresh.status, 200, JSON.stringify(afterInitRefresh.body));
  assert.equal(readIdentity(), identity);
  await assertVisible(plain, plainProject.body.projectId);
  assert.deepEqual(directoryContents(plain.folder), afterInit);
});
