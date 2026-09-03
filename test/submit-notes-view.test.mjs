import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { renderSafeTextWithLinks, buildNoteStatusRequest, requireNoteStatusReceipt, noteActionError } from '../web/src/submit-notes-view.mjs';
import { SUBMIT_MESSAGE, noteStatusLabel } from '../web/src/delivery-view.mjs';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { registerProject } from '../src/core/projects.mjs';
import { probeGitWorktree } from '../src/git/probe.mjs';
import { createCockpitHttpServer } from '../src/service/http-server.mjs';
import { readProjectTimeline } from '../src/core/timeline.mjs';

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const TOKEN = 'submit-notes-view-test-token-48characters';

test('UI retry preserves the exact original payload after polling or draft edits', () => {
  const original = buildNoteStatusRequest({ revision: 2 }, 'handled', undefined);
  assert.equal(Object.hasOwn(original, 'handlingNote'), false);
  assert.equal(buildNoteStatusRequest({ revision: 99 }, 'archived', 'new draft', original), original);
  assert.equal(original.expectedRevision, 2);
  assert.equal(original.status, 'handled');
  assert.equal(buildNoteStatusRequest({ revision: 2 }, 'handled', '').handlingNote, '');
});

test('UI malformed or uncertain responses do not become success or claim no write', () => {
  for (const result of [undefined, {}, { ok: true }, { ok: false }, { ok: true, note: { noteId: 'other', revision: 2 } }]) {
    assert.throws(() => requireNoteStatusReceipt(result, 'note'), { code: 'SERVICE_UNAVAILABLE' });
  }
  assert.equal(requireNoteStatusReceipt({ ok: true, note: { noteId: 'note', revision: 2 } }, 'note').revision, 2);
  const uncertain = noteActionError(new SyntaxError('Truncated JSON'), 'handled');
  assert.equal(uncertain.retryable, true);
  assert.doesNotMatch(uncertain.impact, /未被修改|没有更新/);
  const conflict = noteActionError({ code: 'NOTE_REVISION_CONFLICT' }, 'handled');
  assert.equal(conflict.retryable, false);
  assert.match(conflict.required_action, /核对最新状态/);
});

async function postJson(service, pathname, body, { token = TOKEN } = {}) {
  return fetch(`http://${service.host}:${service.port}${pathname}`, {
    method: 'POST',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function getJson(service, pathname, { token = TOKEN } = {}) {
  return fetch(`http://${service.host}:${service.port}${pathname}`, {
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}

async function createFixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-view-notes-'));
  const projectDir = path.join(root, 'project');

  git(root, ['init', '-b', 'main', projectDir]);
  git(projectDir, ['config', 'user.name', 'UGK Test']);
  git(projectDir, ['config', 'user.email', 'test@example.invalid']);
  writeFileSync(path.join(projectDir, 'README.md'), '# Project\n');
  git(projectDir, ['add', '.']);
  git(projectDir, ['commit', '-m', 'Initial seed']);

  const dbPath = path.join(root, 'cockpit.db');
  const db = openCockpitDatabase(dbPath);
  const reg = registerProject(db, {
    commandId: 'reg-view-proj',
    name: 'View Project',
    authorizedRoot: projectDir,
    observation: await probeGitWorktree(projectDir),
  });
  db.close();

  const service = await createCockpitHttpServer({ dbPath, token: TOKEN });

  t.after(async () => {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  });

  return { root, projectDir, projectId: reg.projectId, service, dbPath };
}

test('SUBMIT_MESSAGE reflects publishing work note without assuming task finished or mandatory preflight', () => {
  assert.match(SUBMIT_MESSAGE, /\$cockpit-submit/);
  assert.match(SUBMIT_MESSAGE, /工作说明/);
  assert.match(SUBMIT_MESSAGE, /不需要假设任务已完成|不假设任务已完成/);
  assert.match(SUBMIT_MESSAGE, /不默认执行保存、上传或预检|不默认/);
  assert.doesNotMatch(SUBMIT_MESSAGE, /本次分支任务已完成/);
  assert.doesNotMatch(SUBMIT_MESSAGE, /先通过 MCP 核对平台项目.*最新 main 的合并关系，再保存并上传/);
});

test('noteStatusLabel maps statuses to project owner friendly Chinese terms', () => {
  assert.equal(noteStatusLabel('pending'), '待处理');
  assert.equal(noteStatusLabel('handled'), '已处理');
  assert.equal(noteStatusLabel('archived'), '已归档');
  assert.equal(noteStatusLabel('unknown'), 'unknown');
});

test('renderSafeTextWithLinks only turns http and https into links, keeping all else as plain text', () => {
  const textWithLinks = '请参阅 https://github.com/example/pr/123 以及 http://localhost:8080/report ，不要执行 javascript:alert(1) 或 file:///etc/passwd';
  const nodes = renderSafeTextWithLinks(textWithLinks);
  assert.ok(Array.isArray(nodes));

  // Find link nodes
  const links = nodes.filter((n) => n && typeof n === 'object' && n.type === 'a');
  assert.equal(links.length, 2);
  assert.equal(links[0].props.href, 'https://github.com/example/pr/123');
  assert.equal(links[0].props.target, '_blank');
  assert.equal(links[0].props.rel, 'noopener noreferrer');
  assert.equal(links[1].props.href, 'http://localhost:8080/report');

  // Ensure javascript: and file:/// were NOT turned into links
  const dangerousLinks = nodes.filter(
    (n) => n && typeof n === 'object' && n.type === 'a' && !/^https?:\/\//.test(n.props.href)
  );
  assert.equal(dangerousLinks.length, 0);

  // Pure text without links returns single text string
  const plain = renderSafeTextWithLinks('普通文本内容无任何超链接');
  assert.deepEqual(plain, ['普通文本内容无任何超链接']);

  // Non-string input returns null
  assert.equal(renderSafeTextWithLinks(null), null);
  assert.equal(renderSafeTextWithLinks(undefined), null);
});

test('submit notes inbox endpoint supports independent pagination and status filtering', async (t) => {
  const { projectDir, projectId, service } = await createFixture(t);

  // Create 4 notes
  for (let i = 1; i <= 4; i += 1) {
    const res = await postJson(service, '/api/v1/mcp/work/submit-note', {
      clientRequestId: `req-inbox-note-${i}`,
      title: `Note ${i}`,
      body: `Body for note ${i}`,
      mcpWorkingDirectory: projectDir,
    });
    assert.equal(res.status, 200);
  }

  // 1. Initial pending list has 4 notes
  const pendingRes = await getJson(service, `/api/v1/projects/${projectId}/submit-notes?status=pending&limit=30&offset=0`);
  assert.equal(pendingRes.status, 200);
  const pendingData = await pendingRes.json();
  assert.equal(pendingData.ok, true);
  assert.equal(pendingData.total, 4);
  assert.equal(pendingData.items.length, 4);
  assert.equal(pendingData.counts.pending, 4);
  assert.equal(pendingData.counts.handled, 0);
  assert.equal(pendingData.counts.archived, 0);

  // 2. Pagination: limit=2, offset=0 returns 2 items with hasMore=true
  const page1Res = await getJson(service, `/api/v1/projects/${projectId}/submit-notes?status=pending&limit=2&offset=0`);
  const page1 = await page1Res.json();
  assert.equal(page1.items.length, 2);
  assert.equal(page1.hasMore, true);
  assert.equal(page1.total, 4);

  // Pagination: limit=2, offset=2 returns remaining 2 items with hasMore=false
  const page2Res = await getJson(service, `/api/v1/projects/${projectId}/submit-notes?status=pending&limit=2&offset=2`);
  const page2 = await page2Res.json();
  assert.equal(page2.items.length, 2);
  assert.equal(page2.hasMore, false);
  assert.equal(page2.total, 4);
  assert.notEqual(page1.items[0].noteId, page2.items[0].noteId);

  // 3. Mark note 1 as handled via POST /api/v1/submit-notes/:noteId/status
  const note1 = pendingData.items[3]; // oldest note (Note 1)
  const handleRes = await postJson(service, `/api/v1/submit-notes/${note1.noteId}/status`, {
    clientRequestId: 'status-req-1',
    expectedRevision: note1.revision,
    status: 'handled',
    handlingNote: '已由项目负责人核对',
  });
  assert.equal(handleRes.status, 200);
  const handleData = await handleRes.json();
  assert.equal(handleData.ok, true);
  assert.equal(handleData.note.status, 'handled');
  assert.equal(handleData.note.revision, 2);
  assert.equal(handleData.note.handlingNote, '已由项目负责人核对');

  // Check counts: pending=3, handled=1, archived=0
  const afterHandleRes = await getJson(service, `/api/v1/projects/${projectId}/submit-notes?status=pending&limit=30&offset=0`);
  const afterHandleData = await afterHandleRes.json();
  assert.equal(afterHandleData.counts.pending, 3);
  assert.equal(afterHandleData.counts.handled, 1);
  assert.equal(afterHandleData.counts.archived, 0);

  // 4. Archive note 2
  const note2 = pendingData.items[2];
  const archiveRes = await postJson(service, `/api/v1/submit-notes/${note2.noteId}/status`, {
    clientRequestId: 'status-req-2',
    expectedRevision: note2.revision,
    status: 'archived',
  });
  assert.equal(archiveRes.status, 200);

  // Check counts: pending=2, handled=1, archived=1
  const afterArchiveRes = await getJson(service, `/api/v1/projects/${projectId}/submit-notes?status=handled&limit=30&offset=0`);
  const afterArchiveData = await afterArchiveRes.json();
  assert.equal(afterArchiveData.counts.pending, 2);
  assert.equal(afterArchiveData.counts.handled, 1);
  assert.equal(afterArchiveData.counts.archived, 1);
  assert.equal(afterArchiveData.items.length, 1);
  assert.equal(afterArchiveData.items[0].noteId, note1.noteId);

  // 5. Restore handled note 1 back to pending
  const restoreRes = await postJson(service, `/api/v1/submit-notes/${note1.noteId}/status`, {
    clientRequestId: 'status-req-restore',
    expectedRevision: 2,
    status: 'pending',
  });
  assert.equal(restoreRes.status, 200);
  const restoreData = await restoreRes.json();
  assert.equal(restoreData.note.status, 'pending');
  assert.equal(restoreData.note.revision, 3);

  // 6. CAS revision conflict gives 409 NOTE_REVISION_CONFLICT
  const staleRes = await postJson(service, `/api/v1/submit-notes/${note1.noteId}/status`, {
    clientRequestId: 'status-req-stale',
    expectedRevision: 2, // stale, current is 3
    status: 'handled',
  });
  assert.equal(staleRes.status, 409);
  const staleData = await staleRes.json();
  assert.equal(staleData.code, 'NOTE_REVISION_CONFLICT');
  assert.equal(staleData.currentRevision, 3);

  // 7. Idempotent retry with same clientRequestId and payload succeeds with exact same revision
  const retryRes = await postJson(service, `/api/v1/submit-notes/${note1.noteId}/status`, {
    clientRequestId: 'status-req-restore',
    expectedRevision: 2,
    status: 'pending',
  });
  assert.equal(retryRes.status, 200);
  const retryData = await retryRes.json();
  assert.equal(retryData.note.revision, 3);
});

test('timeline includes submit_note with fixed createdAt and origin lane without integration merge arrow', async (t) => {
  const { projectDir, projectId, dbPath, service } = await createFixture(t);

  // Create a note via MCP
  const createRes = await postJson(service, '/api/v1/mcp/work/submit-note', {
    clientRequestId: 'timeline-note-req',
    title: '工作说明时间线测试',
    body: '正文说明：本次验证时间线节点不会产生伪合流。',
    mcpWorkingDirectory: projectDir,
  });
  assert.equal(createRes.status, 200);
  const { noteId } = await createRes.json();

  const db = openCockpitDatabase(dbPath);
  const timelineBefore = readProjectTimeline(db, projectId, { limit: 50, offset: 0 });
  const noteEvent = timelineBefore.items.find((item) => item.id === noteId);
  assert.ok(noteEvent);
  assert.equal(noteEvent.kind, 'submit_note');
  assert.equal(noteEvent.typeLabel, '工作说明');
  assert.equal(noteEvent.status, 'pending');
  assert.ok(noteEvent.timestamp);
  const originalTimestamp = noteEvent.timestamp;
  // Verify NO integration arrows
  assert.equal(noteEvent.integratedCommit, undefined);
  assert.equal(noteEvent.sourceLaneKey, undefined);

  // Update status to handled
  await postJson(service, `/api/v1/submit-notes/${noteId}/status`, {
    clientRequestId: 'up-timeline-1',
    expectedRevision: 1,
    status: 'handled',
    handlingNote: '已核验',
  });

  const timelineAfter = readProjectTimeline(db, projectId, { limit: 50, offset: 0 });
  const noteEventAfter = timelineAfter.items.find((item) => item.id === noteId);
  assert.ok(noteEventAfter);
  // Timestamp does NOT move
  assert.equal(noteEventAfter.timestamp, originalTimestamp);
  assert.equal(noteEventAfter.revision, noteEvent.revision);
  assert.equal(noteEventAfter.status, 'handled');
  assert.equal(noteEventAfter.handlingNote, '已核验');
  // Does not duplicate
  assert.equal(timelineAfter.items.filter((item) => item.id === noteId).length, 1);

  db.close();
});
