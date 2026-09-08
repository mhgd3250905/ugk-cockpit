import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { beginCommand } from '../../src/core/command-journal.mjs';
import { createDevelopmentSpace } from '../../src/core/spaces.mjs';
import { openCockpitDatabase } from '../../src/core/database.mjs';
import {
  readWorkLineStates,
  setProjectArchived,
  setWorkLineClosed,
} from '../../src/core/manual-records.mjs';
import { readProjectDetail } from '../../src/core/timeline.mjs';

const projectId = 'manual-records-core-project';
const mainWorktreeId = 'manual-records-core-main';
const spaceWorktreeId = 'manual-records-core-space';
const sourceWorktreeId = 'manual-records-core-source';
const at = '2026-09-08T00:00:00.000Z';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-manual-core-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, dbPath: path.join(root, 'cockpit.db') };
}

function seedProject(db) {
  for (const [id, directory] of [
    [mainWorktreeId, 'main'],
    [spaceWorktreeId, 'feature'],
    [sourceWorktreeId, 'source-only'],
  ]) {
    db.prepare(`
      INSERT INTO worktrees (
        id, canonical_path, repository_identity, identity_fingerprint, created_at
      ) VALUES (?, ?, 'manual-records-repo', ?, ?)
    `).run(id, `E:\\manual-records\\${directory}`, `fp-${id}`, at);
  }

  db.prepare(`
    INSERT INTO projects (
      id, name, stage, worktree_id, status, status_reason,
      last_observed_at, created_at, updated_at, authorized_root, repository_identity
    ) VALUES (?, 'Manual records core', 'maintenance', ?, 'ready', 'fixture', ?, ?, ?, 'E:\\manual-records', 'manual-records-repo')
  `).run(projectId, mainWorktreeId, at, at, at);

  const space = createDevelopmentSpace(db, {
    commandId: 'manual-records-core-space-create',
    projectId,
    spaceId: 'manual-records-core-space',
    worktreeId: spaceWorktreeId,
    name: '功能工作线',
    branch: 'feature/manual-records',
    baseCommit: 'a'.repeat(40),
  });
  assert.equal(space.ok, true, JSON.stringify(space));

  db.prepare(`
    INSERT INTO delivery_sources (
      id, project_id, worktree_id, authorized_root,
      source_remote_identity, target_remote_identity, created_at
    ) VALUES ('manual-records-core-source', ?, ?, 'E:\\manual-records\\source-only', 'source', 'target', ?)
  `).run(projectId, sourceWorktreeId, at);
}

function downgradeToSchema23(dbPath) {
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    DROP INDEX IF EXISTS idx_work_line_events_project_created;
    DROP INDEX IF EXISTS idx_work_line_states_project;
    DROP TRIGGER IF EXISTS work_line_events_append_only_update;
    DROP TRIGGER IF EXISTS work_line_events_append_only_delete;
    DROP TABLE IF EXISTS work_line_events;
    DROP TABLE IF EXISTS work_line_states;
    ALTER TABLE projects DROP COLUMN archived_at;
    ALTER TABLE projects DROP COLUMN archive_revision;
  `);
  legacy.prepare('DELETE FROM schema_migrations WHERE version >= 24').run();
  legacy.exec('PRAGMA user_version = 23');
  legacy.close();
}

test('schema 23 upgrades repeatably and keeps manual records durable across core operations', (t) => {
  const { dbPath } = fixture(t);
  const seeded = openCockpitDatabase(dbPath);
  seedProject(seeded);
  seeded.close();

  downgradeToSchema23(dbPath);
  let db = openCockpitDatabase(dbPath);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 24);
  assert.equal(
    db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().at(-1).version,
    24,
  );
  assert.equal(db.prepare('SELECT archived_at, archive_revision FROM projects WHERE id = ?').get(projectId).archive_revision, 0);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'work_line_states'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'work_line_events'").get());
  db.close();

  // Re-run the migration from a real schema-23 marker. Existing rows and the
  // newly created schema objects must survive the second application.
  const pending = new DatabaseSync(dbPath);
  pending.prepare('DELETE FROM schema_migrations WHERE version >= 24').run();
  pending.exec('PRAGMA user_version = 23');
  pending.close();
  db = openCockpitDatabase(dbPath);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 24);
  assert.equal(db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId).name, 'Manual records core');

  assert.deepEqual(readWorkLineStates(db, projectId), [
    { worktreeId: sourceWorktreeId, status: 'open', revision: 0, updatedAt: null },
    { worktreeId: spaceWorktreeId, status: 'open', revision: 0, updatedAt: null },
  ]);

  const close = setWorkLineClosed(db, {
    commandId: 'manual-records-core-close',
    projectId,
    worktreeId: spaceWorktreeId,
    expectedRevision: 0,
    closed: true,
  });
  assert.equal(close.ok, true, JSON.stringify(close));
  assert.equal(close.eventKind, 'work_line_closed');
  assert.equal(close.status, 'closed');
  assert.equal(close.revision, 1);
  assert.deepEqual(setWorkLineClosed(db, {
    commandId: 'manual-records-core-close',
    projectId,
    worktreeId: spaceWorktreeId,
    expectedRevision: 0,
    closed: true,
  }), close);
  assert.equal(db.prepare('SELECT count(*) AS count FROM work_line_events').get().count, 1);

  const reopen = setWorkLineClosed(db, {
    commandId: 'manual-records-core-reopen',
    projectId,
    worktreeId: spaceWorktreeId,
    expectedRevision: 1,
    closed: false,
  });
  assert.equal(reopen.ok, true, JSON.stringify(reopen));
  assert.equal(reopen.eventKind, 'work_line_reopened');
  assert.equal(reopen.revision, 2);

  const sourceClose = setWorkLineClosed(db, {
    commandId: 'manual-records-core-source-close',
    projectId,
    worktreeId: sourceWorktreeId,
    expectedRevision: 0,
    closed: true,
  });
  assert.equal(sourceClose.ok, true, JSON.stringify(sourceClose));
  assert.equal(sourceClose.eventKind, 'work_line_closed');

  const stale = setWorkLineClosed(db, {
    commandId: 'manual-records-core-stale',
    projectId,
    worktreeId: spaceWorktreeId,
    expectedRevision: 0,
    closed: true,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'WORK_LINE_REVISION_CONFLICT');
  assert.equal(stale.currentRevision, 2);
  assert.equal(db.prepare('SELECT count(*) AS count FROM work_line_events').get().count, 3);

  const mainRejected = setWorkLineClosed(db, {
    commandId: 'manual-records-core-main',
    projectId,
    worktreeId: mainWorktreeId,
    expectedRevision: 0,
    closed: true,
  });
  assert.equal(mainRejected.code, 'MAIN_WORK_LINE_NOT_CLOSABLE');
  const unknownRejected = setWorkLineClosed(db, {
    commandId: 'manual-records-core-unknown',
    projectId,
    worktreeId: 'manual-records-core-unknown',
    expectedRevision: 0,
    closed: true,
  });
  assert.equal(unknownRejected.code, 'WORK_LINE_NOT_FOUND');

  const beforeArchive = db.prepare('SELECT stage, status, updated_at FROM projects WHERE id = ?').get(projectId);
  const archived = setProjectArchived(db, {
    commandId: 'manual-records-core-archive',
    projectId,
    expectedRevision: 0,
    archived: true,
  });
  assert.equal(archived.ok, true, JSON.stringify(archived));
  assert.equal(archived.archiveRevision, 1);
  assert.ok(archived.archivedAt);
  const archivedRow = db.prepare('SELECT stage, status, updated_at, archived_at, archive_revision FROM projects WHERE id = ?').get(projectId);
  assert.equal(archivedRow.stage, beforeArchive.stage);
  assert.equal(archivedRow.status, beforeArchive.status);
  assert.equal(archivedRow.archive_revision, 1);
  assert.ok(archivedRow.archived_at);
  assert.notEqual(archivedRow.updated_at, beforeArchive.updated_at);

  const detailArchived = readProjectDetail(db, projectId, { limit: 100, offset: 0 });
  assert.equal(detailArchived.project.archivedAt, archived.archivedAt);
  assert.equal(detailArchived.project.archiveRevision, 1);
  assert.equal(detailArchived.timeline.items.filter((item) => item.kind === 'work_line_closed').length, 2);
  assert.equal(detailArchived.timeline.items.filter((item) => item.kind === 'work_line_reopened').length, 1);
  assert.equal(detailArchived.timeline.items.every((item) => item.kind.startsWith('work_line_') ? item.agent === null && item.actorType === 'user' : true), true);

  const restored = setProjectArchived(db, {
    commandId: 'manual-records-core-restore',
    projectId,
    expectedRevision: 1,
    archived: false,
  });
  assert.equal(restored.ok, true, JSON.stringify(restored));
  assert.equal(restored.archiveRevision, 2);
  assert.equal(restored.archivedAt, null);
  assert.equal(readProjectDetail(db, projectId).project.archivedAt, null);
  assert.equal(readWorkLineStates(db, projectId).find((row) => row.worktreeId === sourceWorktreeId).status, 'closed');
  db.close();
});

test('manual record state is readable after a child Node process rebuilds the database connection', (t) => {
  const { dbPath } = fixture(t);
  const db = openCockpitDatabase(dbPath);
  seedProject(db);
  const closed = setWorkLineClosed(db, {
    commandId: 'manual-records-process-close',
    projectId,
    worktreeId: sourceWorktreeId,
    expectedRevision: 0,
    closed: true,
  });
  const archived = setProjectArchived(db, {
    commandId: 'manual-records-process-archive',
    projectId,
    expectedRevision: 0,
    archived: true,
  });
  assert.equal(closed.ok, true);
  assert.equal(archived.ok, true);
  db.close();

  const databaseUrl = pathToFileURL(path.resolve('src/core/database.mjs')).href;
  const manualRecordsUrl = pathToFileURL(path.resolve('src/core/manual-records.mjs')).href;
  const timelineUrl = pathToFileURL(path.resolve('src/core/timeline.mjs')).href;
  const childScript = `
    import { openCockpitDatabase } from ${JSON.stringify(databaseUrl)};
    import { readWorkLineStates } from ${JSON.stringify(manualRecordsUrl)};
    import { readProjectDetail } from ${JSON.stringify(timelineUrl)};
    const db = openCockpitDatabase(process.argv[1], { migrate: false });
    const detail = readProjectDetail(db, process.argv[2], { limit: 100, offset: 0 });
    process.stdout.write(JSON.stringify({
      states: readWorkLineStates(db, process.argv[2]),
      archivedAt: detail.project.archivedAt,
      archiveRevision: detail.project.archiveRevision,
      closeEvents: detail.timeline.items.filter((item) => item.kind === 'work_line_closed').length,
    }));
    db.close();
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', childScript, dbPath, projectId], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(child.status, 0, child.stderr);
  const persisted = JSON.parse(child.stdout);
  assert.deepEqual(persisted.states.find((row) => row.worktreeId === sourceWorktreeId), {
    worktreeId: sourceWorktreeId,
    status: 'closed',
    revision: 1,
    updatedAt: closed.updatedAt,
  });
  assert.equal(persisted.archivedAt, archived.archivedAt);
  assert.equal(persisted.archiveRevision, 1);
  assert.equal(persisted.closeEvents, 1);
});

test('a command left in received state continues instead of returning an empty replay', (t) => {
  const { dbPath } = fixture(t);
  const db = openCockpitDatabase(dbPath);
  seedProject(db);

  const workLineRequest = {
    commandId: 'manual-records-received-work-line',
    projectId,
    worktreeId: spaceWorktreeId,
    expectedRevision: 0,
    closed: true,
  };
  const begunWorkLine = beginCommand(db, {
    commandId: workLineRequest.commandId,
    kind: 'work-line.state',
    request: workLineRequest,
  });
  assert.equal(begunWorkLine.command.state, 'received');
  const closed = setWorkLineClosed(db, workLineRequest);
  assert.equal(closed.ok, true, JSON.stringify(closed));
  assert.equal(closed.status, 'closed');
  assert.equal(db.prepare('SELECT state FROM commands WHERE id = ?').get(workLineRequest.commandId).state, 'committed');

  const projectRequest = {
    commandId: 'manual-records-received-project',
    projectId,
    expectedRevision: 0,
    archived: true,
  };
  const begunProject = beginCommand(db, {
    commandId: projectRequest.commandId,
    kind: 'project.archive',
    request: projectRequest,
  });
  assert.equal(begunProject.command.state, 'received');
  const archived = setProjectArchived(db, projectRequest);
  assert.equal(archived.ok, true, JSON.stringify(archived));
  assert.equal(archived.archived, true);
  assert.equal(db.prepare('SELECT state FROM commands WHERE id = ?').get(projectRequest.commandId).state, 'committed');
  db.close();
});
