// 代码位置身份确认（confirm-location）：WORKTREE_IDENTITY_CHANGED 之后的
// 用户确认出路。指纹不含 device（macOS 卷号会漂移）；重绑只允许同路径、
// 只允许浏览器会话、保留历史并以命令日志落账。
// PR#17 返工补充：v30 旧指纹原地迁移（R2）、同仓库全量重绑（R3）、
// 活跃工作保护（R4）、folder 项目确认通路（R5）、重放与 grant 生命周期（R6）。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openCockpitDatabase, SUPPORTED_SCHEMA_VERSION } from '../src/core/database.mjs';
import { fileIdentity } from '../src/git/probe.mjs';
import { probeGitWorktree } from '../src/git/probe.mjs';
import {
  confirmProjectLocation,
  registerProject,
  refreshProject,
  worktreeIdFor,
} from '../src/core/projects.mjs';
import { statIdentityPair } from '../src/core/identity-migration.mjs';
import { observeDeliverySource } from '../src/core/delivery-sources.mjs';
import { FolderGrantStore } from '../src/core/folder-grants.mjs';
import { startWriteRun, finishRun } from '../src/core/runs.mjs';
import { createCockpitHttpServer } from '../src/service/http-server.mjs';

// Windows 语义：SQLite/HTTP 资源必须先关闭再删除其所在临时目录，
// 否则 rmSync 抛 EPERM 且 close 永不执行（进程挂死）。cleanup 数组按
// 创建顺序 push，清理时逆序执行（后开先关），任何一步失败都继续清完其余资源。
function runCleanupLifo(cleanup) {
  return async () => {
    let firstError = null;
    for (let index = cleanup.length - 1; index >= 0; index -= 1) {
      try {
        await cleanup[index]();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
  };
}

// POSIX 的系统临时目录本身可能是符号链接；夹具必须使用 realpath 后的位置。
function realTemp(cleanup, prefix) {
  const root = realpathSync(mkdtempSync(path.join(realpathSync(os.tmpdir()), prefix)));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function gitSync(cwd, args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function initGit(root) {
  mkdirSync(root, { recursive: true });
  gitSync(root, ['init', '-q']);
  gitSync(root, ['-c', 'user.email=fixture@example.com', '-c', 'user.name=fixture', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return root;
}

function observation(overrides = {}) {
  return {
    canonicalPath: '/fixture/project',
    repositoryIdentity: 'repository-one',
    worktreeIdentity: 'worktree-one',
    observedAt: '2026-09-01T00:00:00.000Z',
    coherence: 'coherent',
    after: { hasChanges: false },
    ...overrides,
  };
}

test('file identity fingerprint deliberately excludes the device number', async (t) => {
  const cleanup = [];
  t.after(runCleanupLifo(cleanup));
  const root = initGit(realTemp(cleanup, 'ugk-identity-'));
  const identity = await fileIdentity(path.join(root, '.git'));
  const expected = createHash('sha256').update(JSON.stringify({
    inode: identity.evidence.inode,
    birthtimeNs: identity.evidence.birthtimeNs,
  })).digest('hex');
  assert.equal(identity.fingerprint, expected);
  // device stays in the evidence for diagnostics only.
  assert.ok(identity.evidence.device);
});

test('confirm-location rebinds the same path to a new identity and preserves history', (t) => {
  const cleanup = [];
  t.after(runCleanupLifo(cleanup));
  const root = realpathSync(mkdtempSync(path.join(realpathSync(os.tmpdir()), 'ugk-confirm-core-')));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const db = openCockpitDatabase(path.join(root, 'cockpit.db'));
  cleanup.push(() => db.close());
  const registered = registerProject(db, {
    commandId: 'register-1', name: 'Same', observation: observation(),
  });
  const worktreeId = worktreeIdFor('worktree-one');
  const started = startWriteRun(db, {
    commandId: 'run-1', runId: 'run-1', agentClaim: 'codex',
    worktreeId, canonicalPath: '/fixture/project', goal: 'history to preserve',
    repositoryIdentity: 'repository-one', worktreeIdentity: 'worktree-one',
    baseline: { head: 'a'.repeat(40), branch: 'main', indexFingerprint: 'i', worktreeFingerprint: 'w', coherence: 'coherent' },
  });
  assert.equal(started.ok, true);
  // The run must be closed before the rebind (R4): history is preserved, the
  // identity chain is not silently rewritten underneath an open run.
  const finished = finishRun(db, {
    commandId: 'finish-1', runId: 'run-1',
    expectedRevision: started.revision, leaseGeneration: started.leaseGeneration,
    outcome: 'completed', summary: 'done',
    finalSnapshot: {
      head: 'a'.repeat(40), branch: 'main', indexFingerprint: 'i', worktreeFingerprint: 'w',
      repositoryIdentity: 'repository-one', worktreeIdentity: 'worktree-one', coherence: 'coherent',
    },
  });
  assert.equal(finished.ok, true, JSON.stringify(finished));

  const confirmed = confirmProjectLocation(db, {
    commandId: 'confirm-1',
    projectId: registered.projectId,
    observation: observation({
      repositoryIdentity: 'repository-drifted',
      worktreeIdentity: 'worktree-drifted',
      after: { hasChanges: true },
    }),
  });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.locationConfirmed, true);
  assert.equal(confirmed.status, 'attention');

  const worktree = db.prepare('SELECT * FROM worktrees WHERE id = ?').get(worktreeId);
  assert.equal(worktree.repository_identity, 'repository-drifted');
  assert.equal(worktree.identity_fingerprint, 'worktree-drifted');
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(registered.projectId);
  assert.equal(project.repository_identity, 'repository-drifted');
  assert.equal(project.status_reason, 'preexisting_changes');
  assert.equal(db.prepare("SELECT count(*) AS n FROM runs WHERE id = 'run-1'").get().n, 1,
    'run history must survive the rebind');
  // Finished runs' snapshots follow the rebind so the historical identity
  // domain collapses onto the confirmed one instead of orphaning.
  const snapshot = db.prepare("SELECT * FROM snapshots WHERE run_id = 'run-1' AND phase = 'baseline'").get();
  assert.equal(snapshot.repository_identity, 'repository-drifted');
  assert.equal(snapshot.worktree_identity, 'worktree-drifted');

  // Same command replays to the same receipt; a new command is also idempotent
  // when the identity already matches.
  assert.deepEqual(confirmProjectLocation(db, {
    commandId: 'confirm-1', projectId: registered.projectId,
    observation: observation({ repositoryIdentity: 'repository-drifted', worktreeIdentity: 'worktree-drifted' }),
  }), confirmed);
});

test('confirm-location rejects a different path and unknown projects', (t) => {
  const cleanup = [];
  t.after(runCleanupLifo(cleanup));
  const root = realpathSync(mkdtempSync(path.join(realpathSync(os.tmpdir()), 'ugk-confirm-reject-')));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const db = openCockpitDatabase(path.join(root, 'cockpit.db'));
  cleanup.push(() => db.close());
  const registered = registerProject(db, {
    commandId: 'register-2', name: 'Stable', observation: observation(),
  });

  const moved = confirmProjectLocation(db, {
    commandId: 'confirm-2', projectId: registered.projectId,
    observation: observation({ canonicalPath: '/fixture/elsewhere' }),
  });
  assert.equal(moved.ok, false);
  assert.equal(moved.code, 'PROJECT_LOCATION_CHANGED');
  const worktree = db.prepare('SELECT * FROM worktrees WHERE id = ?').get(worktreeIdFor('worktree-one'));
  assert.equal(worktree.repository_identity, 'repository-one', 'a refused rebind must not touch records');

  assert.equal(confirmProjectLocation(db, {
    commandId: 'confirm-3', projectId: 'project_missing', observation: observation(),
  }).code, 'PROJECT_NOT_FOUND');
});

test('confirm-location HTTP route: browser-only, full grant flow, replay', async (t) => {
  const cleanup = [];
  t.after(runCleanupLifo(cleanup));
  const container = realTemp(cleanup, 'ugk-confirm-http-');
  const projectDir = initGit(path.join(container, 'project'));
  const otherDir = initGit(path.join(container, 'other'));

  let pickerResponse = projectDir;
  const apiToken = 'confirm-location-fixture-token-0000000000000000';
  const dataRoot = path.join(container, 'data');
  const service = await createCockpitHttpServer({
    dbPath: path.join(dataRoot, 'cockpit.db'),
    token: apiToken,
    folderPicker: async () => pickerResponse,
    serveWebAsset: async ({ pathname, response, sessionToken }) => {
      if (pathname !== '/') return false;
      response.setHeader('set-cookie', `ugk_cockpit_session=${sessionToken}; HttpOnly; SameSite=Strict`);
      response.end('fixture');
      return true;
    },
  });
  cleanup.push(async () => { await service.close(); rmSync(dataRoot, { recursive: true, force: true }); });
  const base = `http://${service.host}:${service.port}`;
  const shell = await fetch(`${base}/`);
  await shell.text();
  const headers = {
    cookie: shell.headers.get('set-cookie'), origin: base,
    'sec-fetch-site': 'same-origin', 'content-type': 'application/json',
    'x-ugk-client-id': 'confirm-location-browser',
  };
  const post = (route, body, extraHeaders = {}) => fetch(`${base}${route}`, {
    method: 'POST', headers: { ...headers, ...extraHeaders }, body: JSON.stringify(body),
  });

  // A bare MCP bearer token must not confirm a location; only the browser can.
  const selection = await (await post('/api/v1/folders/select', {})).json();
  const denied = await fetch(`${base}/api/v1/projects/any/confirm-location`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: 'confirm-bearer', grantId: selection.grantId }),
  });
  assert.equal(denied.status, 401);

  // Register through the same picker, then let the folder identity drift.
  pickerResponse = projectDir;
  const registered = await (await post('/api/v1/projects', {
    commandId: 'register-http', grantId: selection.grantId, name: 'Drift',
  })).json();
  assert.equal(registered.ok, true);

  pickerResponse = projectDir;
  const reselection = await (await post('/api/v1/folders/select', {})).json();
  const confirmed = await post(`/api/v1/projects/${encodeURIComponent(registered.projectId)}/confirm-location`, {
    commandId: 'confirm-http', grantId: reselection.grantId,
  });
  assert.equal(confirmed.status, 200);
  const body = await confirmed.json();
  assert.equal(body.ok, true);
  assert.equal(body.locationConfirmed, true);

  // Replaying the same command returns the same receipt without a fresh grant.
  const replayed = await post(`/api/v1/projects/${encodeURIComponent(registered.projectId)}/confirm-location`, {
    commandId: 'confirm-http', grantId: reselection.grantId,
  });
  assert.equal(replayed.status, 200);
  assert.deepEqual(await replayed.json(), body);

  // Selecting a different folder must be refused and change nothing.
  pickerResponse = otherDir;
  const otherSelection = await (await post('/api/v1/folders/select', {})).json();
  const refused = await post(`/api/v1/projects/${encodeURIComponent(registered.projectId)}/confirm-location`, {
    commandId: 'confirm-other', grantId: otherSelection.grantId,
  });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).code, 'PROJECT_LOCATION_CHANGED');
});

test('probe identity survives a device number drift between observations', async (t) => {
  const cleanup = [];
  t.after(runCleanupLifo(cleanup));
  const root = initGit(realTemp(cleanup, 'ugk-probe-drift-'));
  const first = await probeGitWorktree(root);
  // Simulate the macOS device drift by recomputing the fingerprint the way the
  // stored evidence would: only inode and birthtime participate.
  const storedEvidence = { device: '16777231', inode: first.repositoryIdentityEvidence.inode, birthtimeNs: first.repositoryIdentityEvidence.birthtimeNs };
  const legacyFingerprint = createHash('sha256').update(JSON.stringify(storedEvidence)).digest('hex');
  assert.notEqual(legacyFingerprint, first.repositoryIdentity,
    'a device-only drift must change nothing: the fingerprint ignores device');
  const second = await probeGitWorktree(root);
  assert.equal(second.worktreeIdentity, first.worktreeIdentity);
});

// ---------------------------------------------------------------------------
// PR#17 返工测试
// ---------------------------------------------------------------------------

// 旧格式指纹（含 device）；device 参数可伪造出"真漂移"后不可重构的场景。
function legacyHashOf(targetPath, device) {
  const details = statSync(targetPath, { bigint: true });
  return createHash('sha256').update(JSON.stringify({
    device: device ?? details.dev.toString(),
    inode: details.ino.toString(),
    birthtimeNs: details.birthtimeNs.toString(),
  })).digest('hex');
}

async function httpHarness(t, cleanup, initialPick = null) {
  const container = realTemp(cleanup, 'ugk-confirm-http-');
  let pickerResponse = initialPick;
  const apiToken = 'confirm-location-fixture-token-0000000000000000';
  const dataRoot = path.join(container, 'data');
  const service = await createCockpitHttpServer({
    dbPath: path.join(dataRoot, 'cockpit.db'),
    token: apiToken,
    folderPicker: async () => pickerResponse,
    serveWebAsset: async ({ pathname, response, sessionToken }) => {
      if (pathname !== '/') return false;
      response.setHeader('set-cookie', `ugk_cockpit_session=${sessionToken}; HttpOnly; SameSite=Strict`);
      response.end('fixture');
      return true;
    },
  });
  cleanup.push(async () => { await service.close(); rmSync(dataRoot, { recursive: true, force: true }); });
  const base = `http://${service.host}:${service.port}`;
  const shell = await fetch(`${base}/`);
  await shell.text();
  const headers = {
    cookie: shell.headers.get('set-cookie'), origin: base,
    'sec-fetch-site': 'same-origin', 'content-type': 'application/json',
    'x-ugk-client-id': 'confirm-location-browser',
  };
  return {
    base,
    container,
    dbFile: path.join(dataRoot, 'cockpit.db'),
    setPicker: (value) => { pickerResponse = value; },
    post: (route, body) => fetch(`${base}${route}`, {
      method: 'POST', headers, body: JSON.stringify(body),
    }),
    get: (route) => fetch(`${base}${route}`, { headers }),
    // 直连 SQLite（WAL 允许并发），用于模拟 TTL 过期与旧格式库存行。
    withDb: (fn) => {
      const raw = new DatabaseSync(path.join(dataRoot, 'cockpit.db'));
      try {
        raw.exec('PRAGMA busy_timeout = 2000;');
        return fn(raw);
      } finally {
        raw.close();
      }
    },
  };
}

test('schema v30 rewrites recoverable legacy fingerprints in place (R2)', async (t) => {
  const cleanup = [];
  t.after(runCleanupLifo(cleanup));
  const container = realTemp(cleanup, 'ugk-v30-rewrite-');
  const repoA = initGit(path.join(container, 'repo-a'));
  const repoB = initGit(path.join(container, 'repo-b'));
  const plainFolder = path.join(container, 'plain-folder');
  mkdirSync(plainFolder, { recursive: true });
  const dbPath = path.join(container, 'data', 'cockpit.db');

  let db = openCockpitDatabase(dbPath);
  // 单一清理钩子：始终关闭最后打开的那个连接，容忍中途已显式关闭。
  cleanup.push(() => { try { db.close(); } catch {} });
  const probeA = await probeGitWorktree(repoA);
  const probeB = await probeGitWorktree(repoB);
  const registeredA = registerProject(db, { commandId: 'reg-a', name: 'A', observation: probeA });
  const registeredB = registerProject(db, { commandId: 'reg-b', name: 'B', observation: probeB });
  const started = startWriteRun(db, {
    commandId: 'run-a1', runId: 'run-a1', agentClaim: 'codex',
    worktreeId: registeredA.worktreeId ?? worktreeIdFor(probeA.worktreeIdentity),
    canonicalPath: probeA.canonicalPath, goal: 'open across the upgrade',
    repositoryIdentity: probeA.repositoryIdentity, worktreeIdentity: probeA.worktreeIdentity,
    baseline: {
      head: probeA.after.head, branch: probeA.after.branch,
      indexFingerprint: probeA.after.indexFingerprint, worktreeFingerprint: probeA.after.worktreeFingerprint,
      coherence: 'coherent',
    },
  });
  assert.equal(started.ok, true, JSON.stringify(started));

  // 项目 A：无漂移机器的旧格式库存（device 用当前值可精确重算）。
  const legacyADir = legacyHashOf(repoA);
  const legacyACommon = legacyHashOf(path.join(repoA, '.git'));
  // 项目 B：真漂移机器的旧格式库存（旧 device 已不可知，重算不可能命中）。
  const driftedB = legacyHashOf(repoB, '16777231');
  const driftedBCommon = legacyHashOf(path.join(repoB, '.git'), '16777231');
  db.prepare('UPDATE worktrees SET identity_fingerprint = ?, repository_identity = ? WHERE canonical_path = ?')
    .run(legacyADir, legacyACommon, probeA.canonicalPath);
  db.prepare('UPDATE projects SET repository_identity = ? WHERE id = ?').run(legacyACommon, registeredA.projectId);
  db.prepare('UPDATE snapshots SET worktree_identity = ?, repository_identity = ? WHERE run_id = ?')
    .run(legacyADir, legacyACommon, 'run-a1');
  db.prepare('INSERT INTO repository_locks (repository_identity, lock_id, holder, operation, expires_at, acquired_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(legacyACommon, 'lock-v30', 'holder', 'workspace.remove', Date.now() + 600_000, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
  db.prepare('UPDATE worktrees SET identity_fingerprint = ?, repository_identity = ? WHERE canonical_path = ?')
    .run(driftedB, driftedBCommon, probeB.canonicalPath);
  db.prepare('UPDATE projects SET repository_identity = ? WHERE id = ?').run(driftedBCommon, registeredB.projectId);
  // 模拟"由上一版本（schema 29）建档"的库存数据库：版本号与迁移台账一起回拨。
  db.prepare('DELETE FROM schema_migrations WHERE version >= 30').run();
  db.exec('PRAGMA user_version = 29');
  db.close();

  // 旧版本库位重开（原地升级触发 v30）。
  db = openCockpitDatabase(dbPath);
  assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), SUPPORTED_SCHEMA_VERSION);
  assert.equal(SUPPORTED_SCHEMA_VERSION, 30, 'the rewrite must ride schema v30');
  const rowA = db.prepare('SELECT * FROM worktrees WHERE canonical_path = ?').get(probeA.canonicalPath);
  assert.equal(rowA.identity_fingerprint, probeA.worktreeIdentity, 'recoverable legacy hash must be rewritten');
  assert.equal(rowA.repository_identity, probeA.repositoryIdentity);
  assert.equal(db.prepare('SELECT repository_identity AS v FROM projects WHERE id = ?').get(registeredA.projectId).v, probeA.repositoryIdentity);
  const baseline = db.prepare("SELECT * FROM snapshots WHERE run_id = 'run-a1' AND phase = 'baseline'").get();
  assert.equal(baseline.repository_identity, probeA.repositoryIdentity, 'an open run must keep reconciling after the upgrade');
  assert.equal(baseline.worktree_identity, probeA.worktreeIdentity);
  assert.equal(db.prepare('SELECT repository_identity AS v FROM repository_locks WHERE lock_id = ?').get('lock-v30').v, probeA.repositoryIdentity,
    'identity-keyed locks migrate instead of orphaning');
  const rowB = db.prepare('SELECT * FROM worktrees WHERE canonical_path = ?').get(probeB.canonicalPath);
  assert.equal(rowB.identity_fingerprint, driftedB, 'a genuinely drifted hash cannot be reconstructed and stays legacy');
  assert.equal(rowB.repository_identity, driftedBCommon);

  // 验收：升级后零手工操作即可刷新与结束升级前已开始的 run。
  const refreshed = refreshProject(db, { commandId: 'refresh-a2', projectId: registeredA.projectId, observation: probeA });
  assert.equal(refreshed.ok, true, JSON.stringify(refreshed));
  const blocked = refreshProject(db, { commandId: 'refresh-b1', projectId: registeredB.projectId, observation: probeB });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'WORKTREE_IDENTITY_CHANGED', 'drifted rows keep the confirm-location exit');
  const finished = finishRun(db, {
    commandId: 'finish-a1', runId: 'run-a1',
    expectedRevision: started.revision, leaseGeneration: started.leaseGeneration,
    outcome: 'completed', summary: 'survived the upgrade',
    finalSnapshot: {
      head: probeA.after.head, branch: probeA.after.branch,
      indexFingerprint: probeA.after.indexFingerprint, worktreeFingerprint: probeA.after.worktreeFingerprint,
      repositoryIdentity: probeA.repositoryIdentity, worktreeIdentity: probeA.worktreeIdentity,
      coherence: probeA.coherence,
    },
  });
  assert.equal(finished.ok, true, JSON.stringify(finished));

  // 可重复执行：再次重开不得再改动任何已迁移/未迁移的值。
  db.close();
  db = openCockpitDatabase(dbPath);
  const stableRow = db.prepare('SELECT identity_fingerprint, repository_identity FROM worktrees WHERE canonical_path = ?').get(probeA.canonicalPath);
  assert.equal(stableRow.identity_fingerprint, probeA.worktreeIdentity);
  assert.equal(stableRow.repository_identity, probeA.repositoryIdentity);
  assert.equal(db.prepare('SELECT identity_fingerprint AS v FROM worktrees WHERE canonical_path = ?').get(probeB.canonicalPath).v, driftedB);
});

test('schema v30 never probes a hostile repository and leaves its rows untouched (R2 policy gate)', async (t) => {
  const cleanup = [];
  t.after(runCleanupLifo(cleanup));
  const container = realTemp(cleanup, 'ugk-v30-hostile-');
  const repo = initGit(path.join(container, 'hostile'));
  gitSync(repo, ['config', '--local', 'filter.evil.clean', 'touch /tmp/ugk-pwned']);
  const dbPath = path.join(container, 'data', 'cockpit.db');
  let db = openCockpitDatabase(dbPath);
  cleanup.push(() => { try { db.close(); } catch {} });
  const legacyDir = legacyHashOf(repo);
  const legacyCommon = legacyHashOf(path.join(repo, '.git'));
  const worktreeId = worktreeIdFor(legacyDir);
  const timestamp = new Date('2026-09-01T00:00:00.000Z').toISOString();
  db.prepare('INSERT INTO worktrees (id, canonical_path, repository_identity, identity_fingerprint, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(worktreeId, repo, legacyCommon, legacyDir, timestamp);
  db.prepare('DELETE FROM schema_migrations WHERE version >= 30').run();
  db.exec('PRAGMA user_version = 29');
  db.close();
  db = openCockpitDatabase(dbPath);
  const row = db.prepare('SELECT * FROM worktrees WHERE id = ?').get(worktreeId);
  assert.equal(row.identity_fingerprint, legacyDir, 'a hostile repository must not be git-probed by the migration');
  assert.equal(row.repository_identity, legacyCommon);
});

test('schema v30 migration runs in a rebuilt process over the real database file (R2)', async (t) => {
  const cleanup = [];
  t.after(runCleanupLifo(cleanup));
  const container = realTemp(cleanup, 'ugk-v30-proc-');
  const repo = initGit(path.join(container, 'repo'));
  const dbPath = path.join(container, 'data', 'cockpit.db');
  const db = openCockpitDatabase(dbPath);
  const probe = await probeGitWorktree(repo);
  const registered = registerProject(db, { commandId: 'reg-proc', name: 'Proc', observation: probe });
  db.prepare('UPDATE worktrees SET identity_fingerprint = ?, repository_identity = ? WHERE canonical_path = ?')
    .run(legacyHashOf(repo), legacyHashOf(path.join(repo, '.git')), probe.canonicalPath);
  db.prepare('UPDATE projects SET repository_identity = ? WHERE id = ?')
    .run(legacyHashOf(path.join(repo, '.git')), registered.projectId);
  db.prepare('DELETE FROM schema_migrations WHERE version >= 30').run();
  db.exec('PRAGMA user_version = 29');
  db.close();

  // 真实进程重建：新进程打开同一个库文件触发迁移。
  execFileSync(process.execPath, ['--input-type=module', '-e', [
    "const { pathToFileURL } = await import('node:url');",
    "const { openCockpitDatabase } = await import(pathToFileURL(process.env.COCKPIT_DB_MODULE).href);",
    'const db = openCockpitDatabase(process.env.COCKPIT_DB_FILE);',
    'db.close();',
  ].join('\n')], {
    cwd: path.join(import.meta.dirname, '..'),
    env: {
      ...process.env,
      COCKPIT_DB_MODULE: path.join(import.meta.dirname, '..', 'src', 'core', 'database.mjs'),
      COCKPIT_DB_FILE: dbPath,
    },
    timeout: 60_000,
    windowsHide: true,
  });
  const reopened = openCockpitDatabase(dbPath);
  cleanup.push(() => reopened.close());
  assert.equal(
    reopened.prepare('SELECT identity_fingerprint AS v FROM worktrees WHERE canonical_path = ?').get(probe.canonicalPath).v,
    probe.worktreeIdentity,
  );
  assert.equal(
    reopened.prepare('SELECT repository_identity AS v FROM projects WHERE id = ?').get(registered.projectId).v,
    probe.repositoryIdentity,
  );
});

test('confirm-location rebinds every same-repository worktree and revives the delivery chain (R3)', async (t) => {
  const cleanup = [];
  t.after(runCleanupLifo(cleanup));
  const container = realTemp(cleanup, 'ugk-r3-rebind-');
  const mainRepo = initGit(path.join(container, 'main'));
  const siblingDir = path.join(container, 'sibling-space');
  gitSync(mainRepo, ['worktree', 'add', '-q', siblingDir, '-b', 'sibling-space']);
  const realSibling = realpathSync(siblingDir);

  const db = openCockpitDatabase(path.join(container, 'cockpit.db'));
  cleanup.push(() => db.close());
  const probeMain = await probeGitWorktree(mainRepo);
  const legacyDir = legacyHashOf(mainRepo);
  const legacyCommon = legacyHashOf(realpathSync(path.join(mainRepo, '.git')));
  const registered = registerProject(db, { commandId: 'reg-r3', name: 'R3', observation: {
    ...probeMain, repositoryIdentity: legacyCommon, worktreeIdentity: legacyDir,
  } });
  // 同一 repository 的 space worktree（linked worktree 共享 common dir）与
  // delivery source 行，全部持有旧格式身份。
  const probeSibling = await probeGitWorktree(realSibling);
  const siblingWorktreeId = worktreeIdFor(legacyHashOf(realSibling));
  const timestamp = new Date('2026-09-01T00:00:00.000Z').toISOString();
  db.prepare('INSERT INTO worktrees (id, canonical_path, repository_identity, identity_fingerprint, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(siblingWorktreeId, realSibling, legacyCommon, legacyHashOf(realSibling), timestamp);
  db.prepare('INSERT INTO delivery_sources (id, project_id, worktree_id, authorized_root, source_remote_identity, target_remote_identity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('delivery_source_r3', registered.projectId, siblingWorktreeId, realSibling, 'remote-src', 'remote-tgt', timestamp);

  // 返工前：送审链在旧格式行上永久挂死。
  await assert.rejects(() => observeDeliverySource(db, 'delivery_source_r3'), (error) => {
    assert.equal(error.code, 'WORKTREE_IDENTITY_CHANGED');
    return true;
  });

  const confirmed = confirmProjectLocation(db, {
    commandId: 'confirm-r3', projectId: registered.projectId, observation: probeMain,
  });
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
  assert.deepEqual([...confirmed.reboundWorktreeIds].sort(),
    [worktreeIdFor(legacyDir), siblingWorktreeId].sort());

  const reboundSibling = db.prepare('SELECT * FROM worktrees WHERE id = ?').get(siblingWorktreeId);
  assert.equal(reboundSibling.repository_identity, probeMain.repositoryIdentity,
    'spaces share the rebound repository identity instead of REPOSITORY_IDENTITY_MISMATCH');
  assert.equal(reboundSibling.identity_fingerprint, probeSibling.worktreeIdentity);
  assert.equal(db.prepare('SELECT repository_identity AS v FROM projects WHERE id = ?').get(registered.projectId).v,
    probeMain.repositoryIdentity);
  assert.equal(db.prepare('SELECT count(*) AS n FROM worktrees WHERE repository_identity = ?').get(legacyCommon).n, 0,
    'no row may keep the retired repository identity');

  // 验收：delivery 链路恢复。
  const revived = await observeDeliverySource(db, 'delivery_source_r3');
  assert.equal(revived.source.worktree_id, siblingWorktreeId);
});

test('confirm-location refuses while leases or assignments are open, succeeds once released (R4)', (t) => {
  const cleanup = [];
  t.after(runCleanupLifo(cleanup));
  const root = realpathSync(mkdtempSync(path.join(realpathSync(os.tmpdir()), 'ugk-r4-guard-')));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const db = openCockpitDatabase(path.join(root, 'cockpit.db'));
  cleanup.push(() => db.close());
  const registered = registerProject(db, { commandId: 'reg-r4', name: 'R4', observation: observation() });
  const worktreeId = worktreeIdFor('worktree-one');
  startWriteRun(db, {
    commandId: 'run-r4', runId: 'run-r4', agentClaim: 'codex',
    worktreeId, canonicalPath: '/fixture/project', goal: 'open work',
    repositoryIdentity: 'repository-one', worktreeIdentity: 'worktree-one',
    baseline: { head: 'a'.repeat(40), branch: 'main', indexFingerprint: 'i', worktreeFingerprint: 'w', coherence: 'coherent' },
  });
  const drifted = observation({ repositoryIdentity: 'repository-drifted', worktreeIdentity: 'worktree-drifted' });

  const busyRun = confirmProjectLocation(db, { commandId: 'confirm-r4-run', projectId: registered.projectId, observation: drifted });
  assert.equal(busyRun.ok, false);
  assert.equal(busyRun.code, 'PROJECT_LOCATION_CONFIRMATION_BUSY');
  assert.equal(busyRun.blockingRunId, 'run-r4');
  const untouched = db.prepare('SELECT * FROM worktrees WHERE id = ?').get(worktreeId);
  assert.equal(untouched.repository_identity, 'repository-one', 'a refused confirmation changes nothing');

  db.prepare('DELETE FROM write_leases WHERE run_id = ?').run('run-r4');
  db.prepare("UPDATE runs SET lifecycle = 'abandoned', finished_at = ? WHERE id = 'run-r4'")
    .run(new Date().toISOString());
  const timestamp = new Date().toISOString();
  db.prepare(`
    INSERT INTO assignments (id, project_id, worktree_id, agent_id, task_id, scope_json, status, revision, created_at, updated_at)
    VALUES ('assignment-r4', ?, ?, 'Codex', 'waiting pickup', '{}', 'pending', 1, ?, ?)
  `).run(registered.projectId, worktreeId, timestamp, timestamp);
  const busyAssignment = confirmProjectLocation(db, { commandId: 'confirm-r4-assign', projectId: registered.projectId, observation: drifted });
  assert.equal(busyAssignment.ok, false);
  assert.equal(busyAssignment.code, 'PROJECT_LOCATION_CONFIRMATION_BUSY');
  assert.equal(busyAssignment.blockingAssignmentId, 'assignment-r4');

  db.prepare('DELETE FROM assignments WHERE id = ?').run('assignment-r4');
  const idle = confirmProjectLocation(db, { commandId: 'confirm-r4-idle', projectId: registered.projectId, observation: drifted });
  assert.equal(idle.ok, true, JSON.stringify(idle));
  assert.equal(idle.locationConfirmed, true);
});

test('confirm-location drives ordinary folder projects end to end (R5)', async (t) => {
  const cleanup = [];
  t.after(runCleanupLifo(cleanup));
  const plainFolder = path.join(realTemp(cleanup, 'ugk-r5-folder-'), 'notes');
  mkdirSync(plainFolder, { recursive: true });
  const real = realpathSync(plainFolder);
  const http = await httpHarness(t, cleanup, real);

  const selection = await (await http.post('/api/v1/folders/select', {})).json();
  assert.ok(selection.grantId);
  const registered = await (await http.post('/api/v1/projects', {
    commandId: 'register-r5', grantId: selection.grantId, name: 'Folder',
  })).json();
  assert.equal(registered.ok, true, JSON.stringify(registered));

  // 模拟 macOS 卷号漂移后的 folder: 旧格式库存（v30 不可重算的 fake device）。
  http.withDb((raw) => {
    raw.prepare('UPDATE worktrees SET identity_fingerprint = ?, repository_identity = ? WHERE canonical_path = ?')
      .run(legacyHashOf(real, '16777231'), `folder:${legacyHashOf(real, '16777231')}`, real);
    raw.prepare('UPDATE projects SET repository_identity = ? WHERE id = ?')
      .run(`folder:${legacyHashOf(real, '16777231')}`, registered.projectId);
  });
  const failingRefresh = await http.post(`/api/v1/projects/${encodeURIComponent(registered.projectId)}/refresh`, {
    commandId: 'refresh-r5-drift',
  });
  assert.equal(failingRefresh.status, 409);
  assert.equal((await failingRefresh.json()).code, 'WORKTREE_IDENTITY_CHANGED');

  http.setPicker(real);
  const reselection = await (await http.post('/api/v1/folders/select', {})).json();
  const confirmed = await http.post(`/api/v1/projects/${encodeURIComponent(registered.projectId)}/confirm-location`, {
    commandId: 'confirm-r5', grantId: reselection.grantId,
  });
  assert.equal(confirmed.status, 200);
  const body = await confirmed.json();
  assert.equal(body.ok, true);
  assert.equal(body.locationConfirmed, true);
  // folder 豁免：状态不再被错标为 attention/status_check_incomplete。
  assert.equal(body.status, 'ready');
  assert.equal(body.statusReason, 'folder_ready');
  assert.equal(body.git.available, false);

  const dashboard = await (await http.get('/api/v1/dashboard')).json();
  const row = dashboard.projects.find((project) => project.id === registered.projectId);
  assert.equal(row.status, 'ready');
  assert.equal(row.statusReason, 'folder_ready');
});

test('terminal commands replay after the grant TTL expired; grants can be released (R6)', async (t) => {
  const cleanup = [];
  t.after(runCleanupLifo(cleanup));
  const container = realTemp(cleanup, 'ugk-r6-');
  const projectDir = initGit(path.join(container, 'project'));
  const http = await httpHarness(t, cleanup, projectDir);

  const selection = await (await http.post('/api/v1/folders/select', {})).json();
  const registered = await (await http.post('/api/v1/projects', {
    commandId: 'register-r6', grantId: selection.grantId, name: 'Replay',
  })).json();
  assert.equal(registered.ok, true);
  // 注册成功后令 grant 过期：同 commandId 重放仍返回原回执。
  http.withDb((raw) => raw.prepare('UPDATE folder_grants SET expires_at = 1 WHERE id = ?').run(selection.grantId));
  const replayRegister = await http.post('/api/v1/projects', {
    commandId: 'register-r6', grantId: selection.grantId, name: 'Replay',
  });
  assert.equal(replayRegister.status, 200);
  assert.deepEqual(await replayRegister.json(), registered);

  http.setPicker(projectDir);
  const reselection = await (await http.post('/api/v1/folders/select', {})).json();
  const route = `/api/v1/projects/${encodeURIComponent(registered.projectId)}/confirm-location`;
  const confirmed = await (await http.post(route, { commandId: 'confirm-r6', grantId: reselection.grantId })).json();
  assert.equal(confirmed.ok, true);
  http.withDb((raw) => raw.prepare('UPDATE folder_grants SET expires_at = 1 WHERE id = ?').run(reselection.grantId));
  const replayConfirm = await http.post(route, { commandId: 'confirm-r6', grantId: reselection.grantId });
  assert.equal(replayConfirm.status, 200);
  assert.deepEqual(await replayConfirm.json(), confirmed);
});

test('FolderGrantStore mirrors the empty store: expiry gates first claim, same command recovers, consumed refuses (R6)', (t) => {
  const cleanup = [];
  t.after(runCleanupLifo(cleanup));
  const root = realTemp(cleanup, 'ugk-r6-store-');
  const db = openCockpitDatabase(path.join(root, 'cockpit.db'));
  cleanup.push(() => db.close());
  const store = new FolderGrantStore({ db, ttlMs: 5 * 60_000 });
  const binding = { folderPath: '/x', canonicalPath: '/x', repositoryIdentity: 'r', worktreeIdentity: 'w' };

  const expiredStore = new FolderGrantStore({ db, ttlMs: -1 });
  const expired = expiredStore.issue(binding, 'principal-a');
  assert.throws(() => expiredStore.claim(expired.grantId, 'cmd-1', 'principal-a'), { code: 'FOLDER_GRANT_EXPIRED' });

  const live = store.issue(binding, 'principal-a');
  store.claim(live.grantId, 'cmd-1', 'principal-a');
  db.prepare('UPDATE folder_grants SET expires_at = 1 WHERE id = ?').run(live.grantId);
  // 崩溃恢复：TTL 过后同 commandId 依然可以取回 claimed 行。
  assert.equal(store.claim(live.grantId, 'cmd-1', 'principal-a').state, 'claimed');
  assert.throws(() => store.claim(live.grantId, 'cmd-2', 'principal-a'), { code: 'FOLDER_GRANT_IN_USE' });
  assert.equal(store.unclaim(live.grantId, 'cmd-1'), true);
  assert.throws(() => store.claim(live.grantId, 'cmd-1', 'principal-a'), { code: 'FOLDER_GRANT_EXPIRED' });

  const second = store.issue(binding, 'principal-a');
  store.claim(second.grantId, 'cmd-3', 'principal-a');
  store.complete(second.grantId, 'cmd-3');
  assert.throws(() => store.claim(second.grantId, 'cmd-3', 'principal-a'), { code: 'FOLDER_GRANT_CONSUMED' });
  assert.throws(() => store.claim(second.grantId, 'cmd-3', 'principal-b'), { code: 'FOLDER_GRANT_EXPIRED' });
});

test('confirm-location allows rebind under an open (possibly expired) transfer freeze (R6)', (t) => {
  const cleanup = [];
  t.after(runCleanupLifo(cleanup));
  const root = realpathSync(mkdtempSync(path.join(realpathSync(os.tmpdir()), 'ugk-r6-freeze-')));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const db = openCockpitDatabase(path.join(root, 'cockpit.db'));
  cleanup.push(() => db.close());
  const registered = registerProject(db, { commandId: 'reg-r6', name: 'R6', observation: observation() });
  const worktreeId = worktreeIdFor('worktree-one');
  // 与现场一致的完整阻塞组合：active run + 写租约 + active 会话任务。
  startWriteRun(db, {
    commandId: 'run-r6', runId: 'session-r6', agentClaim: 'zcode',
    worktreeId, canonicalPath: '/fixture/project', goal: 'frozen takeover',
    repositoryIdentity: 'repository-one', worktreeIdentity: 'worktree-one',
    baseline: { head: 'a'.repeat(40), branch: 'main', indexFingerprint: 'i', worktreeFingerprint: 'w', coherence: 'coherent' },
  });
  const timestamp = new Date().toISOString();
  db.prepare(`
    INSERT INTO assignments (id, project_id, worktree_id, agent_id, task_id, scope_json, status, revision, session_id, created_at, updated_at)
    VALUES ('assignment-r6', ?, ?, 'ZCode', 'frozen', '{}', 'active', 3, 'session-r6', ?, ?)
  `).run(registered.projectId, worktreeId, timestamp, timestamp);
  // 签发后已过期但未被接手的转交：状态仍 pending，会话保持冻结。
  db.prepare(`
    INSERT INTO conversation_transfers (
      id, session_id, worktree_id, state, code_hash, issued_revision,
      previous_owner_key, expires_at, created_at
    ) VALUES ('transfer-r6', 'session-r6', ?, 'pending', ?, 3, ?, ?, ?)
  `).run(worktreeId, 'h'.repeat(64), 'owner-key', Date.now() - 1000, timestamp);

  const drifted = observation({ repositoryIdentity: 'repository-drifted', worktreeIdentity: 'worktree-drifted' });
  const frozenOk = confirmProjectLocation(db, { commandId: 'confirm-r6-frozen', projectId: registered.projectId, observation: drifted });
  assert.equal(frozenOk.ok, true, JSON.stringify(frozenOk));
  assert.equal(frozenOk.locationConfirmed, true);
  const worktree = db.prepare('SELECT * FROM worktrees WHERE id = ?').get(worktreeId);
  assert.equal(worktree.repository_identity, 'repository-drifted');
  assert.equal(worktree.identity_fingerprint, 'worktree-drifted');

  // 接手完成后（consumed）会话恢复可写，冻结豁免不再适用。
  db.prepare('UPDATE worktrees SET repository_identity = ?, identity_fingerprint = ? WHERE id = ?')
    .run('repository-one', 'worktree-one', worktreeId);
  db.prepare("UPDATE conversation_transfers SET state = 'consumed', consumed_by = 'zcode:chat-2', resolved_at = ? WHERE id = 'transfer-r6'")
    .run(new Date().toISOString());
  const busyAfterConsumed = confirmProjectLocation(db, { commandId: 'confirm-r6-consumed', projectId: registered.projectId, observation: drifted });
  assert.equal(busyAfterConsumed.ok, false);
  assert.equal(busyAfterConsumed.code, 'PROJECT_LOCATION_CONFIRMATION_BUSY');
  assert.equal(busyAfterConsumed.blockingRunId, 'session-r6');
});
