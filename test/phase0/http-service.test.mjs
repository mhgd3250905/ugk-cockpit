import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openCockpitDatabase } from '../../src/core/database.mjs';
import { createCockpitHttpServer } from '../../src/service/http-server.mjs';
import { VERSION } from '../../src/version.mjs';

const TOKEN = 'phase-zero-test-token-that-is-long-enough';

function createRepository() {
  const container = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-http-'));
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

test('an explicitly open Explorer folder can enter the same confirmation flow', async (t) => {
  const root = createRepository();
  let openFolderCalls = 0;
  const service = await createCockpitHttpServer({
    dbPath: dataPath(root),
    token: TOKEN,
    authorizedRoots: [],
    openFolderPicker: async () => {
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
  const selected = await request(service, '/api/v1/folders/select-open', {
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

test('an open folder without a Git project returns a human recovery action', async (t) => {
  const root = createRepository();
  const service = await createCockpitHttpServer({
    dbPath: dataPath(root),
    token: TOKEN,
    authorizedRoots: [],
    openFolderPicker: async () => root,
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

  await assertUserError(await request(service, '/api/v1/folders/select-open', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: '{}',
  }), 422, 'FOLDER_NOT_CODE_PROJECT');
});

test('an Explorer folder below a junction ancestor cannot receive a grant', async (t) => {
  const root = createRepository();
  const linkContainer = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-http-link-'));
  const ancestorLink = path.join(linkContainer, 'opened-link');
  symlinkSync(path.dirname(root), ancestorLink, process.platform === 'win32' ? 'junction' : 'dir');
  const selectedThroughLink = path.join(ancestorLink, path.basename(root));
  let probeCalls = 0;
  const service = await createCockpitHttpServer({
    dbPath: dataPath(root),
    token: TOKEN,
    authorizedRoots: [],
    openFolderPicker: async () => selectedThroughLink,
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

  await assertUserError(await request(service, '/api/v1/folders/select-open', {
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
