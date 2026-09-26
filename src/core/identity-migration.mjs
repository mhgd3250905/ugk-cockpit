// Schema v30: rewrite device-drifted file identities in place, and finish the
// job on a later open when it could not be finished now.
//
// The worktree/repository fingerprint used to include the stat device number.
// macOS APFS volume numbers drift across reboots and OS updates, so healthy,
// untouched working copies started to compare as "replaced code" everywhere at
// once. The fingerprint now hashes only inode + birthtimeNs. For every stored
// row whose legacy hash still matches a recomputation against the CURRENT stat
// (i.e. the device never drifted and this really is the same directory), the
// hash is rewritten in place to the new format. Rows that cannot be recomputed
// exactly (the device genuinely drifted, or the directory was replaced) stay
// untouched and keep the user-confirmed confirm-location recovery path.
//
// Stamping user_version says the *schema* is current; it does not say this
// per-row work converged. A row can fail for a purely transient reason (a drive
// letter offline for one start, a share that dropped, git not on PATH yet,
// hostile configuration the user removes afterwards). AGENTS.md requires
// migrations to be repeatable, so the rewrite also runs on every open, driven
// by a per-row ledger: rows that could not be judged stay in the backlog and
// are retried, rows judged successfully are marked settled and never touched
// again -- which also stops an unreconstructable row from costing a git probe
// on every service start.
import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { gitSync } from '../git/probe.mjs';
import { assertRepositoryAllowedForProbeSync } from '../git/repository-policy.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');

export const IDENTITY_LEDGER_TABLE = 'identity_migration_state';
// One open may only spend this much time on identity work before deferring the
// rest. A dead network share can stall a single stat for its own I/O timeout;
// the budget bounds how *many* rows one start attempts, not whether they ever
// converge.
export const RECONCILE_BUDGET_MS = 5_000;

export function legacyIdentityPair(details) {
  const evidence = {
    device: details.dev.toString(),
    inode: details.ino.toString(),
    birthtimeNs: details.birthtimeNs.toString(),
  };
  return {
    legacy: digest(JSON.stringify(evidence)),
    current: digest(JSON.stringify({
      inode: evidence.inode,
      birthtimeNs: evidence.birthtimeNs,
    })),
  };
}

export function statIdentityPair(targetPath) {
  return legacyIdentityPair(statSync(targetPath, { bigint: true }));
}

export function gitCommonDirectorySync(cwd) {
  const value = gitSync(cwd, ['rev-parse', '--git-common-dir']).stdout;
  if (!value) return null;
  const resolved = path.isAbsolute(value) ? value : path.resolve(cwd, value);
  try {
    return realpathSync.native(resolved);
  } catch {
    return null;
  }
}

function scanRow(row) {
  const directory = statIdentityPair(row.canonical_path);
  const found = { worktree: null, repository: null };
  if (row.identity_fingerprint && row.identity_fingerprint === directory.legacy) {
    found.worktree = [directory.legacy, directory.current];
  }
  if (row.repository_identity.startsWith('folder:')) {
    if (row.repository_identity === `folder:${directory.legacy}`) {
      found.repository = [`folder:${directory.legacy}`, `folder:${directory.current}`];
    }
    return found;
  }
  // A row whose worktree fingerprint already equals the current-format
  // recomputation was written by post-change code; its repository identity
  // shares that generation, so no git probing is needed.
  if (row.identity_fingerprint && row.identity_fingerprint === directory.current) {
    return found;
  }
  // The gate mirrors every other Git entry point: a repository that carries
  // hostile configuration is never probed, even for a read-only rev-parse.
  assertRepositoryAllowedForProbeSync(row.canonical_path);
  const commonDir = gitCommonDirectorySync(row.canonical_path);
  if (!commonDir) return found;
  const repository = statIdentityPair(commonDir);
  if (row.repository_identity === repository.legacy) {
    found.repository = [repository.legacy, repository.current];
  }
  return found;
}

function tableExists(db, name) {
  return Boolean(db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name));
}

function hasLedger(db) {
  return tableExists(db, IDENTITY_LEDGER_TABLE);
}

// A ledger entry records the hashes the row carried when it was judged. If a
// later rewrite or confirm-location changes them, the entry stops matching and
// the row is judged again: a settled entry can only ever suppress redundant
// work, never hide a change that still needs making.
function ledgerKey(row) {
  return `${row.canonical_path}\0${row.repository_identity}\0${row.identity_fingerprint}`;
}

function settledKeys(db) {
  return new Set(
    db.prepare(`SELECT canonical_path, repository_identity, identity_fingerprint
      FROM ${IDENTITY_LEDGER_TABLE} WHERE status = 'settled'`).all().map(ledgerKey),
  );
}

function reasonCode(error) {
  const code = typeof error?.code === 'string' ? error.code : (error?.name ?? 'UNKNOWN');
  return code.slice(0, 64);
}

function upsertLedger(db, row, status, reason) {
  const timestamp = new Date().toISOString();
  const identity = row.identityFingerprint ?? row.identity_fingerprint ?? '';
  const repository = row.repositoryIdentity ?? row.repository_identity ?? '';
  const existing = db.prepare(`
    SELECT first_failed_at FROM ${IDENTITY_LEDGER_TABLE} WHERE canonical_path = ?
  `).get(row.canonical_path);
  if (!existing) {
    db.prepare(`
      INSERT INTO ${IDENTITY_LEDGER_TABLE} (
        canonical_path, repository_identity, identity_fingerprint, status, reason,
        attempts, first_failed_at, last_attempt_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.canonical_path, repository, identity, status, reason,
      status === 'retry' ? 1 : 0, status === 'retry' ? timestamp : null, timestamp,
    );
    return;
  }
  db.prepare(`
    UPDATE ${IDENTITY_LEDGER_TABLE}
    SET repository_identity = ?, identity_fingerprint = ?, status = ?, reason = ?,
        attempts = attempts + ?, first_failed_at = ?, last_attempt_at = ?
    WHERE canonical_path = ?
  `).run(
    repository, identity, status, reason,
    status === 'retry' ? 1 : 0,
    status === 'retry' ? (existing.first_failed_at ?? timestamp) : null,
    timestamp, row.canonical_path,
  );
}

/**
 * Rows whose identity rewrite is still owed: the durable answer to "has the
 * identity migration converged?", and the reason a later open retries them.
 */
export function identityMigrationBacklog(db) {
  if (!hasLedger(db)) return [];
  return db.prepare(`
    SELECT canonical_path, reason, attempts, first_failed_at, last_attempt_at
    FROM ${IDENTITY_LEDGER_TABLE} WHERE status = 'retry'
    ORDER BY first_failed_at ASC, canonical_path ASC
  `).all().map((row) => ({
    canonicalPath: row.canonical_path,
    reason: row.reason,
    attempts: Number(row.attempts),
    firstFailedAt: row.first_failed_at,
    lastAttemptAt: row.last_attempt_at,
  }));
}

export function migrateLegacyFileIdentities(db, { budgetMs = RECONCILE_BUDGET_MS } = {}) {
  const columnsOf = (table) => new Set(
    db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name),
  );
  const worktreeColumns = columnsOf('worktrees');
  // Ancient hand-built fixtures can predate the identity columns entirely;
  // there is nothing in them to rewrite.
  if (!worktreeColumns.has('identity_fingerprint') || !worktreeColumns.has('repository_identity')) {
    return { worktrees: 0, repositories: 0, deferred: 0 };
  }
  const snapshotColumns = columnsOf('snapshots');
  const projectColumns = columnsOf('projects');
  const ledger = hasLedger(db);
  const settled = ledger ? settledKeys(db) : new Set();
  const startedAt = Date.now();
  const worktreeMap = new Map();
  const repositoryMap = new Map();
  const judged = [];
  let deferred = 0;
  for (const row of db.prepare(
    'SELECT canonical_path, repository_identity, identity_fingerprint FROM worktrees',
  ).all()) {
    if (ledger && settled.has(ledgerKey(row))) continue;
    // Always attempt at least one row, then stop within budget and let a later
    // open pick up what is left.
    if (judged.length > 0 && Date.now() - startedAt >= budgetMs) {
      deferred += 1;
      continue;
    }
    let found;
    try {
      found = scanRow(row);
    } catch (error) {
      // Unreachable path, missing git, or hostile configuration: the row keeps
      // its legacy hashes, enters the backlog, and is retried by a later open
      // instead of being stranded there forever. confirm-location stays the
      // exit for a genuine identity change.
      if (ledger) upsertLedger(db, row, 'retry', reasonCode(error));
      continue;
    }
    if (found.worktree) worktreeMap.set(found.worktree[0], found.worktree[1]);
    if (found.repository) repositoryMap.set(found.repository[0], found.repository[1]);
    judged.push({
      canonical_path: row.canonical_path,
      identityFingerprint: found.worktree ? found.worktree[1] : row.identity_fingerprint,
      repositoryIdentity: found.repository ? found.repository[1] : row.repository_identity,
    });
  }

  for (const [oldValue, newValue] of worktreeMap) {
    db.prepare('UPDATE worktrees SET identity_fingerprint = ? WHERE identity_fingerprint = ?')
      .run(newValue, oldValue);
    if (snapshotColumns.has('worktree_identity')) {
      db.prepare('UPDATE snapshots SET worktree_identity = ? WHERE worktree_identity = ?')
        .run(newValue, oldValue);
    }
  }
  for (const [oldValue, newValue] of repositoryMap) {
    db.prepare('UPDATE worktrees SET repository_identity = ? WHERE repository_identity = ?')
      .run(newValue, oldValue);
    if (projectColumns.has('repository_identity')) {
      db.prepare('UPDATE projects SET repository_identity = ? WHERE repository_identity = ?')
        .run(newValue, oldValue);
    }
    if (snapshotColumns.has('repository_identity')) {
      db.prepare('UPDATE snapshots SET repository_identity = ? WHERE repository_identity = ?')
        .run(newValue, oldValue);
    }
    if (tableExists(db, 'repository_locks')) {
      try {
        db.prepare('UPDATE repository_locks SET repository_identity = ? WHERE repository_identity = ?')
          .run(newValue, oldValue);
      } catch {
        // Primary-key collision (a lock already exists under the new identity).
        // Drop only the expired orphan; a live collision stays fail-closed.
        db.prepare('DELETE FROM repository_locks WHERE repository_identity = ? AND expires_at <= ?')
          .run(oldValue, Date.now());
      }
    }
    if (tableExists(db, 'workspace_lifecycle_reservations')) {
      try {
        db.prepare('UPDATE workspace_lifecycle_reservations SET repository_identity = ? WHERE repository_identity = ?')
          .run(newValue, oldValue);
      } catch {
        // A live reservation under a colliding key must never be dropped; the
        // old-key row fails closed and its owning process is fenced anyway.
      }
    }
  }
  // Bookkeeping happens after the rewrites so a settled row records the hashes
  // it now actually carries; the next open then skips the row outright.
  for (const entry of judged) {
    if (ledger) upsertLedger(db, entry, 'settled', null);
  }
  if (ledger) {
    // Paths that no longer belong to any worktree row must not accumulate.
    db.prepare(`
      DELETE FROM ${IDENTITY_LEDGER_TABLE}
      WHERE canonical_path NOT IN (SELECT canonical_path FROM worktrees)
    `).run();
  }
  return { worktrees: worktreeMap.size, repositories: repositoryMap.size, deferred };
}
