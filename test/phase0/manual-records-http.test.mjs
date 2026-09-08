import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCockpitDatabase } from '../../src/core/database.mjs';
import { createDevelopmentSpace } from '../../src/core/spaces.mjs';
import { createCockpitHttpServer } from '../../src/service/http-server.mjs';

test('HTTP manual records survive service reconstruction and leave work files intact', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-manual-http-'));
  const dbPath = path.join(root, 'fixture.db');
  const workPath = path.join(root, 'feature');
  mkdirSync(workPath);
  const marker = path.join(workPath, 'pending.txt');
  writeFileSync(marker, 'uncommitted user work');
  let db = openCockpitDatabase(dbPath);
  let service;
  t.after(async () => {
    db?.close();
    await service?.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('ugk-manual-http-'));
    rmSync(root, { recursive: true, force: true });
  });
  const at = '2026-09-08T00:00:00.000Z';
  for (const id of ['main', 'feature']) {
    db.prepare('INSERT INTO worktrees (id, canonical_path, repository_identity, identity_fingerprint, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, path.join(root, id), 'repo-fixture', `identity-${id}`, at);
  }
  db.prepare(`INSERT INTO projects (id, name, stage, worktree_id, repository_identity, status, status_reason, last_observed_at, created_at, updated_at)
    VALUES ('project-fixture', 'Manual records', 'development', 'main', 'repo-fixture', 'ready', 'ready', ?, ?, ?)`).run(at, at, at);
  const space = createDevelopmentSpace(db, {
    commandId: 'fixture-space', projectId: 'project-fixture', worktreeId: 'feature',
    name: 'Feature', branch: 'feature', baseCommit: 'a'.repeat(40),
  });
  assert.equal(space.ok, true, JSON.stringify(space));
  db.close();
  db = null;

  const token = 'manual-records-fixture-token-for-http-only';
  const options = { dbPath, token, authorizedRoots: [root], probe: async () => { throw new Error('manual records must not probe code'); } };
  service = await createCockpitHttpServer(options);
  async function request(url, body) {
    const response = await fetch(`http://${service.host}:${service.port}${url}`, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  }
  const projectUrl = '/api/v1/projects/project-fixture';
  const stateUrl = `${projectUrl}/work-lines/feature/state`;
  const close = { commandId: 'close-fixture', expectedRevision: 0, closed: true };
  assert.equal((await request(stateUrl, close)).status, 200);
  assert.equal((await request(stateUrl, close)).status, 200);
  assert.equal((await request(stateUrl, { ...close, commandId: 'stale-close' })).status, 409);
  assert.equal((await request(stateUrl, { ...close, commandId: 'path-injection', path: workPath })).status, 400);
  assert.equal((await request(`${projectUrl}/archive`, {
    commandId: 'archive-fixture', expectedRevision: 0, archived: true,
  })).status, 200);
  const archived = (await request('/api/v1/dashboard')).body;
  assert.equal(archived.projects.length, 0);
  assert.equal(archived.archivedProjects.length, 1);
  assert.ok(archived.archivedProjects[0].archivedAt);

  await service.close();
  service = await createCockpitHttpServer(options);
  const detail = (await request(projectUrl)).body;
  assert.ok(detail.project.archivedAt);
  assert.equal(detail.workLineStates.find((line) => line.worktreeId === 'feature').status, 'closed');
  assert.equal(detail.timeline.items.filter((item) => item.kind === 'work_line_closed').length, 1);
  assert.equal(detail.workLineContexts.find((line) => line.worktreeId === 'feature').currentAgent, null);
  assert.equal(readFileSync(marker, 'utf8'), 'uncommitted user work');

  assert.equal((await request(stateUrl, { commandId: 'reopen-fixture', expectedRevision: 1, closed: false })).status, 200);
  assert.equal((await request(`${projectUrl}/archive`, { commandId: 'restore-fixture', expectedRevision: 1, archived: false })).status, 200);
  const restored = (await request('/api/v1/dashboard')).body;
  assert.equal(restored.projects.length, 1);
  assert.equal(restored.archivedProjects.length, 0);
  const reopened = (await request(projectUrl)).body;
  assert.equal(reopened.workLineStates.find((line) => line.worktreeId === 'feature').status, 'open');
  assert.equal(reopened.timeline.items.filter((item) => item.kind === 'work_line_reopened').length, 1);
  assert.equal(readFileSync(marker, 'utf8'), 'uncommitted user work');
});
