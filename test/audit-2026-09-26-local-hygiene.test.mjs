// Audit round 2026-09-26, findings 9 and 10 (local hygiene).
//
// 9. Every accepted folder mints a grant row holding an absolute path, its
//    canonical path and the principal hash, and nothing ever deleted a spent
//    one: the table grew without bound for the life of the installation.
// 10. `--data-directory` is required to be absolute, but the environment
//    derived default (`LOCALAPPDATA` / `XDG_DATA_HOME`) was joined unchecked, so
//    a relative value silently resolves against the current working directory —
//    the service then opens a different, usually empty database, which is the
//    "empty project list next to real records" failure AGENTS.md calls out.
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  FOLDER_GRANT_RETENTION_MS,
  openCockpitDatabase,
  pruneSpentFolderGrants,
} from '../src/core/database.mjs';
import { EmptyFolderGrantStore, FolderGrantStore } from '../src/core/folder-grants.mjs';
import { resolveDataDirectory } from '../src/core/data-directory.mjs';

function tempRoot(t) {
  const base = process.platform === 'win32' ? os.tmpdir() : realpathSync(os.tmpdir());
  const root = mkdtempSync(path.join(base, 'ugk-hygiene-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  return root;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function seedGrant(db, { id, state, createdOffsetMs, expiresAt }) {
  db.prepare(`
    INSERT INTO folder_grants (
      id, principal_hash, folder_path, canonical_path, repository_identity,
      worktree_identity, state, claimed_by_command, expires_at, created_at
    ) VALUES (?, 'principal-hash', ?, ?, 'repo-1', 'wt-1', ?, ?, ?, ?)
  `).run(id, `C:\\projects\\${id}`, `C:\\projects\\${id}`, state,
    state === 'active' ? null : 'cmd-1', expiresAt,
    new Date(Date.now() - createdOffsetMs).toISOString());
}

test('spent and lapsed grants are pruned, live and claimed ones are kept', (t) => {
  const db = openCockpitDatabase(path.join(tempRoot(t), 'cockpit.db'));
  const now = Date.now();
  seedGrant(db, { id: 'fresh-consumed', state: 'consumed', createdOffsetMs: 60_000, expiresAt: now + 60_000 });
  seedGrant(db, { id: 'old-consumed', state: 'consumed', createdOffsetMs: DAY_MS + FOLDER_GRANT_RETENTION_MS, expiresAt: now });
  seedGrant(db, { id: 'old-active', state: 'active', createdOffsetMs: DAY_MS + FOLDER_GRANT_RETENTION_MS, expiresAt: now - FOLDER_GRANT_RETENTION_MS });
  seedGrant(db, { id: 'live-active', state: 'active', createdOffsetMs: 60_000, expiresAt: now + 5 * 60_000 });
  seedGrant(db, { id: 'crashed-claimed', state: 'claimed', createdOffsetMs: DAY_MS + FOLDER_GRANT_RETENTION_MS, expiresAt: now - FOLDER_GRANT_RETENTION_MS });

  const removed = pruneSpentFolderGrants(db);
  const left = db.prepare('SELECT id FROM folder_grants ORDER BY id').all().map((row) => row.id);
  assert.equal(removed, 2, JSON.stringify(left));
  assert.deepEqual(left, ['crashed-claimed', 'fresh-consumed', 'live-active']);
  db.close();
});

test('the empty-folder grant table is pruned too, at database open', (t) => {
  const root = tempRoot(t);
  const dbPath = path.join(root, 'cockpit.db');
  const db = openCockpitDatabase(dbPath);
  const stale = Date.now() - DAY_MS - FOLDER_GRANT_RETENTION_MS;
  for (const state of ['consumed', 'active', 'claimed']) {
    db.prepare(`
      INSERT INTO empty_folder_grants (
        id, principal_hash, folder_path, canonical_path, file_identity, state,
        claimed_by_command, expires_at, created_at
      ) VALUES (?, 'principal-hash', 'C:\\empty', 'C:\\empty', 'file-id', ?, 'cmd-1', ?, ?)
    `).run(`empty-${state}`, state, stale, new Date(stale).toISOString());
  }
  db.close();

  // Reopening is what the running service does: the sweep runs on open.
  const reopened = openCockpitDatabase(dbPath);
  const left = reopened.prepare('SELECT id FROM empty_folder_grants ORDER BY id').all().map((row) => row.id);
  assert.deepEqual(left, ['empty-claimed']);
  assert.equal(reopened.prepare('SELECT COUNT(*) AS c FROM folder_grants').get().c, 0);
  reopened.close();
});

test('a fresh installation opens with no grant rows to prune', (t) => {
  const db = openCockpitDatabase(path.join(tempRoot(t), 'fresh.db'));
  assert.equal(pruneSpentFolderGrants(db), 0);
  db.close();
});

test('the stores keep working across the sweep', (t) => {
  const root = tempRoot(t);
  const db = openCockpitDatabase(path.join(root, 'cockpit.db'));
  const clockValues = [0];
  let nowMs = 1_800_000_000_000;
  const store = new EmptyFolderGrantStore({ db, clock: () => nowMs });
  const issued = store.issue({
    folderPath: path.join(root, 'a'),
    canonicalPath: path.join(root, 'a'),
    fileIdentity: 'identity-a',
  }, 'principal-1');
  const claimed = store.claim(issued.grantId, 'cmd-a', 'principal-1');
  assert.equal(claimed.id, issued.grantId);
  store.complete(issued.grantId, 'cmd-a');
  // Still replayable inside the retention window.
  assert.throws(() => store.claim(issued.grantId, 'cmd-a', 'principal-1'), { code: 'FOLDER_GRANT_CONSUMED' });
  nowMs += DAY_MS + FOLDER_GRANT_RETENTION_MS + 1000;
  assert.equal(pruneSpentFolderGrants(db, nowMs), 1);
  assert.throws(() => store.claim(issued.grantId, 'cmd-a', 'principal-1'), { code: 'FOLDER_GRANT_EXPIRED' });
  assert.equal(clockValues.length, 1);
  db.close();
});

test('FolderGrantStore issues against the same pruned table', (t) => {
  const db = openCockpitDatabase(path.join(tempRoot(t), 'cockpit.db'));
  const store = new FolderGrantStore({ db });
  const issued = store.issue({
    folderPath: 'C:\\projects\\x',
    canonicalPath: 'C:\\projects\\x',
    repositoryIdentity: 'repo-1',
    worktreeIdentity: 'wt-1',
  }, 'principal-1');
  assert.ok(issued.grantId);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM folder_grants').get().c, 1);
  db.close();
});

test('the sweep tolerates a database without the grant tables', (t) => {
  // The grant tables arrive in migration 6, so a partially migrated or
  // hand-built database may not have them; preparing the DELETE against a missing
  // table is itself an error, and hygiene must never be the reason a data
  // directory cannot be opened. `test/phase0/migration.test.mjs` covers the same
  // case end to end through `openCockpitDatabase` (it is what this round's first
  // full-suite run caught).
  const bare = new DatabaseSync(path.join(tempRoot(t), 'bare.db'));
  try {
    assert.equal(pruneSpentFolderGrants(bare), 0);
    bare.exec('CREATE TABLE unrelated (id TEXT)');
    assert.equal(pruneSpentFolderGrants(bare), 0);
  } finally {
    bare.close();
  }
});

test('a relative environment data base is refused instead of resolving under cwd', () => {
  const home = path.join(process.platform === 'win32' ? 'C:\\Users\\op' : '/home', 'op');
  assert.throws(
    () => resolveDataDirectory({ argv: [], env: { LOCALAPPDATA: 'AppData/Local' }, platform: 'win32', homedir: () => home }),
    /LOCALAPPDATA must be an absolute path/u,
  );
  assert.throws(
    () => resolveDataDirectory({ argv: [], env: { XDG_DATA_HOME: '.local/share' }, platform: 'linux', homedir: () => home }),
    /XDG_DATA_HOME must be an absolute path/u,
  );
  assert.throws(
    () => resolveDataDirectory({ argv: [], env: {}, platform: 'linux', homedir: () => 'relative/home' }),
    /must be an absolute path/u,
  );
});

test('absolute environment data bases still resolve as before', () => {
  const home = process.platform === 'win32' ? 'C:\\Users\\op' : '/home/op';
  // A forward-slash base is absolute on every platform, so this assertion means
  // the same thing on the Linux/macOS runners the product claims to support.
  assert.equal(
    resolveDataDirectory({ argv: [], env: { LOCALAPPDATA: '/AppData/Local' }, platform: 'win32', homedir: () => home }),
    path.join('/AppData/Local', 'UGK Cockpit'),
  );
  assert.equal(
    resolveDataDirectory({ argv: [], env: { XDG_DATA_HOME: '/srv/ugk-data' }, platform: 'linux', homedir: () => home }),
    path.join('/srv/ugk-data', 'UGK Cockpit'),
  );
  assert.equal(
    resolveDataDirectory({ argv: [], env: {}, platform: 'linux', homedir: () => home }),
    path.join(home, '.local', 'share', 'UGK Cockpit'),
  );
  assert.equal(
    resolveDataDirectory({ argv: ['--data-directory', '/explicit/dir'], env: {}, platform: 'linux', homedir: () => home }),
    path.resolve('/explicit/dir'),
  );
});
