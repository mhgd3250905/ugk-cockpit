import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { createCockpitHttpServer } from '../src/service/http-server.mjs';
import { VERSION } from '../src/version.mjs';

async function fixture(t, options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-service-lifecycle-'));
  const dbPath = path.join(root, 'fixture.db');
  const token = 'service-lifecycle-fixture-token-12345678';
  const service = await createCockpitHttpServer({
    dbPath, token,
    serveWebAsset: async ({ pathname, response, sessionToken }) => {
      if (pathname !== '/') return false;
      response.setHeader('set-cookie', `ugk_cockpit_session=${sessionToken}; HttpOnly; SameSite=Strict`);
      response.end('fixture');
      return true;
    },
    ...options,
  });
  t.after(async () => {
    await service.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('ugk-service-lifecycle-'));
    rmSync(root, { recursive: true, force: true });
  });
  const base = `http://${service.host}:${service.port}`;
  const shell = await fetch(`${base}/`);
  await shell.text();
  const headers = {
    cookie: shell.headers.get('set-cookie'), origin: base,
    'sec-fetch-site': 'same-origin', 'content-type': 'application/json',
    'x-ugk-client-id': 'service-lifecycle-browser',
  };
  const post = (route, body, extra = {}) => fetch(`${base}${route}`, {
    method: 'POST', headers, body: JSON.stringify(body), ...extra,
  });
  return { root, dbPath, token, service, base, headers, post };
}

test('service status is readable and shutdown requires same-origin browser confirmation', async (t) => {
  const f = await fixture(t);
  const status = await fetch(`${f.base}/api/v1/service/status`, { headers: f.headers });
  const information = await status.json();
  assert.equal(status.status, 200);
  assert.equal(information.ok, true);
  assert.equal(information.version, VERSION);
  assert.equal(information.status, 'running');
  assert.ok(Number.isFinite(Date.parse(information.startedAt)));
  assert.ok(Number.isInteger(information.uptimeSeconds) && information.uptimeSeconds >= 0);
  const route = '/api/v1/service/shutdown';
  assert.equal((await f.post(route, {})).status, 400);
  assert.equal((await f.post(route, { userConfirmed: false })).status, 400);
  assert.equal((await f.post(route, { userConfirmed: true, path: 'ignored' })).status, 400);
  assert.equal((await f.post(route, { userConfirmed: true }, {
    headers: { ...f.headers, origin: 'http://example.invalid' },
  })).status, 403);
  assert.equal((await f.post(route, { userConfirmed: true }, {
    headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/json' },
  })).status, 401);
  const bootstrap = await f.post('/api/v1/mcp/session', { client: 'ugk-cockpit-stdio' }, {
    headers: { 'content-type': 'application/json' },
  });
  const scoped = await bootstrap.json();
  assert.equal((await f.post(route, { userConfirmed: true }, {
    headers: { authorization: `Bearer ${scoped.token}`, 'content-type': 'application/json' },
  })).status, 401);
  const shutdown = await f.post(route, { userConfirmed: true });
  assert.equal(shutdown.status, 202);
  assert.deepEqual(await shutdown.json(), { ok: true, status: 'stopping' });
  await f.service.close();
  await assert.rejects(fetch(`${f.base}/health`));
});

test('shutdown drains a disconnected write handler before closing its database', async (t) => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const f = await fixture(t, { folderPicker: async () => { started.resolve(); return release.promise; } });
  const selected = path.join(f.root, 'empty');
  mkdirSync(selected);
  const abort = new AbortController();
  const selection = f.post('/api/v1/folders/select-empty', {}, { signal: abort.signal }).catch(() => {});
  await started.promise;
  abort.abort();
  await selection;
  const shutdown = await f.post('/api/v1/service/shutdown', { userConfirmed: true });
  assert.equal(shutdown.status, 202);
  await shutdown.json();
  let closed = false;
  const closing = f.service.close().then(() => { closed = true; });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
  } finally {
    release.resolve(selected);
  }
  await closing;
  const db = openCockpitDatabase(f.dbPath);
  try {
    assert.equal(db.prepare('SELECT count(*) AS n FROM empty_folder_grants').get().n, 1);
  } finally { db.close(); }
});
