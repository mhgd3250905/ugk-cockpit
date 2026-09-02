import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  openCockpitDatabase,
  SUPPORTED_SCHEMA_VERSION,
} from '../../src/core/database.mjs';

function fixture(t, name) {
  const root = mkdtempSync(path.join(os.tmpdir(), `ugk-cockpit-${name}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'cockpit.db');
}

test('new database records every ordered migration', (t) => {
  const dbPath = fixture(t, 'migration-new');
  const db = openCockpitDatabase(dbPath);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SUPPORTED_SCHEMA_VERSION);
  assert.deepEqual(
    db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()
      .map((row) => row.version),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
  );
  db.close();
});

test('version 10 database upgrades progress_events schema to version 11 without losing rows', (t) => {
  const dbPath = fixture(t, 'migration-v10');
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO schema_migrations VALUES (1, 'phase0-core', '2026-01-01T00:00:00.000Z');
    CREATE TABLE worktrees (
      id TEXT PRIMARY KEY,
      canonical_path TEXT NOT NULL UNIQUE,
      repository_identity TEXT NOT NULL,
      lease_generation INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      stage TEXT NOT NULL CHECK (stage IN ('development', 'maintenance', 'paused')),
      worktree_id TEXT NOT NULL UNIQUE REFERENCES worktrees(id),
      status TEXT NOT NULL CHECK (status IN ('ready', 'attention', 'active', 'paused')),
      status_reason TEXT NOT NULL,
      last_observed_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE assignments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      worktree_id TEXT NOT NULL REFERENCES worktrees(id),
      agent_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      scope_json TEXT NOT NULL,
      status TEXT NOT NULL,
      revision INTEGER NOT NULL,
      session_id TEXT UNIQUE,
      accepted_grant_id TEXT,
      accepted_at TEXT,
      last_heartbeat_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE progress_events (
      id TEXT PRIMARY KEY,
      assignment_id TEXT NOT NULL REFERENCES assignments(id),
      session_id TEXT NOT NULL,
      client_request_id TEXT NOT NULL,
      expected_revision INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      status TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(assignment_id, session_id, client_request_id)
    ) STRICT;
    CREATE TABLE relays (
      id TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL CHECK (sequence >= 1),
      assignment_id TEXT NOT NULL REFERENCES assignments(id),
      project_id TEXT NOT NULL REFERENCES projects(id),
      worktree_id TEXT NOT NULL REFERENCES worktrees(id),
      session_id TEXT NOT NULL,
      run_id TEXT,
      client_request_id TEXT NOT NULL,
      expected_revision INTEGER NOT NULL CHECK (expected_revision >= 1),
      revision INTEGER NOT NULL CHECK (revision >= expected_revision),
      next_session_focus TEXT NOT NULL,
      summary TEXT NOT NULL,
      current_state TEXT NOT NULL,
      completed_items TEXT NOT NULL,
      pending_items TEXT NOT NULL,
      decisions TEXT NOT NULL,
      artifact_refs TEXT NOT NULL,
      risks TEXT NOT NULL,
      suggested_skills TEXT NOT NULL,
      code_hash TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK (state IN ('active', 'accepted', 'expired')),
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      accepted_at TEXT,
      accepted_client_request_id TEXT,
      accepted_revision INTEGER,
      UNIQUE(session_id, client_request_id),
      UNIQUE(session_id, sequence)
    ) STRICT;
    INSERT INTO worktrees VALUES ('wt-1', 'E:\\repo', 'repo-1', 0, '2026-01-01T00:00:00.000Z');
    INSERT INTO projects VALUES ('proj-1', 'Test', 'development', 'wt-1', 'ready', 'ready_to_start', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO assignments VALUES ('assign-1', 'proj-1', 'wt-1', 'Codex', 'Task', '{}', 'active', 2, 'sess-1', NULL, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO progress_events VALUES ('pe-1', 'assign-1', 'sess-1', 'req-1', 1, 2, 'working', 'Legacy note before v11', '2026-01-01T00:00:00.000Z');
    PRAGMA user_version = 10;
  `);
  legacy.close();

  // Re-open (migrateDatabase)
  const upgraded = openCockpitDatabase(dbPath);
  assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, SUPPORTED_SCHEMA_VERSION);
  const peColumns = upgraded.prepare('PRAGMA table_info(progress_events)').all().map((r) => r.name);
  assert.ok(peColumns.includes('summary'));
  assert.ok(peColumns.includes('details_json'));
  assert.ok(peColumns.includes('git_head'));
  assert.ok(peColumns.includes('git_branch'));
  assert.ok(peColumns.includes('git_coherence'));
  assert.ok(peColumns.includes('git_observed_at'));

  const row = upgraded.prepare('SELECT * FROM progress_events WHERE id = ?').get('pe-1');
  assert.equal(row.note, 'Legacy note before v11');
  assert.equal(row.summary, null);
  assert.equal(row.details_json, '[]');
  assert.equal(row.git_head, null);
  assert.equal(row.git_branch, null);
  assert.equal(row.git_coherence, null);
  assert.equal(row.git_observed_at, null);

  const insertStmt = upgraded.prepare(`
    INSERT INTO progress_events (
      id, assignment_id, session_id, client_request_id,
      expected_revision, revision, status, note, summary, details_json,
      git_head, git_branch, git_coherence, git_observed_at, created_at
    ) VALUES (?, 'assign-1', 'sess-1', ?, 2, 3, 'working', '', ?, '[]', NULL, NULL, ?, NULL, '2026-01-01T00:00:00.000Z')
  `);

  insertStmt.run('pe-coherent', 'req-coherent', 'Coherent update', 'coherent');
  insertStmt.run('pe-incoherent', 'req-incoherent', 'Incoherent update', 'incoherent');
  insertStmt.run('pe-unknown', 'req-unknown', 'Unknown update', 'unknown');
  insertStmt.run('pe-null', 'req-null', 'Null update', null);

  assert.equal(upgraded.prepare('SELECT git_coherence FROM progress_events WHERE id = ?').get('pe-coherent').git_coherence, 'coherent');
  assert.equal(upgraded.prepare('SELECT git_coherence FROM progress_events WHERE id = ?').get('pe-incoherent').git_coherence, 'incoherent');
  assert.equal(upgraded.prepare('SELECT git_coherence FROM progress_events WHERE id = ?').get('pe-unknown').git_coherence, 'unknown');
  assert.equal(upgraded.prepare('SELECT git_coherence FROM progress_events WHERE id = ?').get('pe-null').git_coherence, null);

  assert.throws(
    () => insertStmt.run('pe-invalid', 'req-invalid', 'Invalid update', 'invalid_coherence'),
    /CHECK constraint failed/i,
  );

  upgraded.close();
});

test('version 11 database upgrades relays schema to version 12 without losing rows', (t) => {
  const dbPath = fixture(t, 'migration-v11');
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO schema_migrations VALUES (1, 'phase0-core', '2026-01-01T00:00:00.000Z');
    CREATE TABLE worktrees (
      id TEXT PRIMARY KEY,
      canonical_path TEXT NOT NULL UNIQUE,
      repository_identity TEXT NOT NULL,
      lease_generation INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      stage TEXT NOT NULL CHECK (stage IN ('development', 'maintenance', 'paused')),
      worktree_id TEXT NOT NULL UNIQUE REFERENCES worktrees(id),
      status TEXT NOT NULL CHECK (status IN ('ready', 'attention', 'active', 'paused')),
      status_reason TEXT NOT NULL,
      last_observed_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE assignments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      worktree_id TEXT NOT NULL REFERENCES worktrees(id),
      agent_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      scope_json TEXT NOT NULL,
      status TEXT NOT NULL,
      revision INTEGER NOT NULL,
      session_id TEXT UNIQUE,
      accepted_grant_id TEXT,
      accepted_at TEXT,
      last_heartbeat_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE relays (
      id TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL CHECK (sequence >= 1),
      assignment_id TEXT NOT NULL REFERENCES assignments(id),
      project_id TEXT NOT NULL REFERENCES projects(id),
      worktree_id TEXT NOT NULL REFERENCES worktrees(id),
      session_id TEXT NOT NULL,
      run_id TEXT,
      client_request_id TEXT NOT NULL,
      expected_revision INTEGER NOT NULL CHECK (expected_revision >= 1),
      revision INTEGER NOT NULL CHECK (revision >= expected_revision),
      next_session_focus TEXT NOT NULL,
      summary TEXT NOT NULL,
      current_state TEXT NOT NULL,
      completed_items TEXT NOT NULL,
      pending_items TEXT NOT NULL,
      decisions TEXT NOT NULL,
      artifact_refs TEXT NOT NULL,
      risks TEXT NOT NULL,
      suggested_skills TEXT NOT NULL,
      code_hash TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK (state IN ('active', 'accepted', 'expired')),
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      accepted_at TEXT,
      accepted_client_request_id TEXT,
      accepted_revision INTEGER,
      UNIQUE(session_id, client_request_id),
      UNIQUE(session_id, sequence)
    ) STRICT;
    INSERT INTO worktrees VALUES ('wt-1', 'E:\\repo', 'repo-1', 0, '2026-01-01T00:00:00.000Z');
    INSERT INTO projects VALUES ('proj-1', 'Test', 'development', 'wt-1', 'ready', 'ready_to_start', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO assignments VALUES ('assign-1', 'proj-1', 'wt-1', 'Codex', 'Task', '{}', 'active', 2, 'sess-1', NULL, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO relays VALUES (
      'rel-1', 1, 'assign-1', 'proj-1', 'wt-1', 'sess-1', NULL, 'req-1', 1, 2,
      'next focus', 'summary text', 'current state', '[]', '[]', '[]', '[]', '[]', '[]',
      'hash-1', 'active', 1900000000000, '2026-01-01T00:00:00.000Z', NULL, NULL, NULL
    );
    PRAGMA user_version = 11;
  `);
  legacy.close();

  // Re-open (migrateDatabase)
  const upgraded = openCockpitDatabase(dbPath);
  assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, SUPPORTED_SCHEMA_VERSION);
  const relayColumns = upgraded.prepare('PRAGMA table_info(relays)').all().map((r) => r.name);
  assert.ok(relayColumns.includes('git_head'));
  assert.ok(relayColumns.includes('git_branch'));
  assert.ok(relayColumns.includes('git_coherence'));
  assert.ok(relayColumns.includes('git_observed_at'));

  const row = upgraded.prepare('SELECT * FROM relays WHERE id = ?').get('rel-1');
  assert.equal(row.summary, 'summary text');
  assert.equal(row.git_head, null);
  assert.equal(row.git_branch, null);
  assert.equal(row.git_coherence, null);
  assert.equal(row.git_observed_at, null);

  const insertStmt = upgraded.prepare(`
    INSERT INTO relays (
      id, sequence, assignment_id, project_id, worktree_id,
      session_id, run_id, client_request_id, expected_revision, revision,
      next_session_focus, summary, current_state,
      completed_items, pending_items, decisions,
      artifact_refs, risks, suggested_skills,
      code_hash, state, expires_at, created_at,
      git_head, git_branch, git_coherence, git_observed_at
    ) VALUES (
      ?, ?, 'assign-1', 'proj-1', 'wt-1', 'sess-1', NULL, ?, 2, 3,
      'next', 'summary', 'state', '[]', '[]', '[]', '[]', '[]', '[]',
      ?, 'active', 1900000000000, '2026-01-01T00:00:00.000Z',
      NULL, NULL, ?, NULL
    )
  `);

  insertStmt.run('rel-coherent', 2, 'req-coherent', 'hash-coherent', 'coherent');
  insertStmt.run('rel-incoherent', 3, 'req-incoherent', 'hash-incoherent', 'incoherent');
  insertStmt.run('rel-unknown', 4, 'req-unknown', 'hash-unknown', 'unknown');
  insertStmt.run('rel-null', 5, 'req-null', 'hash-null', null);

  assert.equal(upgraded.prepare('SELECT git_coherence FROM relays WHERE id = ?').get('rel-coherent').git_coherence, 'coherent');
  assert.equal(upgraded.prepare('SELECT git_coherence FROM relays WHERE id = ?').get('rel-incoherent').git_coherence, 'incoherent');
  assert.equal(upgraded.prepare('SELECT git_coherence FROM relays WHERE id = ?').get('rel-unknown').git_coherence, 'unknown');
  assert.equal(upgraded.prepare('SELECT git_coherence FROM relays WHERE id = ?').get('rel-null').git_coherence, null);

  assert.throws(
    () => insertStmt.run('rel-invalid', 6, 'req-invalid', 'hash-invalid', 'invalid_coherence'),
    /CHECK constraint failed/i,
  );

  upgraded.close();
});

test('version 1 database upgrades missing identity columns without losing rows', (t) => {
  const dbPath = fixture(t, 'migration-v1');
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO schema_migrations VALUES (1, 'phase0-core', '2026-01-01T00:00:00.000Z');
    CREATE TABLE worktrees (
      id TEXT PRIMARY KEY,
      canonical_path TEXT NOT NULL UNIQUE,
      repository_identity TEXT NOT NULL,
      lease_generation INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO worktrees VALUES ('worktree-1', 'E:\\fixture', 'repo-1', 0, '2026-01-01T00:00:00.000Z');
    CREATE TABLE snapshots (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      head TEXT,
      branch TEXT,
      index_fingerprint TEXT,
      worktree_fingerprint TEXT,
      coherence TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      UNIQUE(run_id, phase)
    ) STRICT;
    INSERT INTO snapshots VALUES (
      'snapshot-1', 'run-1', 'baseline', NULL, NULL, NULL, NULL,
      'unknown', '2026-01-01T00:00:00.000Z'
    );
    PRAGMA user_version = 1;
  `);
  legacy.close();

  const upgraded = openCockpitDatabase(dbPath);
  assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, SUPPORTED_SCHEMA_VERSION);
  assert.equal(upgraded.prepare(`
    SELECT identity_fingerprint FROM worktrees WHERE id = 'worktree-1'
  `).get().identity_fingerprint, '');
  const snapshot = upgraded.prepare(`
      SELECT repository_identity, worktree_identity, head_relation
      FROM snapshots WHERE id = 'snapshot-1'
  `).get();
  assert.equal(snapshot.repository_identity, '');
  assert.equal(snapshot.worktree_identity, '');
  assert.equal(snapshot.head_relation, 'unknown');
  upgraded.close();
});

test('legacy version 2 marker is repaired when identity columns are absent', (t) => {
  const dbPath = fixture(t, 'migration-legacy-v2');
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO schema_migrations VALUES (2, 'phase0-core', '2026-01-01T00:00:00.000Z');
    CREATE TABLE worktrees (
      id TEXT PRIMARY KEY,
      canonical_path TEXT NOT NULL UNIQUE,
      repository_identity TEXT NOT NULL,
      lease_generation INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE snapshots (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      head TEXT,
      branch TEXT,
      index_fingerprint TEXT,
      worktree_fingerprint TEXT,
      coherence TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      UNIQUE(run_id, phase)
    ) STRICT;
    PRAGMA user_version = 2;
  `);
  legacy.close();

  const repaired = openCockpitDatabase(dbPath);
  assert.equal(repaired.prepare('PRAGMA user_version').get().user_version, SUPPORTED_SCHEMA_VERSION);
  const worktreeColumns = repaired.prepare('PRAGMA table_info(worktrees)').all()
    .map((row) => row.name);
  const snapshotColumns = repaired.prepare('PRAGMA table_info(snapshots)').all()
    .map((row) => row.name);
  assert.ok(worktreeColumns.includes('identity_fingerprint'));
  assert.ok(snapshotColumns.includes('repository_identity'));
  assert.ok(snapshotColumns.includes('worktree_identity'));
  assert.ok(snapshotColumns.includes('head_relation'));
  repaired.close();
});

test('version 12 database upgrades to version 15 with repository_identity backfilled and new tables created', (t) => {
  const dbPath = fixture(t, 'migration-v12');
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO schema_migrations VALUES (1, 'phase0-core', '2026-01-01T00:00:00.000Z');
    CREATE TABLE commands (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      request_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('received', 'observing', 'committed', 'failed', 'uncertain')),
      response_json TEXT,
      run_id TEXT,
      receipt_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE worktrees (
      id TEXT PRIMARY KEY,
      canonical_path TEXT NOT NULL UNIQUE,
      repository_identity TEXT NOT NULL,
      lease_generation INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      identity_fingerprint TEXT NOT NULL DEFAULT ''
    ) STRICT;
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      stage TEXT NOT NULL CHECK (stage IN ('development', 'maintenance', 'paused')),
      worktree_id TEXT NOT NULL UNIQUE REFERENCES worktrees(id),
      status TEXT NOT NULL CHECK (status IN ('ready', 'attention', 'active', 'paused')),
      status_reason TEXT NOT NULL,
      last_observed_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      authorized_root TEXT NOT NULL DEFAULT ''
    ) STRICT;
    INSERT INTO worktrees VALUES ('wt-1', 'E:\\repo1', 'repo-identity-1', 0, '2026-01-01T00:00:00.000Z', 'fp-1');
    INSERT INTO projects VALUES ('proj-1', 'Test Project 1', 'development', 'wt-1', 'ready', 'ready_to_start', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'E:\\repo1');
    PRAGMA user_version = 12;
  `);
  legacy.close();

  const upgraded = openCockpitDatabase(dbPath);
  assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, SUPPORTED_SCHEMA_VERSION);

  // Verify projects.repository_identity was backfilled
  const projectRow = upgraded.prepare('SELECT * FROM projects WHERE id = ?').get('proj-1');
  assert.equal(projectRow.repository_identity, 'repo-identity-1');
  assert.equal(projectRow.worktree_id, 'wt-1');
  assert.equal(projectRow.name, 'Test Project 1');

  // Verify development_spaces table exists and functions
  const devSpaceCols = upgraded.prepare('PRAGMA table_info(development_spaces)').all().map((r) => r.name);
  assert.ok(devSpaceCols.includes('base_commit'));
  assert.ok(devSpaceCols.includes('branch'));
  assert.ok(devSpaceCols.includes('status'));
  assert.ok(devSpaceCols.includes('revision'));
  assert.ok(devSpaceCols.includes('archived_at'));

  // Test development_spaces insertion & check constraint
  upgraded.prepare(`
    INSERT INTO worktrees VALUES ('wt-space-1', 'E:\\repo1-space', 'repo-identity-1', 0, '2026-01-01T00:00:00.000Z', 'fp-space');
  `).run();
  upgraded.prepare(`
    INSERT INTO development_spaces (
      id, project_id, name, branch, base_commit, worktree_id,
      status, status_reason, revision, created_at, updated_at, archived_at
    ) VALUES ('space-1', 'proj-1', 'feature-x', 'feat/x', 'sha-base', 'wt-space-1', 'ready', '', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL);
  `).run();

  assert.throws(
    () => upgraded.prepare(`
      INSERT INTO development_spaces (
        id, project_id, name, branch, base_commit, worktree_id,
        status, status_reason, revision, created_at, updated_at, archived_at
      ) VALUES ('space-bad', 'proj-1', 'bad', 'b', 'sha', 'wt-space-1', 'invalid_status', '', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL);
    `).run(),
    /CHECK constraint failed/i,
  );

  // Test submissions table
  upgraded.prepare(`
    INSERT INTO submissions (
      id, project_id, space_id, source_worktree_id, target_worktree_id, source_branch,
      source_commit, target_branch, target_head, status, status_reason,
      revision, title, description, created_at, updated_at, closed_at
    ) VALUES ('sub-1', 'proj-1', 'space-1', 'wt-space-1', 'wt-1', 'feat/x', 'sha-src', 'main', 'sha-target', 'pending', '', 0, 'Title', 'Desc', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL);
  `).run();

  // Test integration_claims active constraint (at most one active claim per submission)
  upgraded.prepare(`
    INSERT INTO integration_claims (
      id, submission_id, claimant, source_commit, target_head, target_worktree_id,
      status, status_reason, review_verdict, review_summary, review_payload_json, reviewed_at,
      revision, expires_at, created_at, updated_at, released_at
    ) VALUES ('claim-1', 'sub-1', 'agent-1', 'sha-src', 'sha-target', 'wt-1', 'active', '', NULL, '', '{}', NULL, 0, 1900000000000, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL);
  `).run();

  // Second active claim must fail due to unique partial index
  assert.throws(
    () => upgraded.prepare(`
      INSERT INTO integration_claims (
        id, submission_id, claimant, source_commit, target_head, target_worktree_id,
        status, status_reason, review_verdict, review_summary, review_payload_json, reviewed_at,
        revision, expires_at, created_at, updated_at, released_at
      ) VALUES ('claim-2', 'sub-1', 'agent-2', 'sha-src', 'sha-target', 'wt-1', 'active', '', NULL, '', '{}', NULL, 0, 1900000000000, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL);
    `).run(),
    /UNIQUE constraint failed/i,
  );

  // Test integration_receipts append-only
  upgraded.prepare(`
    INSERT INTO integration_receipts (
      id, submission_id, claim_id, project_id, space_id,
      source_commit, target_head, integrated_commit,
      outcome, summary, payload_json, created_at
    ) VALUES ('rec-1', 'sub-1', 'claim-1', 'proj-1', 'space-1', 'sha-src', 'sha-target', 'sha-merge', 'integrated', 'Merged successfully', '{}', '2026-01-01T00:00:00.000Z');
  `).run();

  // Update receipt must fail due to append-only trigger
  assert.throws(
    () => upgraded.prepare("UPDATE integration_receipts SET summary = 'Modified' WHERE id = 'rec-1'").run(),
    /integration_receipts are append-only/i,
  );
  // Delete receipt must fail due to append-only trigger
  assert.throws(
    () => upgraded.prepare("DELETE FROM integration_receipts WHERE id = 'rec-1'").run(),
    /integration_receipts are append-only/i,
  );

  // Test repository_locks table
  upgraded.prepare(`
    INSERT INTO repository_locks (
      repository_identity, lock_id, holder, operation, expires_at, acquired_at, updated_at, command_id
    ) VALUES ('repo-identity-1', 'lock-1', 'agent-1', 'integrate', 1900000000000, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL);
  `).run();

  // Duplicate lock on same repository_identity must fail
  assert.throws(
    () => upgraded.prepare(`
      INSERT INTO repository_locks (
        repository_identity, lock_id, holder, operation, expires_at, acquired_at, updated_at, command_id
      ) VALUES ('repo-identity-1', 'lock-2', 'agent-2', 'integrate', 1900000000000, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL);
    `).run(),
    /UNIQUE constraint failed|PRIMARY KEY/i,
  );

  upgraded.close();
});

test('version 8 database upgrades to version 15 preserving existing assignments', (t) => {
  const dbPath = fixture(t, 'migration-v8');
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO schema_migrations VALUES (1, 'phase0-core', '2026-01-01T00:00:00.000Z');
    CREATE TABLE worktrees (
      id TEXT PRIMARY KEY,
      canonical_path TEXT NOT NULL UNIQUE,
      repository_identity TEXT NOT NULL,
      lease_generation INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      identity_fingerprint TEXT NOT NULL DEFAULT ''
    ) STRICT;
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      stage TEXT NOT NULL CHECK (stage IN ('development', 'maintenance', 'paused')),
      worktree_id TEXT NOT NULL UNIQUE REFERENCES worktrees(id),
      status TEXT NOT NULL CHECK (status IN ('ready', 'attention', 'active', 'paused')),
      status_reason TEXT NOT NULL,
      last_observed_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      authorized_root TEXT NOT NULL DEFAULT ''
    ) STRICT;
    CREATE TABLE assignments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      worktree_id TEXT NOT NULL REFERENCES worktrees(id),
      agent_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      scope_json TEXT NOT NULL,
      status TEXT NOT NULL,
      revision INTEGER NOT NULL,
      session_id TEXT UNIQUE,
      accepted_grant_id TEXT,
      accepted_at TEXT,
      last_heartbeat_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE progress_events (
      id TEXT PRIMARY KEY,
      assignment_id TEXT NOT NULL REFERENCES assignments(id),
      session_id TEXT NOT NULL,
      client_request_id TEXT NOT NULL,
      expected_revision INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      status TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(assignment_id, session_id, client_request_id)
    ) STRICT;
    INSERT INTO worktrees VALUES ('wt-v8', 'E:\\repo-v8', 'repo-identity-v8', 0, '2026-01-01T00:00:00.000Z', 'fp-v8');
    INSERT INTO projects VALUES ('proj-v8', 'Project V8', 'development', 'wt-v8', 'ready', 'ready_to_start', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'E:\\repo-v8');
    INSERT INTO assignments VALUES ('assign-v8', 'proj-v8', 'wt-v8', 'agent-8', 'task-8', '{}', 'active', 1, 'sess-8', NULL, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO progress_events VALUES ('pe-v8', 'assign-v8', 'sess-8', 'req-8', 0, 1, 'active', 'Started', '2026-01-01T00:00:00.000Z');
    PRAGMA user_version = 8;
  `);
  legacy.close();

  const upgraded = openCockpitDatabase(dbPath);
  assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, SUPPORTED_SCHEMA_VERSION);
  const proj = upgraded.prepare('SELECT * FROM projects WHERE id = ?').get('proj-v8');
  assert.equal(proj.repository_identity, 'repo-identity-v8');
  const assign = upgraded.prepare('SELECT * FROM assignments WHERE id = ?').get('assign-v8');
  assert.equal(assign.agent_id, 'agent-8');
  upgraded.close();
});

test('version 4 database upgrades to version 16 preserving projects', (t) => {
  const dbPath = fixture(t, 'migration-v4');
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO schema_migrations VALUES (1, 'phase0-core', '2026-01-01T00:00:00.000Z');
    CREATE TABLE worktrees (
      id TEXT PRIMARY KEY,
      canonical_path TEXT NOT NULL UNIQUE,
      repository_identity TEXT NOT NULL,
      lease_generation INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      identity_fingerprint TEXT NOT NULL DEFAULT ''
    ) STRICT;
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      stage TEXT NOT NULL CHECK (stage IN ('development', 'maintenance', 'paused')),
      worktree_id TEXT NOT NULL UNIQUE REFERENCES worktrees(id),
      status TEXT NOT NULL CHECK (status IN ('ready', 'attention', 'active', 'paused')),
      status_reason TEXT NOT NULL,
      last_observed_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO worktrees VALUES ('wt-v4', 'E:\\repo-v4', 'repo-identity-v4', 0, '2026-01-01T00:00:00.000Z', 'fp-v4');
    INSERT INTO projects VALUES ('proj-v4', 'Project V4', 'development', 'wt-v4', 'ready', 'ready_to_start', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    PRAGMA user_version = 4;
  `);
  legacy.close();

  const upgraded = openCockpitDatabase(dbPath);
  assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, SUPPORTED_SCHEMA_VERSION);
  const proj = upgraded.prepare('SELECT * FROM projects WHERE id = ?').get('proj-v4');
  assert.equal(proj.repository_identity, 'repo-identity-v4');
  assert.equal(proj.authorized_root, '');
  upgraded.close();
});

test('version 15 database upgrades to version 16 creating empty_folder_grants table and indexes', (t) => {
  const dbPath = fixture(t, 'migration-v15');
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO schema_migrations VALUES (1, 'phase0-core', '2026-01-01T00:00:00.000Z');
    INSERT INTO schema_migrations VALUES (15, 'repository-locks', '2026-01-01T00:00:00.000Z');
    CREATE TABLE repository_locks (
      repository_identity TEXT PRIMARY KEY,
      lock_id TEXT NOT NULL UNIQUE,
      holder TEXT NOT NULL,
      operation TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      acquired_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      command_id TEXT
    ) STRICT;
    PRAGMA user_version = 15;
  `);
  legacy.close();

  const upgraded = openCockpitDatabase(dbPath);
  assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, 16);

  // Verify empty_folder_grants table exists
  const cols = upgraded.prepare('PRAGMA table_info(empty_folder_grants)').all().map((r) => r.name);
  assert.ok(cols.includes('id'));
  assert.ok(cols.includes('principal_hash'));
  assert.ok(cols.includes('folder_path'));
  assert.ok(cols.includes('canonical_path'));
  assert.ok(cols.includes('file_identity'));
  assert.ok(cols.includes('state'));
  assert.ok(cols.includes('claimed_by_command'));
  assert.ok(cols.includes('expires_at'));
  assert.ok(cols.includes('created_at'));

  // Test insertion and state check constraint
  upgraded.prepare(`
    INSERT INTO empty_folder_grants (
      id, principal_hash, folder_path, canonical_path, file_identity, state, claimed_by_command, expires_at, created_at
    ) VALUES ('g-1', 'p-hash', 'E:\\empty', 'E:\\empty', 'fi-1', 'active', NULL, 1900000000000, '2026-01-01T00:00:00.000Z');
  `).run();

  assert.throws(
    () => upgraded.prepare(`
      INSERT INTO empty_folder_grants (
        id, principal_hash, folder_path, canonical_path, file_identity, state, claimed_by_command, expires_at, created_at
      ) VALUES ('g-2', 'p-hash', 'E:\\empty2', 'E:\\empty2', 'fi-2', 'invalid_state', NULL, 1900000000000, '2026-01-01T00:00:00.000Z');
    `).run(),
    /CHECK constraint failed/i,
  );

  upgraded.close();
});

test('database from a newer product version is rejected without mutation', (t) => {
  const dbPath = fixture(t, 'migration-future');
  const future = new DatabaseSync(dbPath);
  future.exec('PRAGMA user_version = 999;');
  future.close();

  assert.throws(
    () => openCockpitDatabase(dbPath),
    (error) => error.code === 'UNSUPPORTED_SCHEMA_VERSION',
  );

  const unchanged = new DatabaseSync(dbPath);
  assert.equal(unchanged.prepare('PRAGMA user_version').get().user_version, 999);
  unchanged.close();
});
