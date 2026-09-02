import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SUPPORTED_SCHEMA_VERSION = 11;

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
