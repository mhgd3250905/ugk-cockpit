import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
