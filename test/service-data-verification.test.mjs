import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { verifyServiceData } from '../scripts/verify-service-data.mjs';

test('startup rejects an empty service over existing data and verifies project details', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-startup-data-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(root, 'cockpit.db'));
  db.exec("CREATE TABLE projects (id TEXT); INSERT INTO projects VALUES ('existing');");
  db.close();
  let projects = [];
  let detailOk = true;
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/') {
      response.setHeader('set-cookie', 'session=test; HttpOnly');
      return response.end('{}');
    }
    assert.equal(request.headers.cookie, 'session=test');
    if (request.url === '/api/v1/dashboard') return response.end(JSON.stringify({ ok: true, projects }));
    response.statusCode = detailOk ? 200 : 500;
    response.end(JSON.stringify({ ok: detailOk }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/`;
  await assert.rejects(verifyServiceData(root, url), /Database\/service project mismatch/);
  projects = [{ id: 'existing' }];
  assert.equal(await verifyServiceData(root, url), 1);
  detailOk = false;
  await assert.rejects(verifyServiceData(root, url), /Project detail failed/);
});
