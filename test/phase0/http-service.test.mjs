import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openCockpitDatabase } from '../../src/core/database.mjs';
import { registerProject } from '../../src/core/projects.mjs';
import { probeGitWorktree } from '../../src/git/probe.mjs';
import { createCockpitHttpServer } from '../../src/service/http-server.mjs';
import { VERSION } from '../../src/version.mjs';

const TOKEN = 'phase-zero-test-token-that-is-long-enough';

function fixtureTempRoot() {
  // POSIX 的系统临时目录（/tmp、/var）本身是符号链接；路径授权默认拒绝
  // 穿越链接，因此夹具必须建立在真实路径下。
  return process.platform === 'win32' ? os.tmpdir() : realpathSync(os.tmpdir());
}

function createRepository() {
  const container = mkdtempSync(path.join(fixtureTempRoot(), 'ugk-cockpit-http-'));
  const root = path.join(container, 'repository');
  mkdirSync(root, { recursive: true });
  initializeRepository(root, 'fixture');
  return root;
}

function initializeRepository(root, marker) {
  const git = (args) => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'UGK Fixture']);
  git(['config', 'user.email', 'fixture@localhost']);
  writeFileSync(path.join(root, 'README.md'), `${marker}\n`, 'utf8');
  git(['add', 'README.md']);
  git(['commit', '-m', `${marker} baseline`]);
}

function dataPath(root, name = 'service.db') {
  return path.join(path.dirname(root), name);
}

function cleanup(root) {
  rmSync(path.dirname(root), { recursive: true, force: true });
}

function fakeObservation(candidate, { coherence = 'coherent', state = 'clean' } = {}) {
  return {
    canonicalPath: candidate,
    repositoryCommonDir: path.join(candidate, '.git'),
    gitDirectory: path.join(candidate, '.git'),
    indexPath: path.join(candidate, '.git', 'index'),
    objectDirectories: [path.join(candidate, '.git', 'objects')],
    repositoryIdentity: 'fake-repository-identity',
    worktreeIdentity: 'fake-worktree-identity',
    observedAt: new Date().toISOString(),
    coherence,
    headRelation: 'same',
    after: {
      head: 'd'.repeat(40),
      branch: 'main',
      indexFingerprint: `index-${state}`,
      worktreeFingerprint: `worktree-${state}`,
    },
  };
}

function request(service, pathname, options = {}) {
  return fetch(`http://${service.host}:${service.port}${pathname}`, options);
}

async function assertUserError(response, status, code) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.code, code);
  assert.equal(typeof body.message, 'string');
  assert.ok(body.message.length > 0);
  assert.equal(typeof body.impact, 'string');
  assert.ok(body.impact.length > 0);
  assert.equal(typeof body.required_action, 'string');
  assert.ok(body.required_action.length > 0);
  assert.ok(Object.hasOwn(body, 'next_command'));
  assert.ok(Array.isArray(body.warnings));
  assert.ok(Object.hasOwn(body, 'command_id'));
  return body;
}

test('local HTTP boundary requires auth and rejects foreign origins', async (t) => {
  const root = createRepository();
  const service = await createCockpitHttpServer({
    dbPath: dataPath(root),
    token: TOKEN,
    authorizedRoots: [root],
  });
  t.after(async () => {
    await service.close();
    cleanup(root);
  });
  const health = await request(service, '/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).version, VERSION);
  await assertUserError(
    await request(service, '/api/v1/runs/start', { method: 'POST' }),
    401,
    'AUTH_REQUIRED',
  );
  await assertUserError(await request(service, '/api/v1/runs/start', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      origin: 'https://attacker.example',
    },
  }), 403, 'ORIGIN_REJECTED');
});

test('local MCP bootstrap rejects web origins and issues a token scoped away from dashboard', async (t) => {
  const root = createRepository();
  const service = await createCockpitHttpServer({
    dbPath: dataPath(root),
    token: TOKEN,
    authorizedRoots: [root],
  });
  t.after(async () => {
    await service.close();
    cleanup(root);
  });

  await assertUserError(await request(service, '/api/v1/mcp/session', {
    method: 'POST',
    headers: { origin: 'https://attacker.example', 'content-type': 'application/json' },
    body: JSON.stringify({ client: 'ugk-cockpit-stdio' }),
  }), 403, 'ORIGIN_REJECTED');

  const issuedResponse = await request(service, '/api/v1/mcp/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client: 'ugk-cockpit-stdio' }),
  });
  assert.equal(issuedResponse.status, 201);
  const issued = await issuedResponse.json();
  assert.equal(issued.ok, true);
  assert.ok(issued.token.length >= 32);

  await assertUserError(await request(service, '/api/v1/dashboard', {
    headers: { authorization: `Bearer ${issued.token}` },
  }), 401, 'AUTH_REQUIRED');

  await assertUserError(await request(service, '/api/v1/mcp/work/progress', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${issued.token}`,
      'content-type': 'application/json',
    },
    body: '{}',
  }), 400, 'INVALID_REQUEST');
});

test('local web shell sets an HttpOnly session and browser mutations require same-origin evidence', async (t) => {
  const root = createRepository();
  let pickerCalls = 0;
  const service = await createCockpitHttpServer({
    dbPath: dataPath(root),
    token: TOKEN,
    authorizedRoots: [],
    folderPicker: async () => {
      pickerCalls += 1;
      return root;
    },
  });
  t.after(async () => {
    await service.close();
    cleanup(root);
  });
  const shell = await request(service, '/');
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const cookie = shell.headers.get('set-cookie');
  assert.match(cookie, /ugk_cockpit_session=/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  assert.doesNotMatch(await shell.text(), new RegExp(TOKEN));

  await assertUserError(await request(service, '/api/v1/folders/select', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: '{}',
  }), 403, 'ORIGIN_REJECTED');
  assert.equal(pickerCalls, 0);

  const accepted = await request(service, '/api/v1/folders/select', {
    method: 'POST',
    headers: {
      cookie,
      origin: `http://127.0.0.1:${service.port}`,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      'x-ugk-client-id': 'browser-fixture-client-0001',
    },
    body: '{}',
  });
  assert.equal(accepted.status, 200);
  assert.equal(pickerCalls, 1);
});

test('browser same-origin multipart avatar upload passes the mutation boundary', async (t) => {
  const root = createRepository();
  const dbPath = dataPath(root);
  const db = openCockpitDatabase(dbPath);
  const registered = registerProject(db, {
    commandId: 'browser-avatar-upload-1',
    name: '浏览器头像上传',
    observation: fakeObservation(root),
  });
  db.close();

  const service = await createCockpitHttpServer({
    dbPath,
    token: TOKEN,
    authorizedRoots: [root],
  });
  t.after(async () => {
    await service.close();
    cleanup(root);
  });

  const shell = await request(service, '/');
  const cookie = shell.headers.get('set-cookie');
  const formData = new FormData();
  formData.append('file', new Blob([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  ], { type: 'image/png' }), 'avatar.png');

  const response = await request(service, `/api/v1/projects/${registered.projectId}/avatar/upload`, {
    method: 'POST',
    headers: {
      cookie,
      origin: `http://127.0.0.1:${service.port}`,
      'sec-fetch-site': 'same-origin',
      'x-ugk-client-id': 'browser-avatar-client-0001',
    },
    body: formData,
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.mimeType, 'image/png');
});

test('durable folder grant can finish after a service restart with the same CLI identity', async (t) => {
  const root = createRepository();
  const dbPath = dataPath(root);
  let service = await createCockpitHttpServer({
    dbPath,
    token: TOKEN,
    folderPicker: async () => root,
  });
  t.after(async () => {
    await service?.close();
    cleanup(root);
  });
  const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  const selected = await (await request(service, '/api/v1/folders/select', {
    method: 'POST', headers, body: '{}',
  })).json();
  await service.close();
  service = await createCockpitHttpServer({ dbPath, token: TOKEN });
  const registered = await request(service, '/api/v1/projects', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      commandId: 'register-after-service-restart',
      grantId: selected.grantId,
      name: '重启后继续',
    }),
  });
  assert.equal(registered.status, 201);
  assert.equal((await registered.json()).name, '重启后继续');
});

test('browser can continue a selected folder after service restart without exposing the API token', async (t) => {
  const root = createRepository();
  const dbPath = dataPath(root);
  const clientId = 'browser-restart-client-0001';
  let service = await createCockpitHttpServer({
    dbPath,
    token: TOKEN,
    folderPicker: async () => root,
  });
  t.after(async () => {
    await service?.close();
    cleanup(root);
  });
  let shell = await request(service, '/');
  const firstCookie = shell.headers.get('set-cookie');
  const browserHeaders = (cookie) => ({
    cookie,
    origin: `http://127.0.0.1:${service.port}`,
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
    'x-ugk-client-id': clientId,
  });
  const selected = await (await request(service, '/api/v1/folders/select', {
    method: 'POST', headers: browserHeaders(firstCookie), body: '{}',
  })).json();
  await service.close();
  service = await createCockpitHttpServer({ dbPath, token: TOKEN });
  shell = await request(service, '/');
  const newCookie = shell.headers.get('set-cookie');
  assert.notEqual(newCookie, firstCookie);
  const registered = await request(service, '/api/v1/projects', {
    method: 'POST',
    headers: browserHeaders(newCookie),
    body: JSON.stringify({
      commandId: 'browser-register-after-restart',
      grantId: selected.grantId,
      name: '浏览器重启恢复',
    }),
  });
  assert.equal(registered.status, 201);
  assert.equal((await registered.json()).name, '浏览器重启恢复');
});

test('folder selection grants one registration and dashboard returns human project state', async (t) => {
  const root = createRepository();
  const service = await createCockpitHttpServer({
    dbPath: dataPath(root),
    token: TOKEN,
    authorizedRoots: [],
    folderPicker: async () => root,
  });
  t.after(async () => {
    await service.close();
    cleanup(root);
  });
  const headers = {
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
  };
  const selectedResponse = await request(service, '/api/v1/folders/select', {
    method: 'POST',
    headers,
    body: '{}',
  });
  assert.equal(selectedResponse.status, 200);
  const selected = await selectedResponse.json();
  assert.equal(selected.cancelled, false);
  assert.match(selected.promise, /不会.*修改|不会.*覆盖/);

  const registeredResponse = await request(service, '/api/v1/projects', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      commandId: 'register-http-project',
      grantId: selected.grantId,
      name: '第一个项目',
    }),
  });
  assert.equal(registeredResponse.status, 201);
  assert.equal((await registeredResponse.json()).status, 'ready');

  const dashboardResponse = await request(service, '/api/v1/dashboard', { headers });
  assert.equal(dashboardResponse.status, 200);
  const dashboard = await dashboardResponse.json();
  assert.equal(dashboard.projects.length, 1);
  assert.equal(dashboard.projects[0].name, '第一个项目');
  assert.equal(dashboard.projects[0].statusReason, 'ready_to_start');

  await assertUserError(await request(service, '/api/v1/projects', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      commandId: 'reuse-folder-grant',
      grantId: selected.grantId,
      name: '不能重复消费',
    }),
  }), 409, 'FOLDER_GRANT_IN_USE');
});

test('a manually selected folder can enter the confirmation flow', async (t) => {
  const root = createRepository();
  let openFolderCalls = 0;
  const service = await createCockpitHttpServer({
    dbPath: dataPath(root),
    token: TOKEN,
    authorizedRoots: [],
    folderPicker: async () => {
      openFolderCalls += 1;
      return root;
    },
  });
  t.after(async () => {
    await service.close();
    cleanup(root);
  });
  const shell = await request(service, '/');
  const cookie = shell.headers.get('set-cookie');
  const selected = await request(service, '/api/v1/folders/select', {
    method: 'POST',
    headers: {
      cookie,
      origin: `http://127.0.0.1:${service.port}`,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      'x-ugk-client-id': 'browser-open-folder-0001',
    },
    body: '{}',
  });

  assert.equal(selected.status, 200);
  assert.equal(openFolderCalls, 1);
  const body = await selected.json();
  assert.equal(body.cancelled, false);
  assert.equal(body.folderPath, root);
  assert.equal(typeof body.grantId, 'string');
});

test('a selected folder without a Git project returns a human recovery action', async (t) => {
  const root = createRepository();
  const service = await createCockpitHttpServer({
    dbPath: dataPath(root),
    token: TOKEN,
    authorizedRoots: [],
    folderPicker: async () => root,
    probe: async () => {
      throw Object.assign(new Error('git failed'), {
        code: 128,
        stderr: 'fatal: not a git repository',
      });
    },
  });
  t.after(async () => {
    await service.close();
    cleanup(root);
  });

  await assertUserError(await request(service, '/api/v1/folders/select', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: '{}',
  }), 422, 'FOLDER_NOT_CODE_PROJECT');
});

test('a manually selected folder below a junction ancestor cannot receive a grant', async (t) => {
  const root = createRepository();
  const linkContainer = mkdtempSync(path.join(fixtureTempRoot(), 'ugk-cockpit-http-link-'));
  const ancestorLink = path.join(linkContainer, 'opened-link');
  symlinkSync(path.dirname(root), ancestorLink, process.platform === 'win32' ? 'junction' : 'dir');
  const selectedThroughLink = path.join(ancestorLink, path.basename(root));
  let probeCalls = 0;
  const service = await createCockpitHttpServer({
    dbPath: dataPath(root),
    token: TOKEN,
    authorizedRoots: [],
    folderPicker: async () => selectedThroughLink,
    probe: async () => {
      probeCalls += 1;
      return fakeObservation(root);
    },
  });
  t.after(async () => {
    await service.close();
    cleanup(root);
    rmSync(linkContainer, { recursive: true, force: true });
  });

  await assertUserError(await request(service, '/api/v1/folders/select', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: '{}',
  }), 400, 'REPARSE_POINT');
  assert.equal(probeCalls, 0);
});

test('folder grant binds repository identity and survives a transient probe failure', async (t) => {
  const root = createRepository();
  let probeCalls = 0;
  let failNextRegistration = true;
  const service = await createCockpitHttpServer({
    dbPath: dataPath(root),
    token: TOKEN,
    authorizedRoots: [],
    folderPicker: async () => root,
    probe: async (candidate) => {
      probeCalls += 1;
      if (probeCalls > 1 && failNextRegistration) {
        failNextRegistration = false;
        throw new Error('transient fixture failure');
      }
      return fakeObservation(candidate);
    },
  });
  t.after(async () => {
    await service.close();
    cleanup(root);
  });
  const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  const selected = await (await request(service, '/api/v1/folders/select', {
    method: 'POST', headers, body: '{}',
  })).json();
  const body = JSON.stringify({
    commandId: 'retry-project-registration',
    grantId: selected.grantId,
    name: '可以重试',
  });
  await assertUserError(await request(service, '/api/v1/projects', {
    method: 'POST', headers, body,
  }), 400, 'REQUEST_FAILED');
  const retried = await request(service, '/api/v1/projects', {
    method: 'POST', headers, body,
  });
  assert.equal(retried.status, 201);
  assert.equal((await retried.json()).name, '可以重试');
});

test('same-path repository replacement after folder selection requires reselection', async (t) => {
  const root = createRepository();
  let probeCalls = 0;
  const service = await createCockpitHttpServer({
    dbPath: dataPath(root),
    token: TOKEN,
    authorizedRoots: [],
    folderPicker: async () => root,
    probe: async (candidate) => {
      probeCalls += 1;
      return {
        ...fakeObservation(candidate),
        repositoryIdentity: probeCalls === 1 ? 'selected-repository' : 'replacement-repository',
        worktreeIdentity: probeCalls === 1 ? 'selected-worktree' : 'replacement-worktree',
      };
    },
  });
  t.after(async () => {
    await service.close();
    cleanup(root);
  });
  const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  const selected = await (await request(service, '/api/v1/folders/select', {
    method: 'POST', headers, body: '{}',
  })).json();
  await assertUserError(await request(service, '/api/v1/projects', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      commandId: 'replacement-after-selection',
      grantId: selected.grantId,
      name: '不应添加',
    }),
  }), 409, 'FOLDER_SELECTION_CHANGED');
  const db = openCockpitDatabase(dataPath(root), { migrate: false });
  assert.equal(db.prepare('SELECT count(*) AS count FROM projects').get().count, 0);
  db.close();
});

test('invalid input and unknown runs do not create dangling commands', async (t) => {
  const root = createRepository();
  const dbPath = dataPath(root);
  const service = await createCockpitHttpServer({
    dbPath,
    token: TOKEN,
    authorizedRoots: [root],
  });
  t.after(async () => {
    await service.close();
    cleanup(root);
  });
  const headers = {
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
  };
  await assertUserError(await request(service, '/api/v1/runs/start', {
    method: 'POST',
    headers,
    body: JSON.stringify({ commandId: 'invalid-start' }),
  }), 400, 'INVALID_REQUEST');
  await assertUserError(await request(service, '/api/v1/runs/missing-run/finish', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      commandId: 'missing-finish',
      expectedRevision: 1,
      leaseGeneration: 1,
      outcome: 'completed',
    }),
  }), 404, 'RUN_NOT_FOUND');

  const db = openCockpitDatabase(dbPath, { migrate: false });
  assert.equal(db.prepare('SELECT count(*) AS count FROM commands').get().count, 0);
  db.close();
});

test('path, size, and unknown-route failures use the complete user error contract', async (t) => {
  const root = createRepository();
  const service = await createCockpitHttpServer({
    dbPath: dataPath(root),
    token: TOKEN,
    authorizedRoots: [],
  });
  t.after(async () => {
    await service.close();
    cleanup(root);
  });
  const headers = {
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
  };
  await assertUserError(await request(service, '/api/v1/runs/start', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      commandId: 'path-start',
      worktreePath: root,
      agentClaim: 'codex',
      goal: 'must be authorized',
    }),
  }), 403, 'PATH_NOT_AUTHORIZED');
  await assertUserError(await request(service, '/api/v1/runs/start', {
    method: 'POST',
    headers,
    body: JSON.stringify({ oversized: 'x'.repeat(70_000) }),
  }), 413, 'REQUEST_TOO_LARGE');
  await assertUserError(await request(service, '/api/v1/does-not-exist', {
    method: 'POST',
    headers,
    body: '{}',
  }), 404, 'NOT_FOUND');
});

test('database contention fails quickly with a retryable user error and keeps health responsive', async (t) => {
  const root = createRepository();
  const dbPath = dataPath(root);
  const service = await createCockpitHttpServer({
    dbPath,
    token: TOKEN,
    authorizedRoots: [root],
    probe: async (candidate) => fakeObservation(candidate),
  });
  const blocker = new DatabaseSync(dbPath, { timeout: 0 });
  t.after(async () => {
    try { blocker.exec('ROLLBACK'); } catch {}
    blocker.close();
    await service.close();
    cleanup(root);
  });
  blocker.exec('BEGIN IMMEDIATE');

  const headers = {
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
  };
  const startedAt = performance.now();
  const startRequest = request(service, '/api/v1/runs/start', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      commandId: 'busy-start',
      worktreePath: root,
      agentClaim: 'codex',
      goal: 'busy test',
    }),
  });
  const healthRequest = request(service, '/health');
  const [startResponse, healthResponse] = await Promise.all([startRequest, healthRequest]);
  const elapsedMs = performance.now() - startedAt;

  await assertUserError(startResponse, 503, 'DATABASE_BUSY');
  assert.equal(healthResponse.status, 200);
  assert.ok(elapsedMs < 500, `busy handling took ${elapsedMs.toFixed(1)}ms`);
});

test('unknown repository can start and finish through the HTTP service', async (t) => {
  const root = createRepository();
  const service = await createCockpitHttpServer({
    dbPath: dataPath(root),
    token: TOKEN,
    authorizedRoots: [root],
  });
  t.after(async () => {
    await service.close();
    cleanup(root);
  });
  const headers = {
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
  };
  const startResponse = await request(service, '/api/v1/runs/start', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      commandId: 'http-start',
      runId: 'http-run',
      worktreePath: root,
      agentClaim: 'codex',
      goal: 'HTTP vertical test',
    }),
  });
  assert.equal(startResponse.status, 201);
  const started = await startResponse.json();
  assert.equal(started.ok, true);

  const finishResponse = await request(service, '/api/v1/runs/http-run/finish', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      commandId: 'http-finish',
      expectedRevision: started.revision,
      leaseGeneration: started.leaseGeneration,
      outcome: 'completed',
      summary: 'done',
    }),
  });
  assert.equal(finishResponse.status, 200);
  const finished = await finishResponse.json();
  assert.equal(finished.ok, true);
  assert.equal(finished.status, 'completed');
});

test('lease and revision conflicts are translated into actionable user errors', async (t) => {
  const root = createRepository();
  const service = await createCockpitHttpServer({
    dbPath: dataPath(root),
    token: TOKEN,
    authorizedRoots: [root],
  });
  t.after(async () => {
    await service.close();
    cleanup(root);
  });
  const headers = {
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
  };
  const start = await request(service, '/api/v1/runs/start', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      commandId: 'conflict-start-one',
      runId: 'conflict-run-one',
      worktreePath: root,
      agentClaim: 'codex',
      goal: 'first writer',
    }),
  });
  const started = await start.json();
  await assertUserError(await request(service, '/api/v1/runs/start', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      commandId: 'conflict-start-two',
      runId: 'conflict-run-two',
      worktreePath: root,
      agentClaim: 'luna',
      goal: 'second writer',
    }),
  }), 409, 'WRITE_LEASE_CONFLICT');
  await assertUserError(await request(service, '/api/v1/runs/conflict-run-one/finish', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      commandId: 'revision-conflict-finish',
      expectedRevision: 99,
      leaseGeneration: started.leaseGeneration,
      outcome: 'completed',
      summary: 'must not complete',
    }),
  }), 409, 'RUN_REVISION_CONFLICT');
});

test('an incoherent final probe returns a safe next action and keeps the run active', async (t) => {
  const root = createRepository();
  let probeCount = 0;
  const fakeProbe = async (candidate) => {
    probeCount += 1;
    return fakeObservation(candidate, {
      coherence: probeCount === 1 ? 'coherent' : 'incoherent',
      state: `state-${probeCount}`,
    });
  };
  const service = await createCockpitHttpServer({
    dbPath: dataPath(root),
    token: TOKEN,
    authorizedRoots: [root],
    probe: fakeProbe,
  });
  t.after(async () => {
    await service.close();
    cleanup(root);
  });
  const headers = {
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
  };
  const start = await request(service, '/api/v1/runs/start', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      commandId: 'incoherent-start',
      runId: 'incoherent-run',
      worktreePath: root,
      agentClaim: 'codex',
      goal: 'coherence test',
    }),
  });
  const started = await start.json();
  await assertUserError(await request(service, '/api/v1/runs/incoherent-run/finish', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      commandId: 'incoherent-finish',
      expectedRevision: started.revision,
      leaseGeneration: started.leaseGeneration,
      outcome: 'completed',
      summary: 'must stay active',
    }),
  }), 409, 'INCOHERENT_FINAL_SNAPSHOT');
});

test('a linked worktree cannot silently use a repository outside its grant', async (t) => {
  const main = createRepository();
  const container = path.dirname(main);
  const linked = path.join(container, 'linked');
  execFileSync('git', ['worktree', 'add', '-b', 'linked', linked], {
    cwd: main,
    windowsHide: true,
    stdio: 'pipe',
  });
  const service = await createCockpitHttpServer({
    dbPath: path.join(container, 'service.db'),
    token: TOKEN,
    authorizedRoots: [linked],
  });
  t.after(async () => {
    await service.close();
    cleanup(main);
  });
  await assertUserError(await request(service, '/api/v1/runs/start', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      commandId: 'linked-outside-start',
      runId: 'linked-outside-run',
      worktreePath: linked,
      agentClaim: 'codex',
      goal: 'must require repository grant',
    }),
  }), 403, 'PATH_NOT_AUTHORIZED');
});

test('repository-local core.worktree cannot redirect observation outside its grant', async (t) => {
  const root = createRepository();
  const outside = path.join(path.dirname(root), 'outside-worktree');
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'outside.txt'), 'must not be observed\n', 'utf8');
  execFileSync('git', ['config', 'core.worktree', outside], {
    cwd: root,
    windowsHide: true,
    stdio: 'pipe',
  });
  const service = await createCockpitHttpServer({
    dbPath: dataPath(root),
    token: TOKEN,
    authorizedRoots: [root],
  });
  t.after(async () => {
    await service.close();
    cleanup(root);
  });

  await assertUserError(await request(service, '/api/v1/runs/start', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      commandId: 'core-worktree-escape',
      worktreePath: root,
      agentClaim: 'codex',
      goal: 'must stay within grant',
    }),
  }), 403, 'PATH_NOT_AUTHORIZED');
});

test('an undeclared external commit cannot become a completed receipt', async (t) => {
  const root = createRepository();
  const service = await createCockpitHttpServer({
    dbPath: dataPath(root),
    token: TOKEN,
    authorizedRoots: [root],
  });
  t.after(async () => {
    await service.close();
    cleanup(root);
  });
  const headers = {
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
  };
  const started = await (await request(service, '/api/v1/runs/start', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      commandId: 'foreign-start',
      runId: 'foreign-run',
      worktreePath: root,
      agentClaim: 'codex',
      goal: 'foreign commit test',
    }),
  })).json();
  writeFileSync(path.join(root, 'README.md'), 'external commit\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: root, windowsHide: true, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'external commit'], { cwd: root, windowsHide: true, stdio: 'pipe' });

  await assertUserError(await request(service, '/api/v1/runs/foreign-run/finish', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      commandId: 'foreign-finish',
      expectedRevision: started.revision,
      leaseGeneration: started.leaseGeneration,
      outcome: 'completed',
      summary: 'must not complete',
    }),
  }), 409, 'FOREIGN_HEAD_CHANGE');
});

test('dirty changes require explicit unattributed acknowledgement before completion', async (t) => {
  const root = createRepository();
  const service = await createCockpitHttpServer({
    dbPath: dataPath(root),
    token: TOKEN,
    authorizedRoots: [root],
  });
  t.after(async () => {
    await service.close();
    cleanup(root);
  });
  const headers = {
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
  };
  const started = await (await request(service, '/api/v1/runs/start', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      commandId: 'dirty-start',
      runId: 'dirty-run',
      worktreePath: root,
      agentClaim: 'codex',
      goal: 'dirty attribution test',
    }),
  })).json();
  writeFileSync(path.join(root, 'README.md'), 'dirty change\n', 'utf8');
  const baseFinish = {
    expectedRevision: started.revision,
    leaseGeneration: started.leaseGeneration,
    outcome: 'completed',
    summary: 'dirty work',
  };
  await assertUserError(await request(service, '/api/v1/runs/dirty-run/finish', {
    method: 'POST',
    headers,
    body: JSON.stringify({ commandId: 'dirty-finish-denied', ...baseFinish }),
  }), 409, 'UNATTRIBUTED_CHANGES_REQUIRE_CONFIRMATION');

  const accepted = await request(service, '/api/v1/runs/dirty-run/finish', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      commandId: 'dirty-finish-confirmed',
      ...baseFinish,
      acknowledgeUnattributed: true,
    }),
  });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).status, 'completed');
});

test('replacing a repository at the same path cannot complete the old run', async (t) => {
  const root = createRepository();
  const container = path.dirname(root);
  const service = await createCockpitHttpServer({
    dbPath: dataPath(root),
    token: TOKEN,
    authorizedRoots: [root],
  });
  t.after(async () => {
    await service.close();
    cleanup(root);
  });
  const headers = {
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
  };
  const started = await (await request(service, '/api/v1/runs/start', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      commandId: 'replace-start',
      runId: 'replace-run',
      worktreePath: root,
      agentClaim: 'codex',
      goal: 'repository replacement test',
    }),
  })).json();
  renameSync(root, path.join(container, 'original-repository'));
  mkdirSync(root);
  initializeRepository(root, 'replacement');

  await assertUserError(await request(service, '/api/v1/runs/replace-run/finish', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      commandId: 'replace-finish',
      expectedRevision: started.revision,
      leaseGeneration: started.leaseGeneration,
      outcome: 'completed',
      summary: 'must not complete',
    }),
  }), 409, 'WORKTREE_IDENTITY_CHANGED');
});

test('a slow asynchronous probe does not block health', async (t) => {
  const root = createRepository();
  const fakeProbe = async (candidate) => {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    return fakeObservation(candidate);
  };
  const service = await createCockpitHttpServer({
    dbPath: dataPath(root),
    token: TOKEN,
    authorizedRoots: [root],
    probe: fakeProbe,
  });
  t.after(async () => {
    await service.close();
    cleanup(root);
  });
  const slowRequest = request(service, '/api/v1/runs/start', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      commandId: 'slow-start',
      runId: 'slow-run',
      worktreePath: root,
      agentClaim: 'codex',
      goal: 'latency test',
    }),
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const startedAt = performance.now();
  const health = await request(service, '/health');
  const elapsed = performance.now() - startedAt;
  assert.equal(health.status, 200);
  assert.ok(elapsed < 200, `health took ${elapsed.toFixed(1)}ms`);
  await slowRequest;
});

test('the loopback endpoint is a second single-instance fence', async (t) => {
  const root = createRepository();
  const first = await createCockpitHttpServer({
    dbPath: dataPath(root, 'first.db'),
    token: TOKEN,
    port: 0,
  });
  t.after(async () => {
    await first.close();
    cleanup(root);
  });
  await assert.rejects(
    createCockpitHttpServer({
      dbPath: dataPath(root, 'second.db'),
      token: TOKEN,
      port: first.port,
    }),
    { code: 'EADDRINUSE' },
  );
});

test('service restart preserves active run status and does not mark it recovery_uncertain or interrupt dashboard', async (t) => {
  const root = createRepository();
  const dbPath = dataPath(root);
  const observation = await probeGitWorktree(root);
  const seedDb = openCockpitDatabase(dbPath);
  registerProject(seedDb, {
    commandId: 'register-restart-active-project',
    name: '重启中的会话',
    observation,
  });
  seedDb.close();
  let service = await createCockpitHttpServer({
    dbPath,
    token: TOKEN,
    authorizedRoots: [root],
  });
  t.after(async () => {
    await service?.close();
    cleanup(root);
  });
  const headers = {
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
  };
  const startResponse = await request(service, '/api/v1/runs/start', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      commandId: 'restart-active-start',
      runId: 'restart-active-run',
      worktreePath: root,
      agentClaim: 'codex',
      goal: 'restart preserves active run',
    }),
  });
  assert.equal(startResponse.status, 201);
  const started = await startResponse.json();
  assert.equal(started.ok, true);

  await service.close();
  service = await createCockpitHttpServer({
    dbPath,
    token: TOKEN,
    authorizedRoots: [root],
  });

  const checkDb = openCockpitDatabase(dbPath, { migrate: false });
  const runRow = checkDb.prepare('SELECT lifecycle, health FROM runs WHERE id = ?').get('restart-active-run');
  assert.equal(runRow.lifecycle, 'active');
  assert.equal(runRow.health, 'healthy');
  checkDb.close();

  const dashboardResponse = await request(service, '/api/v1/dashboard', { headers });
  assert.equal(dashboardResponse.status, 200);
  const dashboard = await dashboardResponse.json();
  assert.equal(dashboard.projects.length, 1);
  assert.equal(dashboard.projects[0].statusReason, 'active_work');
  assert.equal(dashboard.projects[0].activeRun.id, 'restart-active-run');

  const finishResponse = await request(service, '/api/v1/runs/restart-active-run/finish', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      commandId: 'restart-active-finish',
      expectedRevision: started.revision,
      leaseGeneration: started.leaseGeneration,
      outcome: 'completed',
      summary: 'finished after restart',
    }),
  });
  assert.equal(finishResponse.status, 200);
});

test('HTTP empty folder selection, spaces listing, and space workspace creation', async (t) => {
  const root = createRepository();
  const dbPath = dataPath(root);
  const tempContainer = mkdtempSync(path.join(fixtureTempRoot(), 'ugk-test-spaces-'));
  const emptyFolder = path.join(tempContainer, 'empty-dir');
  const nonEmptyFolder = path.join(tempContainer, 'non-empty-dir');
  const regularFile = path.join(tempContainer, 'regular-file.txt');
  mkdirSync(emptyFolder, { recursive: true });
  mkdirSync(nonEmptyFolder, { recursive: true });
  writeFileSync(path.join(nonEmptyFolder, 'file.txt'), 'hello', 'utf8');
  writeFileSync(regularFile, 'hello', 'utf8');

  let currentSelectedFolder = null;
  const folderPicker = async () => currentSelectedFolder;

  const service = await createCockpitHttpServer({
    dbPath,
    token: TOKEN,
    authorizedRoots: [root, tempContainer],
    folderPicker,
    createGitWorktree: async (repoPath, { targetPath, branch, baseCommit }) => {
      // Simulate git worktree create
      execFileSync('git', ['worktree', 'add', '-b', branch, targetPath, baseCommit], {
        cwd: root,
        windowsHide: true,
        stdio: 'pipe',
      });
      return { ok: true, targetPath, branch, baseCommit };
    },
  });
  t.after(async () => {
    await service.close();
    cleanup(root);
    rmSync(tempContainer, { recursive: true, force: true });
  });

  const headers = {
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
  };

  // 1. Folder picker cancelled
  currentSelectedFolder = null;
  const cancelResponse = await request(service, '/api/v1/folders/select-empty', {
    method: 'POST',
    headers,
  });
  assert.equal(cancelResponse.status, 200);
  const cancelResult = await cancelResponse.json();
  assert.equal(cancelResult.ok, true);
  assert.equal(cancelResult.cancelled, true);

  // 2. Folder picker select non-empty directory -> 400 DIRECTORY_NOT_EMPTY
  currentSelectedFolder = nonEmptyFolder;
  const nonEmptyResponse = await request(service, '/api/v1/folders/select-empty', {
    method: 'POST',
    headers,
  });
  await assertUserError(nonEmptyResponse, 400, 'DIRECTORY_NOT_EMPTY');

  // 3. Folder picker select file -> 400 NOT_A_DIRECTORY
  currentSelectedFolder = regularFile;
  const fileResponse = await request(service, '/api/v1/folders/select-empty', {
    method: 'POST',
    headers,
  });
  await assertUserError(fileResponse, 400, 'NOT_A_DIRECTORY');

  // 4. Folder picker select valid empty directory -> grantId issued
  currentSelectedFolder = emptyFolder;
  const selectResponse = await request(service, '/api/v1/folders/select-empty', {
    method: 'POST',
    headers,
  });
  assert.equal(selectResponse.status, 200);
  const selectResult = await selectResponse.json();
  assert.equal(selectResult.ok, true);
  assert.equal(selectResult.cancelled, false);
  assert.ok(selectResult.grantId);
  assert.equal(typeof selectResult.grantId, 'string');
  assert.equal(selectResult.folderName, 'empty-dir');
  assert.equal(selectResult.folderPath, emptyFolder);

  // 5. Register the project first so we have a project to add spaces to
  currentSelectedFolder = root;
  const regSelect = await (await request(service, '/api/v1/folders/select', {
    method: 'POST',
    headers,
  })).json();
  const regProj = await (await request(service, '/api/v1/projects', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      commandId: 'reg-proj-cmd',
      grantId: regSelect.grantId,
      name: 'Spaces Test Project',
    }),
  })).json();
  assert.equal(regProj.ok, true);
  const projectId = regProj.projectId;

  // 6. GET /api/v1/projects/:projectId/spaces -> initially empty
  const listResponse = await request(service, `/api/v1/projects/${projectId}/spaces`, {
    method: 'GET',
    headers,
  });
  assert.equal(listResponse.status, 200);
  const listResult = await listResponse.json();
  assert.equal(listResult.ok, true);
  assert.equal(listResult.projectId, projectId);
  assert.deepEqual(listResult.spaces, []);

  // 7. POST /api/v1/projects/:projectId/spaces with invalid extra fields (e.g. trying to inject path) -> 400 INVALID_REQUEST
  const invalidBodyResponse = await request(service, `/api/v1/projects/${projectId}/spaces`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      commandId: 'space-cmd-invalid',
      grantId: selectResult.grantId,
      expectedBaseHead: 'd'.repeat(40),
      path: '/etc/passwd',
    }),
  });
  await assertUserError(invalidBodyResponse, 400, 'INVALID_REQUEST');

  // 8. POST /api/v1/projects/:projectId/spaces with valid payload
  const headCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const createSpaceResponse = await request(service, `/api/v1/projects/${projectId}/spaces`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      commandId: 'create-space-cmd-1',
      grantId: selectResult.grantId,
      expectedBaseHead: headCommit,
      name: 'my-feature-space',
    }),
  });
  assert.equal(createSpaceResponse.status, 201, await createSpaceResponse.clone().text());
  const createResult = await createSpaceResponse.json();
  assert.equal(createResult.ok, true);
  assert.equal(createResult.projectId, projectId);
  assert.ok(createResult.spaceId);
  assert.ok(createResult.worktreeId);
  assert.equal(createResult.canonicalPath, emptyFolder);
  assert.equal(createResult.name, 'my-feature-space');

  // 9. Replay POST with same commandId -> returns 200 with alreadyExists: true
  const replayResponse = await request(service, `/api/v1/projects/${projectId}/spaces`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      commandId: 'create-space-cmd-1',
      grantId: selectResult.grantId,
      expectedBaseHead: headCommit,
      name: 'my-feature-space',
    }),
  });
  assert.equal(replayResponse.status, 200);
  const replayResult = await replayResponse.json();
  assert.equal(replayResult.ok, true);
  assert.equal(replayResult.alreadyExists, true);

  // 10. GET /api/v1/projects/:projectId/spaces now lists the created space
  const updatedList = await (await request(service, `/api/v1/projects/${projectId}/spaces`, {
    method: 'GET',
    headers,
  })).json();
  assert.equal(updatedList.ok, true);
  assert.equal(updatedList.spaces.length, 1);
  assert.equal(updatedList.spaces[0].spaceId, createResult.spaceId);
  assert.equal(updatedList.spaces[0].name, 'my-feature-space');
  assert.equal(updatedList.spaces[0].worktreeId, createResult.worktreeId);

  // 11. GET /api/v1/projects/unknown-proj/spaces -> 404 PROJECT_NOT_FOUND
  const notFoundList = await request(service, '/api/v1/projects/unknown-proj/spaces', {
    method: 'GET',
    headers,
  });
  await assertUserError(notFoundList, 404, 'PROJECT_NOT_FOUND');
});

test('HTTP refreshes a stale main-project observation before development-space creation', async (t) => {
  const root = createRepository();
  const dbPath = dataPath(root);
  const tempContainer = mkdtempSync(path.join(fixtureTempRoot(), 'ugk-test-stale-space-'));
  const emptyFolder = path.join(tempContainer, 'empty-dir');
  mkdirSync(emptyFolder, { recursive: true });

  let currentSelectedFolder = root;
  const service = await createCockpitHttpServer({
    dbPath,
    token: TOKEN,
    authorizedRoots: [root, tempContainer],
    folderPicker: async () => currentSelectedFolder,
  });
  t.after(async () => {
    await service.close();
    cleanup(root);
    rmSync(tempContainer, { recursive: true, force: true });
  });

  const headers = {
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
  };
  const selectedProject = await (await request(service, '/api/v1/folders/select', {
    method: 'POST',
    headers,
  })).json();
  const registered = await (await request(service, '/api/v1/projects', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      commandId: 'register-stale-space-project',
      grantId: selectedProject.grantId,
      name: 'Stale Space Project',
    }),
  })).json();
  const staleHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

  writeFileSync(path.join(root, 'CHANGE.md'), 'new main work\n', 'utf8');
  execFileSync('git', ['add', 'CHANGE.md'], { cwd: root, windowsHide: true, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'advance main'], { cwd: root, windowsHide: true, stdio: 'pipe' });
  const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  assert.notEqual(currentHead, staleHead);

  currentSelectedFolder = emptyFolder;
  const selectedEmpty = await (await request(service, '/api/v1/folders/select-empty', {
    method: 'POST',
    headers,
  })).json();
  const staleCreate = await request(service, `/api/v1/projects/${registered.projectId}/spaces`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      commandId: 'create-space-from-stale-head',
      grantId: selectedEmpty.grantId,
      expectedBaseHead: staleHead,
      name: 'stale-space',
    }),
  });
  await assertUserError(staleCreate, 409, 'BASE_HEAD_STALE');

  const refreshResponse = await request(service, `/api/v1/projects/${registered.projectId}/refresh`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ commandId: 'refresh-before-space-create' }),
  });
  assert.equal(refreshResponse.status, 200);
  const refreshed = await refreshResponse.json();
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.git.head, currentHead);
  assert.equal(refreshed.git.branch, 'main');

  const createResponse = await request(service, `/api/v1/projects/${registered.projectId}/spaces`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      commandId: 'create-space-after-refresh',
      grantId: selectedEmpty.grantId,
      expectedBaseHead: refreshed.git.head,
      name: 'fresh-space',
    }),
  });
  assert.equal(createResponse.status, 201, await createResponse.clone().text());
  assert.equal((await createResponse.json()).ok, true);
});
