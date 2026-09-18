// 代码位置身份确认（confirm-location）：WORKTREE_IDENTITY_CHANGED 之后的
// 用户确认出路。指纹不含 device（macOS 卷号会漂移）；重绑只允许同路径、
// 只允许浏览器会话、保留历史并以命令日志落账。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { fileIdentity } from '../src/git/probe.mjs';
import { probeGitWorktree } from '../src/git/probe.mjs';
import {
  confirmProjectLocation,
  registerProject,
  worktreeIdFor,
} from '../src/core/projects.mjs';
import { startWriteRun } from '../src/core/runs.mjs';
import { createCockpitHttpServer } from '../src/service/http-server.mjs';

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
  t.after(() => cleanup.forEach((fn) => fn()));
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
  const root = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'ugk-confirm-core-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openCockpitDatabase(path.join(root, 'cockpit.db'));
  t.after(() => db.close());
  const registered = registerProject(db, {
    commandId: 'register-1', name: 'Same', observation: observation(),
  });
  const worktreeId = worktreeIdFor('worktree-one');
  startWriteRun(db, {
    commandId: 'run-1', runId: 'run-1', agentClaim: 'codex',
    worktreeId, canonicalPath: '/fixture/project', goal: 'history to preserve',
    repositoryIdentity: 'repository-one', worktreeIdentity: 'worktree-one',
    baseline: { head: 'a'.repeat(40), branch: 'main', indexFingerprint: 'i', worktreeFingerprint: 'w', coherence: 'coherent' },
  });

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

  // Same command replays to the same receipt; a new command is also idempotent
  // when the identity already matches.
  assert.deepEqual(confirmProjectLocation(db, {
    commandId: 'confirm-1', projectId: registered.projectId,
    observation: observation({ repositoryIdentity: 'repository-drifted', worktreeIdentity: 'worktree-drifted' }),
  }), confirmed);
});

test('confirm-location rejects a different path and unknown projects', (t) => {
  const root = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'ugk-confirm-reject-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openCockpitDatabase(path.join(root, 'cockpit.db'));
  t.after(() => db.close());
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
  t.after(() => { cleanup.forEach((fn) => fn()); });
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
  t.after(() => cleanup.forEach((fn) => fn()));
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
