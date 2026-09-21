// Schema v30: rewrite device-drifted file identities in place.
//
// The worktree/repository fingerprint used to include the stat device number.
// macOS APFS volume numbers drift across reboots and OS updates, so healthy,
// untouched working copies started to compare as "replaced code" everywhere at
// once. The fingerprint now hashes only inode + birthtimeNs. For every stored
// row whose legacy hash still matches a recomputation against the CURRENT stat
// (i.e. the device never drifted and this really is the same directory), the
// hash is rewritten in place to the new format. Rows that cannot be recomputed
// exactly (device drifted, path unreachable, hostile repo config, or the
// directory genuinely changed) stay untouched and keep the user-confirmed
// confirm-location recovery path. Repeated execution is a no-op: after the
// rewrite the stored value equals the current-format hash, which never equals
// the legacy-format recomputation.
import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { gitSync } from '../git/probe.mjs';
import { assertRepositoryAllowedForProbeSync } from '../git/repository-policy.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');

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

export function migrateLegacyFileIdentities(db) {
  const columnsOf = (table) => new Set(
    db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name),
  );
  const tableExists = (name) => Boolean(db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name));
  const worktreeColumns = columnsOf('worktrees');
  // Ancient hand-built fixtures can predate the identity columns entirely;
  // there is nothing in them to rewrite.
  if (!worktreeColumns.has('identity_fingerprint') || !worktreeColumns.has('repository_identity')) {
    return { worktrees: 0, repositories: 0 };
  }
  const snapshotColumns = columnsOf('snapshots');
  const projectColumns = columnsOf('projects');
  const worktreeMap = new Map();
  const repositoryMap = new Map();
  for (const row of db.prepare(
    'SELECT canonical_path, repository_identity, identity_fingerprint FROM worktrees',
  ).all()) {
    try {
      const found = scanRow(row);
      if (found.worktree) worktreeMap.set(found.worktree[0], found.worktree[1]);
      if (found.repository) repositoryMap.set(found.repository[0], found.repository[1]);
    } catch {
      // Unreachable path, missing git, or hostile configuration: leave the
      // row in its legacy format. confirm-location remains the only exit.
    }
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
    if (tableExists('repository_locks')) {
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
    if (tableExists('workspace_lifecycle_reservations')) {
      try {
        db.prepare('UPDATE workspace_lifecycle_reservations SET repository_identity = ? WHERE repository_identity = ?')
          .run(newValue, oldValue);
      } catch {
        // A live reservation under a colliding key must never be dropped; the
        // old-key row fails closed and its owning process is fenced anyway.
      }
    }
  }
  return { worktrees: worktreeMap.size, repositories: repositoryMap.size };
}
