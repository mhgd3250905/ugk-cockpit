import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SUPPORTED_SCHEMA_VERSION = 3;

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
