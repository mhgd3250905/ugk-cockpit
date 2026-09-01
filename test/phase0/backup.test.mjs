import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { backupBeforeMigration, createConsistentBackup } from '../../src/core/backup.mjs';
import { openCockpitDatabase, SUPPORTED_SCHEMA_VERSION } from '../../src/core/database.mjs';
import { startWriteRun } from '../../src/core/runs.mjs';

test('consistent backup opens independently and preserves integrity', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-backup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'source.db');
  const backupPath = path.join(root, 'backups', 'cockpit-0.0.1.db');
  const db = openCockpitDatabase(sourcePath);
  const result = startWriteRun(db, {
    commandId: 'backup-start',
    runId: 'backup-run',
    worktreeId: 'backup-worktree',
    canonicalPath: 'E:\\fixture\\backup',
    repositoryIdentity: 'backup-repository',
    agentClaim: 'codex',
    goal: 'backup test',
    baseline: { coherence: 'coherent' },
  });
  assert.equal(result.ok, true);
  await createConsistentBackup(db, backupPath);
  db.close();

  const restored = openCockpitDatabase(backupPath, { migrate: false });
  assert.equal(restored.prepare('SELECT count(*) AS count FROM runs').get().count, 1);
  assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(restored.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(
    restored.prepare('PRAGMA user_version').get().user_version,
    SUPPORTED_SCHEMA_VERSION,
  );
  restored.close();
});

test('a verified backup is created before a schema upgrade and skipped otherwise', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-pre-migration-backup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'cockpit.db');
  openCockpitDatabase(sourcePath).close();

  const backupPath = await backupBeforeMigration({
    sourcePath,
    backupDirectory: path.join(root, 'backups'),
    targetVersion: SUPPORTED_SCHEMA_VERSION + 1,
  });
  assert.ok(backupPath);
  const restored = openCockpitDatabase(backupPath, { migrate: false });
  assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(restored.prepare('PRAGMA user_version').get().user_version, SUPPORTED_SCHEMA_VERSION);
  restored.close();

  assert.equal(await backupBeforeMigration({
    sourcePath,
    backupDirectory: path.join(root, 'backups'),
    targetVersion: SUPPORTED_SCHEMA_VERSION,
  }), null);
});
