import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { registerProject } from '../src/core/projects.mjs';
import { probeGitWorktree } from '../src/git/probe.mjs';
import { createCockpitHttpServer } from '../src/service/http-server.mjs';
import { createAssignment, acceptAssignment } from '../src/core/assignments.mjs';
import { startWriteRun } from '../src/core/runs.mjs';

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const TOKEN = 'http-submit-notes-test-token-long-enough';

async function postJson(service, pathname, body, { token = TOKEN, headers = {} } = {}) {
  return fetch(`http://${service.host}:${service.port}${pathname}`, {
    method: 'POST',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function getJson(service, pathname, { token = TOKEN, headers = {} } = {}) {
  return fetch(`http://${service.host}:${service.port}${pathname}`, {
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  });
}

async function createHttpFixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-http-notes-'));
  const project1Dir = path.join(root, 'project1');
  const project2Dir = path.join(root, 'project2');

  for (const dir of [project1Dir, project2Dir]) {
    git(root, ['init', '-b', 'main', dir]);
    git(dir, ['config', 'user.name', 'UGK Test']);
    git(dir, ['config', 'user.email', 'test@example.invalid']);
    writeFileSync(path.join(dir, 'README.md'), `# Project at ${dir}\n`);
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'Initial seed']);
  }

  const dbPath = path.join(root, 'cockpit.db');
  const db = openCockpitDatabase(dbPath);
  const p1Reg = registerProject(db, {
    commandId: 'reg-p1',
    name: 'Project 1',
    authorizedRoot: project1Dir,
    observation: await probeGitWorktree(project1Dir),
  });
  const p2Reg = registerProject(db, {
    commandId: 'reg-p2',
    name: 'Project 2',
    authorizedRoot: project2Dir,
    observation: await probeGitWorktree(project2Dir),
  });
  db.close();

  const service = await createCockpitHttpServer({ dbPath, token: TOKEN });

  t.after(async () => {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  });

  return { root, project1Dir, project2Dir, p1Id: p1Reg.projectId, p2Id: p2Reg.projectId, service, dbPath };
}

test('HTTP MCP submit-note endpoints: create, get, update, idempotency, and conflict handling', async (t) => {
  const { project1Dir, p1Id, service } = await createHttpFixture(t);

  // 1. Create submit note via POST /api/v1/mcp/work/submit-note
  const createPayload = {
    clientRequestId: 'http-note-req-1',
    body: 'First HTTP submit note for code review.',
    title: 'Code Review Notice',
    references: [
      { type: 'commit', target: '3d50efc', commit: '3d50efc' },
      { type: 'pull_request', target: 'https://example.com/pr/99', title: 'Feature PR' },
    ],
    mcpWorkingDirectory: project1Dir,
  };

  const createRes = await postJson(service, '/api/v1/mcp/work/submit-note', createPayload);
  assert.equal(createRes.status, 200);
  const noteData = await createRes.json();
  assert.equal(noteData.ok, true);
  assert.ok(noteData.noteId.startsWith('note_'));
  assert.equal(noteData.status, 'pending');
  assert.equal(noteData.revision, 1);
  assert.equal(noteData.projectId, p1Id);
  assert.ok(noteData.receipt.receiptId);
  assert.match(noteData.copyText, /Code Review Notice/);

  const noteId = noteData.noteId;

  // 2. Idempotent retry of createSubmitNote returns exact same note and receipt
  const retryRes = await postJson(service, '/api/v1/mcp/work/submit-note', createPayload);
  assert.equal(retryRes.status, 200);
  const retryData = await retryRes.json();
  assert.equal(retryData.noteId, noteId);
  assert.equal(retryData.receipt.receiptId, noteData.receipt.receiptId);

  // 3. Replay with different body returns 409 COMMAND_CONFLICT
  const conflictRes = await postJson(service, '/api/v1/mcp/work/submit-note', {
    ...createPayload,
    body: 'Changed body for same clientRequestId',
  });
  assert.equal(conflictRes.status, 409);
  const conflictData = await conflictRes.json();
  assert.equal(conflictData.code, 'COMMAND_CONFLICT');

  // 4. Read submit note via POST /api/v1/mcp/submit-notes/get
  const getRes = await postJson(service, '/api/v1/mcp/submit-notes/get', {
    noteId,
    mcpWorkingDirectory: project1Dir,
  });
  assert.equal(getRes.status, 200);
  const getData = await getRes.json();
  assert.equal(getData.ok, true);
  assert.equal(getData.note.noteId, noteId);
  assert.equal(getData.note.status, 'pending');
  assert.equal(getData.note.revision, 1);
  assert.equal(getData.note.body, 'First HTTP submit note for code review.');
  assert.match(getData.copyText, /建议下一步/);

  // 5. Update submit note via POST /api/v1/mcp/submit-notes/update
  const updatePayload = {
    noteId,
    clientRequestId: 'http-note-update-1',
    expectedRevision: 1,
    status: 'handled',
    handlingNote: 'Checked and approved by project owner.',
    mcpWorkingDirectory: project1Dir,
  };

  const updateRes = await postJson(service, '/api/v1/mcp/submit-notes/update', updatePayload);
  assert.equal(updateRes.status, 200);
  const updateData = await updateRes.json();
  assert.equal(updateData.ok, true);
  assert.equal(updateData.status, 'handled');
  assert.equal(updateData.revision, 2);
  assert.equal(updateData.handlingNote, 'Checked and approved by project owner.');

  // 6. CAS revision mismatch returns 409 NOTE_REVISION_CONFLICT
  const staleUpdateRes = await postJson(service, '/api/v1/mcp/submit-notes/update', {
    ...updatePayload,
    clientRequestId: 'http-note-update-stale',
    expectedRevision: 1,
  });
  assert.equal(staleUpdateRes.status, 409);
  const staleData = await staleUpdateRes.json();
  assert.equal(staleData.code, 'NOTE_REVISION_CONFLICT');

  // 7. Update retry is idempotent
  const retryUpdateRes = await postJson(service, '/api/v1/mcp/submit-notes/update', updatePayload);
  assert.equal(retryUpdateRes.status, 200);
  const retryUpdateData = await retryUpdateRes.json();
  assert.equal(retryUpdateData.revision, 2);
});

test('cross-project reading or updating note is strictly rejected', async (t) => {
  const { project1Dir, project2Dir, service } = await createHttpFixture(t);

  // Create note under project 1
  const createRes = await postJson(service, '/api/v1/mcp/work/submit-note', {
    clientRequestId: 'req-p1-note',
    body: 'Project 1 private note',
    mcpWorkingDirectory: project1Dir,
  });
  assert.equal(createRes.status, 200);
  const { noteId } = await createRes.json();

  // Try to read note from project 2's directory
  const crossGetRes = await postJson(service, '/api/v1/mcp/submit-notes/get', {
    noteId,
    mcpWorkingDirectory: project2Dir,
  });
  assert.equal(crossGetRes.status, 403);
  const crossGetData = await crossGetRes.json();
  assert.equal(crossGetData.code, 'PROJECT_MISMATCH');

  // Try to update note from project 2's directory
  const crossUpdateRes = await postJson(service, '/api/v1/mcp/submit-notes/update', {
    noteId,
    clientRequestId: 'cross-up-1',
    expectedRevision: 1,
    status: 'handled',
    mcpWorkingDirectory: project2Dir,
  });
  assert.equal(crossUpdateRes.status, 403);
  const crossUpdateData = await crossUpdateRes.json();
  assert.equal(crossUpdateData.code, 'PROJECT_MISMATCH');
});

test('browser status endpoint POST /api/v1/submit-notes/:noteId/status enforces browser auth and updates status', async (t) => {
  const { project1Dir, service } = await createHttpFixture(t);

  // Create note under project 1
  const createRes = await postJson(service, '/api/v1/mcp/work/submit-note', {
    clientRequestId: 'browser-fixture-note',
    body: 'Browser status note',
    mcpWorkingDirectory: project1Dir,
  });
  assert.equal(createRes.status, 200);
  const { noteId } = await createRes.json();

  // 1. Call browser endpoint without auth: returns 401
  const unauthRes = await postJson(service, `/api/v1/submit-notes/${noteId}/status`, {
    clientRequestId: 'b-req-unauth',
    expectedRevision: 1,
    status: 'handled',
  }, { token: null });
  assert.equal(unauthRes.status, 401);

  // 2. Call with bearer token: updates status
  const bearerRes = await postJson(service, `/api/v1/submit-notes/${noteId}/status`, {
    clientRequestId: 'b-req-bearer',
    expectedRevision: 1,
    status: 'handled',
    handlingNote: 'Handled via bearer API call',
  });
  assert.equal(bearerRes.status, 200);
  const bearerData = await bearerRes.json();
  assert.equal(bearerData.ok, true);
  assert.equal(bearerData.note.status, 'handled');
  assert.equal(bearerData.note.revision, 2);

  // 3. Browser call with session token, origin and client-id
  // Obtain browser cookie first
  const bootstrapRes = await fetch(`http://${service.host}:${service.port}/`, {
    headers: { 'user-agent': 'Mozilla/5.0' },
  });
  const cookie = bootstrapRes.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);

  // Foreign origin is rejected
  const foreignOriginRes = await fetch(`http://${service.host}:${service.port}/api/v1/submit-notes/${noteId}/status`, {
    method: 'POST',
    headers: {
      cookie,
      origin: 'http://malicious-site.example',
      'sec-fetch-site': 'cross-site',
      'content-type': 'application/json',
      'x-ugk-client-id': 'browser-test-client-1234',
    },
    body: JSON.stringify({
      clientRequestId: 'b-req-browser',
      expectedRevision: 2,
      status: 'archived',
    }),
  });
  assert.equal(foreignOriginRes.status, 403);

  // Valid same-origin browser request succeeds
  const validBrowserRes = await fetch(`http://${service.host}:${service.port}/api/v1/submit-notes/${noteId}/status`, {
    method: 'POST',
    headers: {
      cookie,
      origin: `http://127.0.0.1:${service.port}`,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      'x-ugk-client-id': 'browser-test-client-1234',
    },
    body: JSON.stringify({
      clientRequestId: 'b-req-browser-ok',
      expectedRevision: 2,
      status: 'archived',
      handlingNote: 'Archived from Cockpit web UI',
    }),
  });
  assert.equal(validBrowserRes.status, 200);
  const browserData = await validBrowserRes.json();
  assert.equal(browserData.ok, true);
  assert.equal(browserData.note.status, 'archived');
  assert.equal(browserData.note.revision, 3);
});

test('project detail GET /api/v1/projects/:projectId includes submitNotes alongside submissions', async (t) => {
  const { project1Dir, p1Id, service } = await createHttpFixture(t);

  // Create two submit notes
  await postJson(service, '/api/v1/mcp/work/submit-note', {
    clientRequestId: 'detail-note-1',
    body: 'Detail note 1',
    mcpWorkingDirectory: project1Dir,
  });
  await postJson(service, '/api/v1/mcp/work/submit-note', {
    clientRequestId: 'detail-note-2',
    body: 'Detail note 2',
    mcpWorkingDirectory: project1Dir,
  });

  const detailRes = await getJson(service, `/api/v1/projects/${p1Id}`);
  assert.equal(detailRes.status, 200);
  const detailData = await detailRes.json();
  assert.equal(detailData.ok, true);

  // Both submissions and submitNotes exist in response
  assert.ok(Array.isArray(detailData.submissions));
  assert.ok(Array.isArray(detailData.submitNotes));
  assert.equal(detailData.submitNotes.length, 2);
  assert.equal(detailData.submitNotes[0].body, 'Detail note 2');
  assert.equal(detailData.submitNotes[1].body, 'Detail note 1');
});

test('old integration endpoint rejects noteId with SUBMISSION_NOT_FOUND', async (t) => {
  const { project1Dir, p1Id, dbPath, service } = await createHttpFixture(t);

  const createRes = await postJson(service, '/api/v1/mcp/work/submit-note', {
    clientRequestId: 'note-not-submission-1',
    body: 'A note that is not a code submission',
    mcpWorkingDirectory: project1Dir,
  });
  const { noteId } = await createRes.json();

  const db = openCockpitDatabase(dbPath);
  const createdAssignment = createAssignment(db, {
    commandId: 'create-active-assignment',
    assignmentId: 'assign-active-integration',
    projectId: p1Id,
    agentId: 'integration-agent',
    taskId: 'Integration task',
    scope: { mode: 'write' },
    dispatchCode: 'dispatch-integration-code',
  });
  const accepted = acceptAssignment(db, {
    dispatchCode: createdAssignment.dispatchCode,
    clientRequestId: 'accept-req-integration',
    sessionId: 'session-integration-1',
  });
  assert.equal(accepted.ok, true);
  db.prepare("UPDATE assignments SET status = 'active', revision = 2 WHERE session_id = ?").run('session-integration-1');

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(p1Id);
  const wt = db.prepare('SELECT * FROM worktrees WHERE id = ?').get(project.worktree_id);
  const startRes = startWriteRun(db, {
    commandId: 'start-run-int',
    runId: 'session-integration-1',
    sessionId: 'session-integration-1',
    expectedRevision: 1,
    worktreeId: project.worktree_id,
    canonicalPath: wt.canonical_path,
    repositoryIdentity: wt.repository_identity,
    worktreeIdentity: wt.identity_fingerprint,
    agentClaim: 'integration-agent',
    goal: 'Integration task',
    baseline: { head: 'seed', branch: 'main', dirtyFiles: [] },
  });
  assert.equal(startRes.ok, true);
  db.close();

  // Try to use noteId as submissionId in ugk_integration_begin
  const beginRes = await postJson(service, '/api/v1/mcp/integration/begin', {
    sessionId: 'session-integration-1',
    clientRequestId: 'integration-begin-req',
    expectedRevision: 2,
    submissionId: noteId,
    expectedSubmissionRevision: 0,
  });
  assert.notEqual(beginRes.status, 200);
  const beginData = await beginRes.json();
  assert.equal(beginData.code, 'SUBMISSION_NOT_FOUND');
});

test('pagination endpoint GET /api/v1/projects/:projectId/submit-notes returns counts, total, hasMore, and status filter', async (t) => {
  const { project1Dir, p1Id, service, dbPath } = await createHttpFixture(t);

  // Directly seed 31 archived notes and 1 pending note into db
  const db = openCockpitDatabase(dbPath);
  const now = new Date().toISOString();
  const sourceSnapshot = JSON.stringify({
    projectId: p1Id,
    projectName: 'Project 1',
    canonicalPath: project1Dir,
  });

  for (let i = 1; i <= 31; i += 1) {
    db.prepare(`
      INSERT INTO submit_notes (
        id, project_id, command_id, title, body, status, revision,
        source_json, references_json, handling_note, created_at, updated_at, archived_at
      ) VALUES (?, ?, NULL, ?, ?, 'archived', 1, ?, '[]', '', ?, ?, ?)
    `).run(
      `note-archived-${i}`,
      p1Id,
      `Archived note ${i}`,
      `Body ${i}`,
      sourceSnapshot,
      now,
      now,
      now,
    );
  }

  db.prepare(`
    INSERT INTO submit_notes (
      id, project_id, command_id, title, body, status, revision,
      source_json, references_json, handling_note, created_at, updated_at
    ) VALUES (?, ?, NULL, ?, ?, 'pending', 1, ?, '[]', '', ?, ?)
  `).run(
    'note-pending-single',
    p1Id,
    'Pending single note',
    'Pending body',
    sourceSnapshot,
    now,
    now,
  );
  db.close();

  // 1. Query with ?status=pending only pulls the 1 matching item
  const pendingRes = await getJson(service, `/api/v1/projects/${p1Id}/submit-notes?status=pending`);
  assert.equal(pendingRes.status, 200);
  const pendingData = await pendingRes.json();
  assert.equal(pendingData.ok, true);
  assert.equal(pendingData.items.length, 1);
  assert.equal(pendingData.items[0].noteId, 'note-pending-single');
  assert.equal(pendingData.total, 1);
  assert.equal(pendingData.hasMore, false);
  assert.deepEqual(pendingData.counts, { pending: 1, handled: 0, archived: 31 });

  // 2. Query all without status pulls first page (default limit 30)
  const allRes = await getJson(service, `/api/v1/projects/${p1Id}/submit-notes`);
  assert.equal(allRes.status, 200);
  const allData = await allRes.json();
  assert.equal(allData.ok, true);
  assert.equal(allData.items.length, 30);
  assert.equal(allData.total, 32);
  assert.equal(allData.hasMore, true);
  assert.deepEqual(allData.counts, { pending: 1, handled: 0, archived: 31 });

  // 3. Query second page (limit 30, offset 30) pulls remaining 2
  const page2Res = await getJson(service, `/api/v1/projects/${p1Id}/submit-notes?limit=30&offset=30`);
  assert.equal(page2Res.status, 200);
  const page2Data = await page2Res.json();
  assert.equal(page2Data.items.length, 2);
  assert.equal(page2Data.hasMore, false);

  // 4. Project detail endpoint submitNotes is decoupled from timeline query params
  const detailRes = await getJson(service, `/api/v1/projects/${p1Id}?limit=1&offset=5`);
  assert.equal(detailRes.status, 200);
  const detailData = await detailRes.json();
  assert.equal(detailData.submitNotes.length, 30); // fixed default page, not 1
});

test('strict HTTP field validation rejects unknown properties with 400 INVALID_REQUEST', async (t) => {
  const { project1Dir, service } = await createHttpFixture(t);

  // Unknown property on submit-note creation
  const res1 = await postJson(service, '/api/v1/mcp/work/submit-note', {
    clientRequestId: 'strict-req-1',
    body: 'Valid body',
    mcpWorkingDirectory: project1Dir,
    skipPathCheck: true,
  });
  assert.equal(res1.status, 400);
  const d1 = await res1.json();
  assert.equal(d1.code, 'INVALID_REQUEST');

  // Unknown property on submit-notes get
  const res2 = await postJson(service, '/api/v1/mcp/submit-notes/get', {
    noteId: 'some-note',
    mcpWorkingDirectory: project1Dir,
    unknownField: 'bad',
  });
  assert.equal(res2.status, 400);
  const d2 = await res2.json();
  assert.equal(d2.code, 'INVALID_REQUEST');

  // Unknown property on submit-notes update
  const res3 = await postJson(service, '/api/v1/mcp/submit-notes/update', {
    noteId: 'some-note',
    clientRequestId: 'up-1',
    expectedRevision: 1,
    status: 'handled',
    skipPathCheck: true,
    mcpWorkingDirectory: project1Dir,
  });
  assert.equal(res3.status, 400);
  const d3 = await res3.json();
  assert.equal(d3.code, 'INVALID_REQUEST');
});
