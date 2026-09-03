import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { createDevelopmentSpace } from '../src/core/spaces.mjs';
import { readProjectTimeline } from '../src/core/timeline.mjs';

const projectId = 'proj-work-lines';
const mainWorktreeId = 'wt-work-lines-main';
const spaceAWorktreeId = 'wt-work-lines-a';
const spaceBWorktreeId = 'wt-work-lines-b';
const unknownWorktreeId = 'wt-work-lines-unknown';

function insertWorktree(db, id, at) {
  db.prepare(`
    INSERT INTO worktrees (
      id, canonical_path, repository_identity, identity_fingerprint, created_at
    ) VALUES (?, ?, 'repo-work-lines', ?, ?)
  `).run(id, `E:\\work-lines\\${id}`, `fp-${id}`, at);
}

function insertAssignment(db, id, worktreeId, agentId, taskId, createdAt) {
  db.prepare(`
    INSERT INTO assignments (
      id, project_id, worktree_id, agent_id, task_id, scope_json,
      status, revision, session_id, accepted_grant_id, accepted_at,
      last_heartbeat_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, '{}', 'active', 1, ?, NULL, ?, NULL, ?, ?)
  `).run(id, projectId, worktreeId, agentId, taskId, `session-${id}`, createdAt, createdAt, createdAt);
}

function insertProgress(db, id, assignmentId, sessionId, revision, summary, branch, createdAt) {
  db.prepare(`
    INSERT INTO progress_events (
      id, assignment_id, session_id, client_request_id,
      expected_revision, revision, status, note, summary, details_json,
      git_head, git_branch, git_coherence, git_observed_at, created_at
    ) VALUES (?, ?, ?, ?, 1, ?, 'working', ?, ?, '[]', ?, ?, 'coherent', ?, ?)
  `).run(
    id,
    assignmentId,
    sessionId,
    `request-${id}`,
    revision,
    summary,
    summary,
    `${id}-head-1234567890`,
    branch,
    createdAt,
    createdAt,
  );
}

function insertRelay(db, createdAt) {
  db.prepare(`
    INSERT INTO relays (
      id, sequence, assignment_id, project_id, worktree_id,
      session_id, run_id, client_request_id, expected_revision, revision,
      next_session_focus, summary, current_state,
      completed_items, pending_items, decisions, artifact_refs, risks,
      suggested_skills, git_head, git_branch, git_coherence, git_observed_at,
      code_hash, state, expires_at, created_at
    ) VALUES (
      'relay-main-work-lines', 1, 'assign-main-work-lines', ?, ?,
      'session-assign-main-work-lines', NULL, 'request-relay-main', 1, 2,
      '继续主项目工作', '主项目中途接力', '主项目仍在工作',
      '[]', '[]', '[]', '[]', '[]', '[]',
      'main-head-1234567890', 'main', 'coherent', ?,
      'relay-code-work-lines', 'active', 4102444800000, ?
    )
  `).run(projectId, mainWorktreeId, createdAt, createdAt);
}

function insertSubmissionAndReceipt(db, {
  submissionId,
  sourceWorktreeId,
  sourceBranch,
  status,
  receiptId,
  outcome,
  integratedCommit,
  createdAt,
}) {
  db.prepare(`
    INSERT INTO submissions (
      id, project_id, space_id, source_worktree_id, target_worktree_id,
      source_branch, source_commit, target_branch, target_head,
      status, status_reason, revision, title, description,
      created_at, updated_at, closed_at, delivery_json, delivery_version
    ) VALUES (?, ?, (SELECT id FROM development_spaces WHERE worktree_id = ?), ?, ?,
      ?, ?, 'main', ?, ?, 'fixture', 1, ?, ?, ?, ?, ?, '{}', 1)
  `).run(
    submissionId,
    projectId,
    sourceWorktreeId,
    sourceWorktreeId,
    mainWorktreeId,
    sourceBranch,
    `${submissionId}-source-commit`,
    `${submissionId}-target-head`,
    status,
    `${submissionId} title`,
    `${submissionId} description`,
    createdAt,
    createdAt,
    status === 'integrated' ? createdAt : null,
  );

  db.prepare(`
    INSERT INTO integration_receipts (
      id, submission_id, claim_id, project_id, space_id,
      source_commit, target_head, integrated_commit, outcome,
      summary, payload_json, created_at
    ) VALUES (?, ?, NULL, ?, (SELECT id FROM development_spaces WHERE worktree_id = ?),
      ?, ?, ?, ?, ?, '{}', ?)
  `).run(
    receiptId,
    submissionId,
    projectId,
    sourceWorktreeId,
    `${submissionId}-source-commit`,
    `${submissionId}-target-head`,
    integratedCommit,
    outcome,
    `${submissionId} receipt`,
    createdAt,
  );
}

function fixture(t) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-work-lines-'));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const db = openCockpitDatabase(path.join(tempDir, 'cockpit.db'));
  const at = '2026-09-03T00:00:00.000Z';

  insertWorktree(db, mainWorktreeId, at);
  insertWorktree(db, spaceAWorktreeId, at);
  insertWorktree(db, spaceBWorktreeId, at);
  insertWorktree(db, unknownWorktreeId, at);
  db.prepare(`
    INSERT INTO projects (
      id, name, stage, worktree_id, status, status_reason,
      last_observed_at, created_at, updated_at, repository_identity, authorized_root
    ) VALUES (?, 'Work line fixture', 'development', ?, 'ready', 'ready_to_start', ?, ?, ?, 'repo-work-lines', 'E:\\work-lines')
  `).run(projectId, mainWorktreeId, at, at, at);

  createDevelopmentSpace(db, {
    projectId,
    name: '同名工作线 A',
    branch: 'feature/shared',
    baseCommit: 'base-a-1234567890',
    worktreeId: spaceAWorktreeId,
    spaceId: 'space-work-lines-a',
  }, { clock: () => Date.parse('2026-09-03T00:01:00.000Z') });
  createDevelopmentSpace(db, {
    projectId,
    name: '同名工作线 B',
    branch: 'feature/shared',
    baseCommit: 'base-b-1234567890',
    worktreeId: spaceBWorktreeId,
    spaceId: 'space-work-lines-b',
  }, { clock: () => Date.parse('2026-09-03T00:02:00.000Z') });

  insertAssignment(db, 'assign-main-work-lines', mainWorktreeId, 'agent-main', '主项目任务', '2026-09-03T00:03:00.000Z');
  insertAssignment(db, 'assign-space-a', spaceAWorktreeId, 'agent-a', '副本 A 任务', '2026-09-03T00:04:00.000Z');
  insertAssignment(db, 'assign-space-b', spaceBWorktreeId, 'agent-b', '副本 B 任务', '2026-09-03T00:05:00.000Z');
  insertAssignment(db, 'assign-unknown', unknownWorktreeId, 'agent-unknown', '未知来源任务', '2026-09-03T00:06:00.000Z');

  insertProgress(db, 'progress-a', 'assign-space-a', 'session-assign-space-a', 2, '副本 A 进展', 'feature/shared', '2026-09-03T01:00:00.000Z');
  insertProgress(db, 'progress-b', 'assign-space-b', 'session-assign-space-b', 2, '副本 B 进展', 'feature/shared', '2026-09-03T02:00:00.000Z');
  insertProgress(db, 'progress-unknown', 'assign-unknown', 'session-assign-unknown', 2, '来源未确认进展', 'feature/shared', '2026-09-03T05:00:00.000Z');
  insertRelay(db, '2026-09-03T03:00:00.000Z');

  insertSubmissionAndReceipt(db, {
    submissionId: 'submission-integrated-a',
    sourceWorktreeId: spaceAWorktreeId,
    sourceBranch: 'feature/shared',
    status: 'integrated',
    receiptId: 'receipt-integrated-a',
    outcome: 'integrated',
    integratedCommit: 'main-integrated-a-1234567890',
    createdAt: '2026-09-03T04:00:00.000Z',
  });
  insertSubmissionAndReceipt(db, {
    submissionId: 'submission-rejected-b',
    sourceWorktreeId: spaceBWorktreeId,
    sourceBranch: 'feature/shared',
    status: 'rejected',
    receiptId: 'receipt-rejected-b',
    outcome: 'rejected',
    integratedCommit: null,
    createdAt: '2026-09-03T04:30:00.000Z',
  });

  return db;
}

test('timeline keeps interleaved worktree lanes stable and only draws confirmed integration', (t) => {
  const db = fixture(t);
  const timeline = readProjectTimeline(db, projectId, { limit: 100, offset: 0 });

  assert.equal(timeline.total, 9); // four init + three progress + relay + integrated receipt
  const mainLane = timeline.lanes.find((lane) => lane.role === 'main');
  const laneA = timeline.lanes.find((lane) => lane.worktreeId === spaceAWorktreeId);
  const laneB = timeline.lanes.find((lane) => lane.worktreeId === spaceBWorktreeId);
  const unknownLane = timeline.lanes.find((lane) => lane.worktreeId === unknownWorktreeId);
  assert.equal(mainLane?.key, 'main');
  assert.equal(laneA?.role, 'development_space');
  assert.equal(laneB?.role, 'development_space');
  assert.notEqual(laneA?.key, laneB?.key);
  assert.equal(laneA?.origin?.kind, 'development_space_created');
  assert.equal(unknownLane?.role, 'unknown');

  const bySummary = (summary) => timeline.items.find((item) => item.summary === summary);
  assert.equal(bySummary('副本 A 进展')?.laneKey, laneA.key);
  assert.equal(bySummary('副本 B 进展')?.laneKey, laneB.key);
  assert.equal(bySummary('来源未确认进展')?.laneKey, unknownLane.key);
  assert.equal(bySummary('主项目中途接力')?.laneKey, mainLane.key);
  assert.equal(timeline.items.filter((item) => Object.hasOwn(item.git ?? {}, 'branchChanged')).length, 0);

  const integration = timeline.items.find((item) => item.kind === 'integration');
  assert.ok(integration);
  assert.equal(integration.laneKey, mainLane.key);
  assert.equal(integration.sourceLaneKey, laneA.key);
  assert.equal(integration.integratedCommit, 'main-integrated-a-1234567890');
  assert.equal(timeline.items.filter((item) => item.kind === 'integration' && item.sourceLaneKey === laneB.key).length, 0);

  const firstPage = readProjectTimeline(db, projectId, { limit: 2, offset: 0 });
  const secondPage = readProjectTimeline(db, projectId, { limit: 2, offset: 2 });
  assert.equal(firstPage.hasMore, true);
  assert.equal(secondPage.hasMore, true);
  assert.deepEqual(firstPage.lanes.map((lane) => lane.key), secondPage.lanes.map((lane) => lane.key));
  assert.deepEqual(firstPage.lanes.map((lane) => lane.worktreeId), secondPage.lanes.map((lane) => lane.worktreeId));
  assert.equal(firstPage.items.length, 2);
  assert.equal(secondPage.items.length, 2);

  db.close();
});

test('timeline includes submit_note on its origin work line without integration merge arrow', (t) => {
  const db = fixture(t);

  // Insert a submit note on Space A
  const noteCreatedAt = '2026-09-03T05:00:00.000Z';
  const sourceA = {
    projectId,
    projectName: 'Project Work Lines',
    worktreeId: spaceAWorktreeId,
    canonicalPath: `E:\\work-lines\\${spaceAWorktreeId}`,
    branch: 'feature-a',
    head: 'note-head-a1234567890',
    shortHead: 'note-he',
    attribution: 'unattributed',
    observedAt: noteCreatedAt,
  };
  db.prepare(`
    INSERT INTO commands (id, kind, state, request_json, request_digest, response_json, created_at, updated_at)
    VALUES ('cmd-note-1', 'submit_note', 'committed', '{}', 'digest-1', '{}', ?, ?)
  `).run(noteCreatedAt, noteCreatedAt);
  db.prepare(`
    INSERT INTO submit_notes (
      id, project_id, command_id, title, body, status, revision,
      source_json, references_json, handling_note, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', 1, ?, '[]', '', ?, ?)
  `).run(
    'note-space-a',
    projectId,
    'cmd-note-1',
    'Space A 说明',
    '这是 Space A 的一条工作说明',
    JSON.stringify(sourceA),
    noteCreatedAt,
    noteCreatedAt,
  );

  const timelineBefore = readProjectTimeline(db, projectId, { limit: 100, offset: 0 });
  assert.equal(timelineBefore.total, 10); // 9 previous + 1 submit_note

  const laneA = timelineBefore.lanes.find((lane) => lane.worktreeId === spaceAWorktreeId);
  const noteItem = timelineBefore.items.find((item) => item.id === 'note-space-a');
  assert.ok(noteItem);
  assert.equal(noteItem.kind, 'submit_note');
  assert.equal(noteItem.typeLabel, '工作说明');
  assert.equal(noteItem.laneKey, laneA.key);
  assert.equal(noteItem.timestamp, noteCreatedAt);
  assert.equal(noteItem.status, 'pending');
  // Confirm NO integration arrow / targetWorktreeId
  assert.equal(noteItem.integratedCommit, undefined);
  assert.equal(noteItem.sourceWorktreeId, undefined);

  // Update note status to handled and check that timeline event does NOT move or duplicate
  const updatedTime = '2026-09-03T06:00:00.000Z';
  db.prepare(`
    UPDATE submit_notes
    SET status = 'handled', revision = 2, handling_note = '已完成核对', updated_at = ?
    WHERE id = 'note-space-a'
  `).run(updatedTime);

  const timelineAfter = readProjectTimeline(db, projectId, { limit: 100, offset: 0 });
  assert.equal(timelineAfter.total, 10);
  const notesAfter = timelineAfter.items.filter((item) => item.id === 'note-space-a');
  assert.equal(notesAfter.length, 1);
  assert.equal(notesAfter[0].timestamp, noteCreatedAt); // fixed createdAt
  assert.equal(notesAfter[0].status, 'handled');
  assert.equal(notesAfter[0].handlingNote, '已完成核对');
  assert.equal(notesAfter[0].laneKey, laneA.key);

  db.close();
});
