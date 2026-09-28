import { withDeadline } from '../scripts/test-support/deadline.mjs';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, realpathSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { EmptyFolderGrantStore } from '../src/core/folder-grants.mjs';
import { authorizeEmptyDirectory } from '../src/core/path-guard.mjs';
import { acquireRepositoryLock } from '../src/core/integrations.mjs';
import { createDevelopmentWorkspace } from '../src/core/workspaces.mjs';
import { probeGitWorktree, safeGitEnvironment, SAFE_GIT_PREFIX } from '../src/git/probe.mjs';

const execFileAsync = promisify(execFile);

async function runGit(cwd, args) {
  return (await execFileAsync('git', [...SAFE_GIT_PREFIX, ...args], {
    cwd, windowsHide: true, shell: false, encoding: 'utf8', env: safeGitEnvironment(),
  })).stdout.trim();
}

function fixtureTempRoot() {
  return process.platform === 'win32' ? os.tmpdir() : realpathSync(os.tmpdir());
}

async function fixture(t) {
  const root = mkdtempSync(path.join(fixtureTempRoot(), 'ugk-cockpit-create-race-'));
  const db = openCockpitDatabase(path.join(root, 'cockpit.db'));
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const repoDir = path.join(root, 'main-repo');
  mkdirSync(repoDir, { recursive: true });
  await runGit(repoDir, ['init', '-b', 'main']);
  await runGit(repoDir, ['config', 'user.name', 'Test User']);
  await runGit(repoDir, ['config', 'user.email', 'test@example.com']);
  writeFileSync(path.join(repoDir, 'README.md'), '# Main Repo\n');
  await runGit(repoDir, ['add', 'README.md']);
  await runGit(repoDir, ['commit', '-m', 'Initial commit']);

  const observation = await probeGitWorktree(repoDir);
  const at = new Date().toISOString();
  db.prepare(`
    INSERT INTO worktrees (id, canonical_path, repository_identity, identity_fingerprint, created_at)
    VALUES ('wt-main', ?, ?, ?, ?)
  `).run(observation.canonicalPath, observation.repositoryIdentity, observation.worktreeIdentity, at);
  db.prepare(`
    INSERT INTO projects (
      id, name, stage, worktree_id, status, status_reason,
      last_observed_at, created_at, updated_at, repository_identity, authorized_root
    ) VALUES ('proj-1', 'Create Race Project', 'development',
      'wt-main', 'ready', 'ready_to_start', ?, ?, ?, ?, ?)
  `).run(at, at, at, observation.repositoryIdentity, observation.canonicalPath);

  const spacePath = path.join(root, 'space-race');
  mkdirSync(spacePath);
  const grantStore = new EmptyFolderGrantStore({ db });
  const grant = grantStore.issue(authorizeEmptyDirectory(spacePath), 'principal-race');
  const request = {
    commandId: 'cmd-create-race',
    projectId: 'proj-1',
    name: 'race-space',
    grantId: grant.grantId,
    principalHash: 'principal-race',
    expectedBaseHead: observation.after.head,
  };
  return { db, request, repositoryIdentity: observation.repositoryIdentity, observation, spacePath };
}

const lockRow = (db, repositoryIdentity) => db.prepare(
  'SELECT holder, operation, lock_id FROM repository_locks WHERE repository_identity = ?',
).get(repositoryIdentity);

// A client that lost the response retries with the same command id. Both drivers
// then hold the same holder string: the journal replays, acquireRepositoryLock
// renews instead of denying, and whichever finishes first deletes the single
// repository_locks row the other is still working under.
test('同一 commandId 的新建空间并发重放：先完成的一方不得解除另一方还在使用的仓库锁', async (t) => {
  const f = await fixture(t);
  let markParked, markResume;
  const parked = new Promise((resolve) => { markParked = resolve; });
  const resumed = new Promise((resolve) => { markResume = resolve; });
  let parkedOnce = false;
  const parkingProbe = async (target) => {
    if (!parkedOnce) {
      parkedOnce = true;
      markParked();
      await resumed;
    }
    return probeGitWorktree(target);
  };

  const driverA = createDevelopmentWorkspace(f.db, f.request, { probe: parkingProbe });
  // A is now parked inside its first awaited probe, i.e. after the lock.
  await withDeadline(parked, 20_000, () => { throw new Error('driver A never reached the probe'); });
  const heldByA = lockRow(f.db, f.repositoryIdentity);
  assert.equal(heldByA?.holder, f.request.commandId, JSON.stringify(heldByA));

  const driverB = createDevelopmentWorkspace(f.db, f.request, { probe: probeGitWorktree });
  // Give the second driver time to run to completion (it does, when the entry
  // point is not gated: it renews the same holder and releases it in finally).
  const bSettled = await withDeadline(
    driverB.then((value) => ({ settled: true, value })),
    3_000, () => ({ settled: false }),
  );

  const stillHeld = lockRow(f.db, f.repositoryIdentity);
  assert.ok(stillHeld,
    `the repository lock vanished while a driver was still working in it (B settled: ${bSettled.settled})`);
  assert.equal(stillHeld.holder, f.request.commandId, JSON.stringify(stillHeld));
  const intruder = acquireRepositoryLock(f.db, {
    repositoryIdentity: f.repositoryIdentity,
    holder: 'cmd-another-writer',
    operation: 'remove_workspace',
  });
  assert.equal(intruder.ok, false, JSON.stringify(intruder));
  assert.equal(intruder.code, 'REPOSITORY_LOCKED', JSON.stringify(intruder));

  markResume();
  const [resultA, resultB] = await Promise.all([driverA, driverB]);
  assert.equal(resultA.ok, true, JSON.stringify(resultA));
  // The replayed driver answers with the same receipt, not a second workspace.
  assert.deepEqual(resultB, resultA);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM development_spaces').get().n, 1,
    'one command id must create exactly one development space');
  assert.equal(lockRow(f.db, f.repositoryIdentity), undefined,
    'the lock is released once both drivers are done');
});
