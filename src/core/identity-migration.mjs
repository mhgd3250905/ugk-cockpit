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

function readLedgerRow(db, canonicalPath) {
  return db.prepare(`
    SELECT attempts, reason, first_failed_at FROM ${IDENTITY_LEDGER_TABLE} WHERE canonical_path = ?
  `).get(canonicalPath);
}

function writeLedgerRow(db, existing, row, { status, reason, attempts, firstFailedAt }) {
  const identity = row.identityFingerprint ?? row.identity_fingerprint ?? '';
  const repository = row.repositoryIdentity ?? row.repository_identity ?? '';
  const timestamp = new Date().toISOString();
  if (!existing) {
    db.prepare(`
      INSERT INTO ${IDENTITY_LEDGER_TABLE} (
        canonical_path, repository_identity, identity_fingerprint, status, reason,
        attempts, first_failed_at, last_attempt_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.canonical_path, repository, identity, status, reason,
      attempts, firstFailedAt, timestamp,
    );
    return;
  }
  db.prepare(`
    UPDATE ${IDENTITY_LEDGER_TABLE}
    SET repository_identity = ?, identity_fingerprint = ?, status = ?, reason = ?,
        attempts = ?, first_failed_at = ?, last_attempt_at = ?
    WHERE canonical_path = ?
  `).run(
    repository, identity, status, reason, attempts, firstFailedAt, timestamp, row.canonical_path,
  );
}

/**
 * A row still owed identity work, recorded as `retry`: it either failed a real
 * attempt (reason and attempt count) or was skipped because this open ran out
 * of budget. Both stay visible, because an open that judged nothing is exactly
 * the "drive offline / share dropped" shape -- reporting convergence there
 * would be the same class of lie this ledger exists to remove.
 *
 * The stored word is deliberately `retry`, not `owed`: an earlier revision of
 * this round's migration created the table with CHECK (status IN ('retry',
 * 'settled')), and `CREATE TABLE IF NOT EXISTS` cannot reshape a table some
 * database already carries. Renaming the enum in place would make every write
 * fail its CHECK, roll the pass back and leave the backlog silently empty --
 * the exact lie described above.
 */
function markOwed(db, row, error) {
  const existing = readLedgerRow(db, row.canonical_path);
  if (error) {
    writeLedgerRow(db, existing, row, {
      status: 'retry',
      reason: reasonCode(error),
      attempts: (existing?.attempts ?? 0) + 1,
      firstFailedAt: existing?.first_failed_at ?? new Date().toISOString(),
    });
    return;
  }
  writeLedgerRow(db, existing, row, {
    status: 'retry',
    reason: existing?.reason ?? 'deferred',
    attempts: existing?.attempts ?? 0,
    firstFailedAt: existing?.first_failed_at ?? null,
  });
}

function markSettled(db, row) {
  const existing = readLedgerRow(db, row.canonical_path);
  writeLedgerRow(db, existing, row, {
    status: 'settled',
    reason: null,
    attempts: existing?.attempts ?? 0,
    firstFailedAt: null,
  });
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
    ORDER BY (first_failed_at IS NULL), first_failed_at ASC, canonical_path ASC
  `).all().map((row) => ({
    canonicalPath: row.canonical_path,
    reason: row.reason,
    attempts: Number(row.attempts),
    firstFailedAt: row.first_failed_at,
    lastAttemptAt: row.last_attempt_at,
  }));
}

/**
 * Is any identity work still owed? This keeps an ordinary open from taking the
 * write lock at all: once every row is settled the pass has nothing to do, and
 * a busy database must never be able to delay or fail service start for work
 * that does not exist.
 */
export function identityRewriteOwed(db) {
  if (!hasLedger(db)) return true;
  // Either a worktree row has no matching settled entry, or the ledger holds an
  // entry for a path that is no longer registered. Both need the pass, because
  // the pass is also what prunes the orphan -- without this second half a
  // deleted worktree would leave its ledger row behind forever.
  return Boolean(db.prepare(`
    SELECT 1 AS owed
    FROM worktrees w
    LEFT JOIN ${IDENTITY_LEDGER_TABLE} l
      ON l.canonical_path = w.canonical_path
      AND l.repository_identity = w.repository_identity
      AND l.identity_fingerprint = w.identity_fingerprint
      AND l.status = 'settled'
    WHERE l.canonical_path IS NULL
    UNION ALL
    SELECT 1 AS owed
    FROM ${IDENTITY_LEDGER_TABLE} l
    WHERE l.canonical_path NOT IN (SELECT canonical_path FROM worktrees)
    LIMIT 1
  `).get());
}

export function migrateLegacyFileIdentities(db, {
  budgetMs = RECONCILE_BUDGET_MS,
  persistFailures = false,
} = {}) {
  const columnsOf = (table) => new Set(
    db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name),
  );
  const worktreeColumns = columnsOf('worktrees');
  // Ancient hand-built fixtures can predate the identity columns entirely;
  // there is nothing in them to rewrite.
  if (!worktreeColumns.has('identity_fingerprint') || !worktreeColumns.has('repository_identity')) {
    return { worktrees: 0, repositories: 0, owed: 0, deferred: 0 };
  }
  const snapshotColumns = columnsOf('snapshots');
  const projectColumns = columnsOf('projects');
  const ledger = hasLedger(db);
  const settled = ledger ? settledKeys(db) : new Set();
  const startedAt = Date.now();
  const worktreeMap = new Map();
  const repositoryMap = new Map();
  const judged = [];
  let owed = 0;
  let deferred = 0;
  let attempted = 0;
  for (const row of db.prepare(
    'SELECT canonical_path, repository_identity, identity_fingerprint FROM worktrees',
  ).all()) {
    if (ledger && settled.has(ledgerKey(row))) continue;
    // The budget counts *attempts*, not successes: the rows that fail are
    // usually the slow ones (an unreachable path stalls on its own I/O
    // timeout), so a guard keyed on successes would leave the only expensive
    // case unbounded. One row is always attempted so a backlog cannot starve.
    if (attempted > 0 && Date.now() - startedAt >= budgetMs) {
      deferred += 1;
      owed += 1;
      if (ledger && persistFailures) markOwed(db, row, null);
      continue;
    }
    attempted += 1;
    let found;
    try {
      found = scanRow(row);
    } catch (error) {
      // Unreachable path, missing git, or hostile configuration: the row keeps
      // its legacy hashes, stays owed, and is retried by a later open instead
      // of being stranded there forever. confirm-location stays the exit for a
      // genuine identity change.
      owed += 1;
      if (ledger && persistFailures) markOwed(db, row, error);
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
  if (ledger && persistFailures) {
    for (const entry of judged) markSettled(db, entry);
    // Paths that no longer belong to any worktree row must not accumulate.
    db.prepare(`
      DELETE FROM ${IDENTITY_LEDGER_TABLE}
      WHERE canonical_path NOT IN (SELECT canonical_path FROM worktrees)
    `).run();
  }
  return {
    worktrees: worktreeMap.size,
    repositories: repositoryMap.size,
    owed,
    deferred,
  };
}
