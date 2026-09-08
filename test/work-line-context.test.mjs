import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { readWorkLineContexts } from '../src/core/work-line-context.mjs';

const projectId = 'work-line-context-project';
const mainWorktreeId = 'work-line-context-main';
const spaceAWorktreeId = 'work-line-context-space-a';
const spaceBWorktreeId = 'work-line-context-space-b';
const sourceWorktreeId = 'work-line-context-source';
const unknownWorktreeId = 'work-line-context-unknown';

const at = (minute) => `2026-09-08T00:${String(minute).padStart(2, '0')}:00.000Z`;

function insertWorktree(db, id, directory = id) {
  db.prepare(`
    INSERT INTO worktrees (
      id, canonical_path, repository_identity, identity_fingerprint, created_at
    ) VALUES (?, ?, 'work-line-context-repo', ?, ?)
  `).run(id, `E:\\work-line-context\\${directory}`, `fp-${id}`, at(0));
}

function insertAssignment(db, {
  id,
  worktreeId,
  agentId,
  taskId,
  status = 'active',
  revision = 1,
  sessionId = null,
  createdAt = at(1),
  updatedAt = createdAt,
}) {
  db.prepare(`
    INSERT INTO assignments (
      id, project_id, worktree_id, agent_id, task_id, scope_json,
      status, revision, session_id, accepted_grant_id, accepted_at,
      last_heartbeat_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?, NULL, ?, ?, ?, ?)
  `).run(
    id,
    projectId,
    worktreeId,
    agentId,
    taskId,
    status,
    revision,
    sessionId,
    sessionId ? createdAt : null,
    sessionId ? updatedAt : null,
    createdAt,
    updatedAt,
  );
}

function insertRun(db, {
  id,
  worktreeId,
  lifecycle = 'active',
  revision = 1,
  agentClaim,
  goal,
  createdAt = at(1),
  lastHeartbeatAt = null,
  finishedAt = null,
}) {
  db.prepare(`
    INSERT INTO runs (
      id, worktree_id, mode, lifecycle, health, revision, lease_generation,
      agent_claim, goal, created_at, last_heartbeat_at, finished_at
    ) VALUES (?, ?, 'write', ?, 'healthy', ?, 1, ?, ?, ?, ?, ?)
  `).run(
    id,
    worktreeId,
    lifecycle,
    revision,
    agentClaim,
    goal,
    createdAt,
    lastHeartbeatAt,
    finishedAt,
  );
}

function insertSnapshot(db, {
  id,
  runId,
  phase,
  head,
  branch,
  coherence = 'coherent',
  observedAt,
}) {
  db.prepare(`
    INSERT INTO snapshots (
      id, run_id, phase, head, branch, index_fingerprint,
      worktree_fingerprint, repository_identity, worktree_identity,
      head_relation, coherence, observed_at
    ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'work-line-context-repo',
      'snapshot-worktree', 'unknown', ?, ?)
  `).run(id, runId, phase, head, branch, coherence, observedAt);
}

function insertProgress(db, {
  id,
  assignmentId,
  sessionId,
  revision,
  head,
  branch,
  coherence = 'coherent',
  observedAt,
  createdAt = observedAt,
}) {
  db.prepare(`
    INSERT INTO progress_events (
      id, assignment_id, session_id, client_request_id,
      expected_revision, revision, status, summary, details_json, note,
      git_head, git_branch, git_coherence, git_observed_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'working', 'progress', '[]', 'progress',
      ?, ?, ?, ?, ?)
  `).run(
    id,
    assignmentId,
    sessionId,
    `request-${id}`,
    revision - 1,
    revision,
    head,
    branch,
    coherence,
    observedAt,
    createdAt,
  );
}

function insertRelay(db, {
  id,
  assignmentId,
  worktreeId,
  sessionId,
  revision,
  head,
  branch,
  observedAt,
  createdAt = observedAt,
}) {
  db.prepare(`
    INSERT INTO relays (
      id, sequence, assignment_id, project_id, worktree_id,
      session_id, run_id, client_request_id, expected_revision, revision,
      next_session_focus, summary, current_state, completed_items,
      pending_items, decisions, artifact_refs, risks, suggested_skills,
      git_head, git_branch, git_coherence, git_observed_at,
      code_hash, state, expires_at, created_at
    ) VALUES (?, 1, ?, ?, ?, ?, NULL, ?, ?, ?, 'next', 'relay', 'state',
      '[]', '[]', '[]', '[]', '[]', '[]', ?, ?, 'coherent', ?, ?, 'accepted',
      4102444800000, ?)
  `).run(
    id,
    assignmentId,
    projectId,
    worktreeId,
    sessionId,
    `request-${id}`,
    revision - 1,
    revision,
    head,
    branch,
    observedAt,
    `hash-${id}`,
    createdAt,
  );
}

function fixture(t) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-work-line-context-'));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const db = openCockpitDatabase(path.join(tempDir, 'cockpit.db'));

  for (const [id, directory] of [
    [mainWorktreeId, 'main'],
    [spaceAWorktreeId, 'space-a'],
    [spaceBWorktreeId, 'space-b'],
    [sourceWorktreeId, 'delivery-source'],
    [unknownWorktreeId, 'unregistered-space'],
  ]) insertWorktree(db, id, directory);

  db.prepare(`
    INSERT INTO projects (
      id, name, stage, worktree_id, status, status_reason,
      last_observed_at, created_at, updated_at, repository_identity, authorized_root
    ) VALUES (?, 'Context fixture', 'development', ?, 'ready', 'ready_to_start', ?, ?, ?,
      'work-line-context-repo', 'E:\\work-line-context')
  `).run(projectId, mainWorktreeId, at(0), at(0), at(0));

  db.prepare(`
    INSERT INTO project_observations (
      id, project_id, head, branch, index_fingerprint,
      worktree_fingerprint, has_changes, coherence, observed_at
    ) VALUES ('observation-main', ?, 'main-observed-head', 'main',
      'main-index', 'main-worktree', 0, 'coherent', ?)
  `).run(projectId, at(20));

  db.prepare(`
    INSERT INTO development_spaces (
      id, project_id, name, branch, base_commit, worktree_id,
      status, status_reason, revision, created_at, updated_at, archived_at
    ) VALUES
      ('space-context-a', ?, 'Space A', 'feature/a', 'base-a', ?, 'active', 'working', 2, ?, ?, NULL),
      ('space-context-b', ?, 'Space B', 'feature/b', 'base-b', ?, 'ready', 'no_session', 0, ?, ?, NULL)
  `).run(
    projectId, spaceAWorktreeId, at(1), at(1),
    projectId, spaceBWorktreeId, at(2), at(2),
  );

  db.prepare(`
    INSERT INTO delivery_sources (
      id, project_id, worktree_id, authorized_root,
      source_remote_identity, target_remote_identity, created_at
    ) VALUES ('delivery-context-source', ?, ?, 'E:\\work-line-context\\delivery-source',
      'source-remote', 'target-remote', ?)
  `).run(projectId, sourceWorktreeId, at(3));

  // Main-line records are intentionally newer and must never leak into any
  // non-main context.
  insertAssignment(db, {
    id: 'assignment-main',
    worktreeId: mainWorktreeId,
    agentId: 'main-agent',
    taskId: 'main goal',
    sessionId: 'session-main',
    updatedAt: at(20),
  });
  insertRun(db, {
    id: 'session-main',
    worktreeId: mainWorktreeId,
    agentClaim: 'main-agent',
    goal: 'main goal',
    createdAt: at(20),
    lastHeartbeatAt: at(20),
  });
  insertProgress(db, {
    id: 'progress-main',
    assignmentId: 'assignment-main',
    sessionId: 'session-main',
    revision: 2,
    head: 'main-head',
    branch: 'main',
    observedAt: at(20),
  });

  insertAssignment(db, {
    id: 'assignment-a',
    worktreeId: spaceAWorktreeId,
    agentId: 'space-a-agent',
    taskId: 'Space A goal',
    sessionId: 'session-a',
    revision: 3,
    createdAt: at(4),
    updatedAt: at(8),
  });
  insertRun(db, {
    id: 'session-a',
    worktreeId: spaceAWorktreeId,
    agentClaim: 'space-a-agent',
    goal: 'Space A goal',
    revision: 3,
    createdAt: at(4),
    lastHeartbeatAt: at(8),
  });
  insertSnapshot(db, {
    id: 'snapshot-a-baseline',
    runId: 'session-a',
    phase: 'baseline',
    head: 'a-baseline-head',
    branch: 'feature/a',
    observedAt: at(4),
  });
  insertProgress(db, {
    id: 'progress-a',
    assignmentId: 'assignment-a',
    sessionId: 'session-a',
    revision: 2,
    head: 'a-progress-head',
    branch: 'feature/a',
    observedAt: at(6),
  });
  insertRelay(db, {
    id: 'relay-a',
    assignmentId: 'assignment-a',
    worktreeId: spaceAWorktreeId,
    sessionId: 'session-a',
    revision: 3,
    head: 'a-relay-head',
    branch: 'feature/a',
    observedAt: at(7),
  });

  // This session is over. Its final snapshot is still the source of the
  // selected line's current durable context when no active session remains.
  insertAssignment(db, {
    id: 'assignment-source',
    worktreeId: sourceWorktreeId,
    agentId: 'delivery-agent',
    taskId: 'delivery historical goal',
    status: 'completed',
    revision: 2,
    sessionId: 'session-source',
    createdAt: at(5),
    updatedAt: at(10),
  });
  insertRun(db, {
    id: 'session-source',
    worktreeId: sourceWorktreeId,
    lifecycle: 'completed',
    revision: 3,
    agentClaim: 'delivery-agent',
    goal: 'delivery historical goal',
    createdAt: at(5),
    finishedAt: at(10),
  });
  insertSnapshot(db, {
    id: 'snapshot-source-baseline',
    runId: 'session-source',
    phase: 'baseline',
    head: 'source-baseline-head',
    branch: 'delivery/branch',
    observedAt: at(5),
  });
  insertSnapshot(db, {
    id: 'snapshot-source-final',
    runId: 'session-source',
    phase: 'final',
    head: 'source-final-head',
    branch: 'delivery/branch',
    observedAt: at(9),
  });

  // No development_space row exists for this worktree: the assignment still
  // gives the branch a precise project/worktree lane.
  insertAssignment(db, {
    id: 'assignment-unknown',
    worktreeId: unknownWorktreeId,
    agentId: 'unknown-line-agent',
    taskId: 'unregistered line goal',
    sessionId: 'session-unknown',
    revision: 1,
    createdAt: at(11),
    updatedAt: at(11),
  });

  return db;
}

test('returns isolated contexts for main, spaces, delivery sources, and unregistered worktrees', (t) => {
  const db = fixture(t);
  const contexts = readWorkLineContexts(db, projectId);

  assert.deepEqual(contexts.map((context) => context.laneKey), [
    'main',
    'space:space-context-a',
    'space:space-context-b',
    'source:delivery-context-source',
    `worktree:${unknownWorktreeId}`,
  ]);

  const main = contexts.find((context) => context.laneKey === 'main');
  assert.equal(main.name, '主项目');
  assert.equal(main.role, 'main');
  assert.equal(main.worktreeId, mainWorktreeId);
  assert.equal(main.currentAgent, 'main-agent');
  assert.equal(main.currentGoal, 'main goal');
  assert.equal(main.sessionId, 'session-main');
  assert.equal(main.revision, 1);
  assert.equal(main.session.active, true);
  assert.equal(main.session.lifecycle, 'active');
  assert.equal(main.git.source, 'project_observation');
  assert.equal(main.git.sourceRecordId, 'observation-main');
  assert.equal(main.git.head, 'main-observed-head');
  assert.equal(main.git.hasChanges, false);
  assert.equal(main.git.observedAt, at(20));
  assert.equal(main.lastObservedAt, at(20));

  const spaceA = contexts.find((context) => context.laneKey === 'space:space-context-a');
  assert.equal(spaceA.name, 'Space A');
  assert.equal(spaceA.role, 'development_space');
  assert.equal(spaceA.worktreeId, spaceAWorktreeId);
  assert.equal(spaceA.currentAgent, 'space-a-agent');
  assert.equal(spaceA.currentGoal, 'Space A goal');
  assert.equal(spaceA.sessionId, 'session-a');
  assert.equal(spaceA.revision, 3);
  assert.equal(spaceA.session.active, true);
  assert.equal(spaceA.session.lifecycle, 'active');
  assert.equal(spaceA.git.source, 'relay');
  assert.equal(spaceA.git.sourceRecordId, 'relay-a');
  assert.equal(spaceA.git.head, 'a-relay-head');
  assert.equal(spaceA.git.shortHead, 'a-relay');
  assert.equal(spaceA.git.branch, 'feature/a');
  assert.equal(spaceA.git.hasChanges, null);
  assert.equal(spaceA.git.coherence, 'coherent');
  assert.equal(spaceA.git.observedAt, at(7));
  assert.equal(spaceA.lastObservedAt, at(7));
  assert.deepEqual(spaceA.lastCheck, {
    source: 'relay',
    recordId: 'relay-a',
    phase: null,
    sessionId: 'session-a',
    observedAt: at(7),
  });

  const source = contexts.find((context) => context.laneKey === 'source:delivery-context-source');
  assert.equal(source.role, 'delivery_source');
  assert.equal(source.sourceId, 'delivery-context-source');
  assert.equal(source.spaceId, null);
  assert.equal(source.path, 'E:\\work-line-context\\delivery-source');
  assert.equal(source.currentAgent, 'delivery-agent');
  assert.equal(source.currentGoal, 'delivery historical goal');
  assert.equal(source.sessionId, 'session-source');
  assert.equal(source.session.active, false);
  assert.equal(source.session.status, 'completed');
  assert.equal(source.session.lifecycle, 'completed');
  assert.equal(source.git.source, 'snapshot');
  assert.equal(source.git.sourcePhase, 'final');
  assert.equal(source.git.sourceRecordId, 'snapshot-source-final');
  assert.equal(source.git.head, 'source-final-head');
  assert.equal(source.lastObservedAt, at(9));

  const unknown = contexts.find((context) => context.laneKey === `worktree:${unknownWorktreeId}`);
  assert.equal(unknown.role, 'unknown');
  assert.equal(unknown.name, '来源未确认');
  assert.equal(unknown.currentAgent, 'unknown-line-agent');
  assert.equal(unknown.currentGoal, 'unregistered line goal');
  assert.equal(unknown.sessionId, 'session-unknown');
  assert.equal(unknown.revision, 1);
  assert.equal(unknown.git.head, null);
  assert.equal(unknown.git.shortHead, null);
  assert.equal(unknown.git.branch, null);
  assert.equal(unknown.git.hasChanges, null);
  assert.equal(unknown.git.coherence, 'unknown');
  assert.equal(unknown.git.source, 'unknown');
  assert.equal(unknown.git.observedAt, null);
  assert.equal(unknown.lastObservedAt, null);
  assert.deepEqual(unknown.lastCheck, {
    source: 'unknown',
    recordId: null,
    phase: null,
    sessionId: null,
    observedAt: null,
  });

  db.close();
});

test('keeps an empty registered space explicit instead of borrowing another line', (t) => {
  const db = fixture(t);
  const context = readWorkLineContexts(db, projectId)
    .find((candidate) => candidate.laneKey === 'space:space-context-b');

  assert.ok(context);
  assert.equal(context.currentAgent, null);
  assert.equal(context.currentGoal, null);
  assert.equal(context.sessionId, null);
  assert.equal(context.revision, null);
  assert.equal(context.session, null);
  assert.deepEqual(context.git, {
    head: null,
    shortHead: null,
    branch: null,
    hasChanges: null,
    coherence: 'unknown',
    source: 'unknown',
    sourceRecordId: null,
    sourcePhase: null,
    observedAt: null,
  });
  assert.equal(context.lastObservedAt, null);
  assert.equal(context.currentAgent === 'main-agent', false);

  db.close();
});
