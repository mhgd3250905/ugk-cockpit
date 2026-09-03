import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SUPPORTED_SCHEMA_VERSION = 20;

const BOOTSTRAP = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL
) STRICT;
`;

const MIGRATIONS = [
  {
    version: 1,
    name: 'phase0-core',
    sql: `
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
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  worktree_id TEXT NOT NULL REFERENCES worktrees(id),
  mode TEXT NOT NULL CHECK (mode IN ('read', 'write')),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'completed', 'blocked', 'abandoned', 'superseded')),
  health TEXT NOT NULL CHECK (health IN ('healthy', 'attention', 'recovery_uncertain')),
  revision INTEGER NOT NULL,
  lease_generation INTEGER NOT NULL,
  agent_claim TEXT NOT NULL,
  goal TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_heartbeat_at TEXT,
  finished_at TEXT
) STRICT;

CREATE TABLE write_leases (
  worktree_id TEXT PRIMARY KEY REFERENCES worktrees(id),
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
  generation INTEGER NOT NULL,
  acquired_at TEXT NOT NULL
) STRICT;

CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  phase TEXT NOT NULL CHECK (phase IN ('baseline', 'final')),
  head TEXT,
  branch TEXT,
  index_fingerprint TEXT,
  worktree_fingerprint TEXT,
  coherence TEXT NOT NULL CHECK (coherence IN ('coherent', 'incoherent', 'unknown')),
  observed_at TEXT NOT NULL,
  UNIQUE(run_id, phase)
) STRICT;

CREATE TABLE handoff_receipts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
  finish_command_id TEXT NOT NULL UNIQUE REFERENCES commands(id),
  final_snapshot_id TEXT NOT NULL UNIQUE REFERENCES snapshots(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'blocked', 'abandoned')),
  summary TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_commands_state ON commands(state);
CREATE INDEX idx_runs_worktree_lifecycle ON runs(worktree_id, lifecycle);
`,
  },
  {
    version: 2,
    name: 'bind-repository-and-worktree-identity',
    sql: `
ALTER TABLE worktrees ADD COLUMN identity_fingerprint TEXT NOT NULL DEFAULT '';
ALTER TABLE snapshots ADD COLUMN repository_identity TEXT NOT NULL DEFAULT '';
ALTER TABLE snapshots ADD COLUMN worktree_identity TEXT NOT NULL DEFAULT '';
ALTER TABLE snapshots ADD COLUMN head_relation TEXT NOT NULL DEFAULT 'unknown'
  CHECK (head_relation IN ('same', 'descendant', 'diverged', 'unknown'));
`,
  },
  {
    version: 3,
    name: 'repair-legacy-v2-identity-schema',
    apply(db) {
      const columns = (table) => new Set(
        db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name),
      );
      const worktreeColumns = columns('worktrees');
      const snapshotColumns = columns('snapshots');
      if (!worktreeColumns.has('identity_fingerprint')) {
        db.exec("ALTER TABLE worktrees ADD COLUMN identity_fingerprint TEXT NOT NULL DEFAULT '';");
      }
      if (!snapshotColumns.has('repository_identity')) {
        db.exec("ALTER TABLE snapshots ADD COLUMN repository_identity TEXT NOT NULL DEFAULT '';");
      }
      if (!snapshotColumns.has('worktree_identity')) {
        db.exec("ALTER TABLE snapshots ADD COLUMN worktree_identity TEXT NOT NULL DEFAULT '';");
      }
      if (!snapshotColumns.has('head_relation')) {
        db.exec(`
          ALTER TABLE snapshots ADD COLUMN head_relation TEXT NOT NULL DEFAULT 'unknown'
          CHECK (head_relation IN ('same', 'descendant', 'diverged', 'unknown'));
        `);
      }
    },
  },
  {
    version: 4,
    name: 'project-registry',
    sql: `
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
CREATE INDEX idx_projects_status_updated ON projects(status, updated_at DESC);
`,
  },
  {
    version: 5,
    name: 'project-observation-evidence',
    sql: `
ALTER TABLE projects ADD COLUMN authorized_root TEXT NOT NULL DEFAULT '';
CREATE TABLE project_observations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  head TEXT,
  branch TEXT,
  index_fingerprint TEXT,
  worktree_fingerprint TEXT,
  has_changes INTEGER NOT NULL CHECK (has_changes IN (0, 1)),
  coherence TEXT NOT NULL CHECK (coherence IN ('coherent', 'incoherent', 'unknown')),
  observed_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_project_observations_latest
  ON project_observations(project_id, observed_at DESC);
`,
  },
  {
    version: 6,
    name: 'durable-folder-grants',
    sql: `
CREATE TABLE folder_grants (
  id TEXT PRIMARY KEY,
  principal_hash TEXT NOT NULL,
  folder_path TEXT NOT NULL,
  canonical_path TEXT NOT NULL,
  repository_identity TEXT NOT NULL,
  worktree_identity TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'claimed', 'consumed')),
  claimed_by_command TEXT,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_folder_grants_expiry ON folder_grants(expires_at);
`,
  },
  {
    version: 7,
    name: 'handoff-next-step',
    apply(db) {
      const table = db.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'handoff_receipts'
      `).get();
      if (!table) return;
      const columns = new Set(
        db.prepare('PRAGMA table_info(handoff_receipts)').all().map((row) => row.name),
      );
      if (!columns.has('next_step')) {
        db.exec("ALTER TABLE handoff_receipts ADD COLUMN next_step TEXT NOT NULL DEFAULT '';");
      }
    },
  },
  {
    version: 8,
    name: 'mcp-first-assignments',
    sql: `
CREATE TABLE assignments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  worktree_id TEXT NOT NULL REFERENCES worktrees(id),
  agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'accepted', 'active', 'completed', 'blocked',
    'abandoned', 'failed', 'cancelled'
  )),
  revision INTEGER NOT NULL,
  session_id TEXT UNIQUE,
  accepted_grant_id TEXT,
  accepted_at TEXT,
  last_heartbeat_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE dispatch_grants (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES assignments(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  worktree_id TEXT NOT NULL REFERENCES worktrees(id),
  agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('active', 'accepted', 'revoked', 'expired')),
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  accepted_at TEXT,
  accepted_session_id TEXT,
  accepted_client_request_id TEXT,
  revoked_at TEXT
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
CREATE INDEX idx_assignments_project_status ON assignments(project_id, status, updated_at DESC);
CREATE INDEX idx_dispatch_grants_assignment_state ON dispatch_grants(assignment_id, state);
CREATE INDEX idx_dispatch_grants_expiry ON dispatch_grants(state, expires_at);
CREATE INDEX idx_progress_events_assignment_revision ON progress_events(assignment_id, revision DESC);
`,
  },
  {
    version: 9,
    name: 'append-only-handoff-manuals',
    sql: `
CREATE TABLE handoffs (
  id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  assignment_id TEXT NOT NULL REFERENCES assignments(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  worktree_id TEXT NOT NULL REFERENCES worktrees(id),
  session_id TEXT NOT NULL,
  run_id TEXT REFERENCES runs(id),
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
  body_markdown TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(session_id, client_request_id),
  UNIQUE(session_id, sequence)
) STRICT;
CREATE INDEX idx_handoffs_project_created
  ON handoffs(project_id, created_at DESC, id DESC);
CREATE INDEX idx_handoffs_session_sequence
  ON handoffs(session_id, sequence DESC);
CREATE INDEX idx_handoffs_assignment_created
  ON handoffs(assignment_id, created_at DESC, id DESC);
CREATE TRIGGER handoffs_append_only_update
BEFORE UPDATE ON handoffs
BEGIN
  SELECT RAISE(ABORT, 'handoffs are append-only');
END;
CREATE TRIGGER handoffs_append_only_delete
BEFORE DELETE ON handoffs
BEGIN
  SELECT RAISE(ABORT, 'handoffs are append-only');
END;
`,
  },
  {
    version: 10,
    name: 'conversation-relays',
    sql: `
CREATE TABLE relays (
  id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  assignment_id TEXT NOT NULL REFERENCES assignments(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  worktree_id TEXT NOT NULL REFERENCES worktrees(id),
  session_id TEXT NOT NULL,
  run_id TEXT REFERENCES runs(id),
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
CREATE INDEX idx_relays_session_state ON relays(session_id, state, created_at DESC);
CREATE INDEX idx_relays_project_state ON relays(project_id, state, created_at DESC);
CREATE INDEX idx_relays_expiry ON relays(state, expires_at);
CREATE INDEX idx_relays_assignment_created ON relays(assignment_id, created_at DESC, id DESC);
`,
  },
  {
    version: 11,
    name: 'progress-structured-git-evidence',
    apply(db) {
      const columns = new Set(
        db.prepare('PRAGMA table_info(progress_events)').all().map((row) => row.name),
      );
      if (!columns.has('summary')) {
        db.exec('ALTER TABLE progress_events ADD COLUMN summary TEXT;');
      }
      if (!columns.has('details_json')) {
        db.exec("ALTER TABLE progress_events ADD COLUMN details_json TEXT NOT NULL DEFAULT '[]';");
      }
      if (!columns.has('git_head')) {
        db.exec('ALTER TABLE progress_events ADD COLUMN git_head TEXT;');
      }
      if (!columns.has('git_branch')) {
        db.exec('ALTER TABLE progress_events ADD COLUMN git_branch TEXT;');
      }
      if (!columns.has('git_coherence')) {
        db.exec("ALTER TABLE progress_events ADD COLUMN git_coherence TEXT CHECK (git_coherence IN ('coherent', 'incoherent', 'unknown'));");
      }
      if (!columns.has('git_observed_at')) {
        db.exec('ALTER TABLE progress_events ADD COLUMN git_observed_at TEXT;');
      }
    },
  },
  {
    version: 12,
    name: 'relay-structured-git-evidence',
    apply(db) {
      const columns = new Set(
        db.prepare('PRAGMA table_info(relays)').all().map((row) => row.name),
      );
      if (!columns.has('git_head')) {
        db.exec('ALTER TABLE relays ADD COLUMN git_head TEXT;');
      }
      if (!columns.has('git_branch')) {
        db.exec('ALTER TABLE relays ADD COLUMN git_branch TEXT;');
      }
      if (!columns.has('git_coherence')) {
        db.exec("ALTER TABLE relays ADD COLUMN git_coherence TEXT CHECK (git_coherence IN ('coherent', 'incoherent', 'unknown'));");
      }
      if (!columns.has('git_observed_at')) {
        db.exec('ALTER TABLE relays ADD COLUMN git_observed_at TEXT;');
      }
    },
  },
  {
    version: 13,
    name: 'project-repository-identity-and-development-spaces',
    sql: `
ALTER TABLE projects ADD COLUMN repository_identity TEXT NOT NULL DEFAULT '';

CREATE TABLE development_spaces (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  worktree_id TEXT NOT NULL UNIQUE REFERENCES worktrees(id),
  status TEXT NOT NULL CHECK (status IN (
    'ready', 'active', 'busy', 'integrating', 'archived', 'paused',
    'awaiting_review', 'attention', 'missing', 'cleanup_ready'
  )),
  status_reason TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
) STRICT;

CREATE INDEX idx_development_spaces_project_status
  ON development_spaces(project_id, status, updated_at DESC);
CREATE INDEX idx_projects_repository_identity
  ON projects(repository_identity);
`,
    apply(db) {
      db.prepare(`
        UPDATE projects
        SET repository_identity = (
          SELECT repository_identity FROM worktrees WHERE worktrees.id = projects.worktree_id
        )
        WHERE worktree_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM worktrees WHERE worktrees.id = projects.worktree_id)
          AND (repository_identity = '' OR repository_identity IS NULL);
      `).run();
    },
  },
  {
    version: 14,
    name: 'submissions-and-integrations',
    sql: `
CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  space_id TEXT REFERENCES development_spaces(id),
  source_worktree_id TEXT NOT NULL REFERENCES worktrees(id),
  target_worktree_id TEXT NOT NULL REFERENCES worktrees(id),
  source_branch TEXT NOT NULL,
  source_commit TEXT NOT NULL,
  target_branch TEXT NOT NULL,
  target_head TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'claimed', 'approved', 'integrated', 'rejected', 'cancelled', 'failed', 'conflict',
    'changes_requested', 'stale', 'merging', 'merged', 'withdrawn', 'push_failed', 'blocked', 'unknown'
  )),
  status_reason TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
) STRICT;

CREATE TABLE integration_claims (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  claimant TEXT NOT NULL,
  source_commit TEXT NOT NULL,
  target_head TEXT NOT NULL,
  target_worktree_id TEXT NOT NULL REFERENCES worktrees(id),
  status TEXT NOT NULL CHECK (status IN ('active', 'released', 'completed', 'failed', 'cancelled', 'timed_out')),
  status_reason TEXT NOT NULL DEFAULT '',
  review_verdict TEXT CHECK (review_verdict IN ('approved', 'changes_requested', 'rejected')),
  review_summary TEXT NOT NULL DEFAULT '',
  review_payload_json TEXT NOT NULL DEFAULT '{}',
  reviewed_at TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  released_at TEXT
) STRICT;

CREATE TABLE integration_receipts (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  claim_id TEXT REFERENCES integration_claims(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  space_id TEXT REFERENCES development_spaces(id),
  source_commit TEXT NOT NULL,
  target_head TEXT NOT NULL,
  integrated_commit TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('integrated', 'rejected', 'conflict', 'failed', 'cancelled')),
  summary TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX idx_integration_claims_active_submission
  ON integration_claims(submission_id) WHERE status = 'active';

CREATE INDEX idx_submissions_project_status
  ON submissions(project_id, status, updated_at DESC);
CREATE INDEX idx_submissions_space
  ON submissions(space_id);
CREATE INDEX idx_integration_claims_submission
  ON integration_claims(submission_id, created_at DESC);
CREATE INDEX idx_integration_receipts_submission
  ON integration_receipts(submission_id, created_at DESC);
CREATE INDEX idx_integration_receipts_project
  ON integration_receipts(project_id, created_at DESC);

CREATE TRIGGER integration_receipts_append_only_update
BEFORE UPDATE ON integration_receipts
BEGIN
  SELECT RAISE(ABORT, 'integration_receipts are append-only');
END;

CREATE TRIGGER integration_receipts_append_only_delete
BEFORE DELETE ON integration_receipts
BEGIN
  SELECT RAISE(ABORT, 'integration_receipts are append-only');
END;
`,
  },
  {
    version: 15,
    name: 'repository-locks',
    sql: `
CREATE TABLE repository_locks (
  repository_identity TEXT PRIMARY KEY,
  lock_id TEXT NOT NULL UNIQUE,
  holder TEXT NOT NULL,
  operation TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  acquired_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  command_id TEXT REFERENCES commands(id)
) STRICT;

CREATE INDEX idx_repository_locks_expiry ON repository_locks(expires_at);
`,
  },
  {
    version: 16,
    name: 'empty-folder-grants',
    sql: `
CREATE TABLE empty_folder_grants (
  id TEXT PRIMARY KEY,
  principal_hash TEXT NOT NULL,
  folder_path TEXT NOT NULL,
  canonical_path TEXT NOT NULL,
  file_identity TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'claimed', 'consumed')),
  claimed_by_command TEXT,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_empty_folder_grants_expiry ON empty_folder_grants(state, expires_at);
CREATE INDEX idx_empty_folder_grants_canonical ON empty_folder_grants(canonical_path);
`,
  },
  {
    version: 17,
    name: 'submission-attempts',
    sql: `
CREATE TABLE submission_attempts (
  command_id TEXT PRIMARY KEY REFERENCES commands(id),
  session_id TEXT NOT NULL,
  assignment_revision INTEGER NOT NULL CHECK (assignment_revision >= 1),
  project_id TEXT NOT NULL REFERENCES projects(id),
  space_id TEXT NOT NULL REFERENCES development_spaces(id),
  source_worktree_id TEXT NOT NULL REFERENCES worktrees(id),
  target_worktree_id TEXT NOT NULL REFERENCES worktrees(id),
  source_branch TEXT NOT NULL,
  target_branch TEXT NOT NULL,
  start_head TEXT NOT NULL,
  target_head TEXT NOT NULL,
  remote_name TEXT NOT NULL,
  summary TEXT NOT NULL,
  commit_message TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'local_saved', 'pushed', 'completed', 'attention')),
  source_commit TEXT,
  submission_id TEXT REFERENCES submissions(id),
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_submission_attempts_space_state
  ON submission_attempts(space_id, state, updated_at DESC);
CREATE INDEX idx_submission_attempts_session
  ON submission_attempts(session_id, updated_at DESC);
`,
  },
  {
    version: 18,
    name: 'integration-attempts',
    sql: `
CREATE TABLE integration_attempts (
  command_id TEXT PRIMARY KEY REFERENCES commands(id),
  session_id TEXT NOT NULL,
  session_revision INTEGER NOT NULL CHECK (session_revision >= 1),
  project_id TEXT NOT NULL REFERENCES projects(id),
  space_id TEXT REFERENCES development_spaces(id),
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  submission_revision INTEGER NOT NULL CHECK (submission_revision >= 0),
  claim_id TEXT NOT NULL REFERENCES integration_claims(id),
  claim_revision INTEGER NOT NULL CHECK (claim_revision >= 0),
  target_worktree_id TEXT NOT NULL REFERENCES worktrees(id),
  target_branch TEXT NOT NULL,
  target_head TEXT NOT NULL,
  source_commit TEXT NOT NULL,
  remote_name TEXT NOT NULL,
  summary TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'local_integrated', 'pushed', 'completed', 'attention')),
  integrated_commit TEXT,
  external_integration INTEGER NOT NULL DEFAULT 0 CHECK (external_integration IN (0, 1)),
  receipt_id TEXT REFERENCES integration_receipts(id),
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_integration_attempts_submission_state
  ON integration_attempts(submission_id, state, updated_at DESC);
CREATE INDEX idx_integration_attempts_session
  ON integration_attempts(session_id, updated_at DESC);
`,
  },
  {
    version: 19,
    name: 'delivery-intake-preflight',
    sql: `
CREATE TABLE delivery_sources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  worktree_id TEXT NOT NULL REFERENCES worktrees(id),
  authorized_root TEXT NOT NULL,
  source_remote_identity TEXT NOT NULL,
  target_remote_identity TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, worktree_id)
) STRICT;
CREATE TABLE delivery_preflights (
  id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL UNIQUE REFERENCES commands(id),
  source_id TEXT NOT NULL REFERENCES delivery_sources(id),
  session_id TEXT,
  session_revision INTEGER,
  inspection_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE TABLE delivery_attempts (
  command_id TEXT PRIMARY KEY REFERENCES commands(id),
  preflight_id TEXT NOT NULL UNIQUE REFERENCES delivery_preflights(id),
  state TEXT NOT NULL CHECK(state IN ('prepared','local_saved','pushed','completed','attention')),
  source_commit TEXT,
  submission_id TEXT REFERENCES submissions(id),
  last_error_code TEXT,
  updated_at TEXT NOT NULL
) STRICT;
ALTER TABLE submissions ADD COLUMN delivery_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE submissions ADD COLUMN delivery_line_key TEXT;
ALTER TABLE submissions ADD COLUMN delivery_version INTEGER NOT NULL DEFAULT 1;
CREATE INDEX idx_submission_delivery_line ON submissions(delivery_line_key, delivery_version);
`,
  },
  {
    version: 20,
    name: 'submit-notes-inbox',
    sql: `
CREATE TABLE IF NOT EXISTS submit_notes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  command_id TEXT UNIQUE REFERENCES commands(id),
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'handled', 'archived')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  source_json TEXT NOT NULL DEFAULT '{}',
  references_json TEXT NOT NULL DEFAULT '[]',
  handling_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  handled_at TEXT,
  archived_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_submit_notes_project_status
  ON submit_notes(project_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_submit_notes_created
  ON submit_notes(created_at DESC);

DROP TRIGGER IF EXISTS submit_notes_immutable_content;
CREATE TRIGGER submit_notes_immutable_content
BEFORE UPDATE ON submit_notes
BEGIN
  SELECT CASE
    WHEN OLD.id IS NOT NEW.id
      OR OLD.project_id IS NOT NEW.project_id
      OR OLD.command_id IS NOT NEW.command_id
      OR OLD.title IS NOT NEW.title
      OR OLD.body IS NOT NEW.body
      OR OLD.source_json IS NOT NEW.source_json
      OR OLD.references_json IS NOT NEW.references_json
      OR OLD.created_at IS NOT NEW.created_at
    THEN RAISE(ABORT, 'submit_notes content is immutable')
  END;
END;
`,
  },
];

function schemaVersion(db) {
  return Number(db.prepare('PRAGMA user_version').get().user_version);
}

function unsupportedSchemaError(version) {
  const error = new Error(
    `Database schema version ${version} is newer than supported version ${SUPPORTED_SCHEMA_VERSION}`,
  );
  error.code = 'UNSUPPORTED_SCHEMA_VERSION';
  return error;
}

function migrateDatabase(db) {
  db.exec(BOOTSTRAP);
  let currentVersion = schemaVersion(db);
  if (currentVersion > SUPPORTED_SCHEMA_VERSION) throw unsupportedSchemaError(currentVersion);

  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue;
    withImmediateTransaction(db, () => {
      if (migration.sql) db.exec(migration.sql);
      migration.apply?.(db);
      db.prepare(`
        INSERT INTO schema_migrations (version, name, applied_at)
        VALUES (?, ?, ?)
      `).run(migration.version, migration.name, new Date().toISOString());
      db.exec(`PRAGMA user_version = ${migration.version}`);
    });
    currentVersion = migration.version;
  }
}

export function openCockpitDatabase(filePath, { migrate = true } = {}) {
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath, {
    timeout: 150,
    allowExtension: false,
    defensive: true,
  });
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 150;');
    const version = schemaVersion(db);
    if (version > SUPPORTED_SCHEMA_VERSION) throw unsupportedSchemaError(version);
    if (migrate) {
      db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      migrateDatabase(db);
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function withImmediateTransaction(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The original failure is more useful than a secondary rollback error.
    }
    throw error;
  }
}
