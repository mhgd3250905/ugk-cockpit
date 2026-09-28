// Audit round 2026-09-26, finding 11 (P1, availability of a live agent session).
//
// `POST /api/v1/mcp/session` is the bridge bootstrap and needs no credential, so
// any local process can call it. When the in-memory table reached its cap the
// *first* entry was dropped — insertion order is age, so the session evicted is
// the one that has been running longest: the agent in the middle of a task,
// which never mints again, while the churn that filled the table keeps its brand
// new sessions. Touching an entry on each use turns the eviction into
// least-recently-used.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCockpitHttpServer } from '../src/service/http-server.mjs';

const TOKEN = 'session-eviction-audit-token-'.padEnd(44, 'x');
// Every request closes its own connection: the shared fetch agent would
// otherwise hold a socket to an already closed server and keep the test process
// from draining.
const CONNECTION = { connection: 'close' };

async function mint(baseUrl) {
  const response = await fetch(`${baseUrl}/api/v1/mcp/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...CONNECTION },
    body: JSON.stringify({ client: 'ugk-cockpit-stdio' }),
  });
  assert.equal(response.status, 201, 'the bridge bootstrap route must stay credential-free');
  const body = await response.json();
  assert.ok(body.token);
  return body.token;
}

async function use(baseUrl, token, host) {
  return fetch(`${baseUrl}/api/v1/mcp/work/context`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'x-ugk-conversation': Buffer.from(JSON.stringify({ host, id: 'lru-session' })).toString('base64url'),
      ...CONNECTION,
    },
    body: JSON.stringify({}),
  });
}

test('a session in active use survives a storm of new mints', async (t) => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'ugk-mcp-session-lru-'));
  const service = await createCockpitHttpServer({ dbPath: path.join(fixture, 'cockpit.db'), token: TOKEN });
  t.after(async () => {
    await service.close();
    rmSync(fixture, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });
  const baseUrl = `http://127.0.0.1:${service.port}`;

  const working = await mint(baseUrl);
  assert.notEqual((await use(baseUrl, working, 'lru-host-a')).status, 401,
    'the working session was refused before any churn');

  // Past the cap. A real agent keeps calling the service while other hosts mint
  // and drop sessions around it; eviction by age still throws that session out
  // because it was simply the first one created.
  for (let index = 0; index < 70; index += 1) {
    const churned = await mint(baseUrl);
    assert.notEqual((await use(baseUrl, churned, 'lru-host-b')).status, 401);
    assert.notEqual((await use(baseUrl, working, 'lru-host-a')).status, 401,
      `the working session died after ${index} unrelated mints`);
  }

  assert.notEqual((await use(baseUrl, working, 'lru-host-a')).status, 401,
    'a continuously used session was evicted by newer, idle ones');
});

test('the cap still bounds the table: an idle session can be evicted', async (t) => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'ugk-mcp-session-cap-'));
  const service = await createCockpitHttpServer({ dbPath: path.join(fixture, 'cockpit.db'), token: TOKEN });
  t.after(async () => {
    await service.close();
    rmSync(fixture, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });
  const baseUrl = `http://127.0.0.1:${service.port}`;

  // Least-recently-used is a policy, not a promise of lifetime: a session that
  // stops being used does leave the table once enough live ones arrive.
  const idle = await mint(baseUrl);
  for (let index = 0; index < 70; index += 1) {
    const churned = await mint(baseUrl);
    await use(baseUrl, churned, 'cap-host');
  }
  assert.equal((await use(baseUrl, idle, 'cap-host')).status, 401,
    'the scoped-credential table is no longer bounded');
});
