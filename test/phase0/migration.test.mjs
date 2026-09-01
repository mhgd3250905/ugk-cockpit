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
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  db.close();
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
  assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, 8);
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
  assert.equal(repaired.prepare('PRAGMA user_version').get().user_version, 8);
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
