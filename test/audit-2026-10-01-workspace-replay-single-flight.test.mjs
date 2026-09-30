import { withDeadline } from '../scripts/test-support/deadline.mjs';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { EmptyFolderGrantStore } from '../src/core/folder-grants.mjs';
import { authorizeEmptyDirectory } from '../src/core/path-guard.mjs';
import { acquireRepositoryLock } from '../src/core/integrations.mjs';
import {
  createDevelopmentWorkspace,
  removeDevelopmentWorkspace,
  reuseDevelopmentWorkspace,
} from '../src/core/workspaces.mjs';
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
  const root = mkdtempSync(path.join(fixtureTempRoot(), 'ugk-cockpit-replay-gate-'));
  const db = openCockpitDatabase(path.join(root, 'cockpit.db'));
  // One hook, ordered: node:test runs t.after callbacks FIFO, so removing the
  // directory before closing SQLite would hit an open handle on Windows.
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
    ) VALUES ('proj-1', 'Replay Gate Project', 'development',
      'wt-main', 'ready', 'ready_to_start', ?, ?, ?, ?, ?)
  `).run(at, at, at, observation.repositoryIdentity, observation.canonicalPath);

  const spacePath = path.join(root, 'space-a');
  mkdirSync(spacePath);
  const grantStore = new EmptyFolderGrantStore({ db });
  const grant = grantStore.issue(authorizeEmptyDirectory(spacePath), 'principal-a');
  const created = await createDevelopmentWorkspace(db, {
    commandId: 'cmd-create-replay',
    projectId: 'proj-1',
    name: 'replay-space',
    grantId: grant.grantId,
    principalHash: 'principal-a',
    expectedBaseHead: observation.after.head,
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  return {
    db, repoDir, observation,
    repositoryIdentity: observation.repositoryIdentity,
    spaceId: created.spaceId,
    spacePath,
    revision: created.space.revision,
  };
}

const lockRow = (db, repositoryIdentity) => db.prepare(
  'SELECT holder, operation, lock_id FROM repository_locks WHERE repository_identity = ?',
).get(repositoryIdentity);

// Park the first driver inside the first probe that runs after it has taken the
// persistent repository lock, so the second driver is genuinely concurrent.
function parkingProbe(gateA) {
  let parked = false;
  return async (target) => {
    if (!parked) {
      parked = true;
      gateA.fireParked();
      await gateA.resumed;
    }
    return probeGitWorktree(target);
  };
}

function gate() {
  let fireParked, fireResume;
  const parked = new Promise((resolve) => { fireParked = resolve; });
  const resumed = new Promise((resolve) => { fireResume = resolve; });
  return { parked, resumed, fireParked, fireResume };
}

// removeDevelopmentWorkspace takes holder = request.commandId, which is the one
// string a lost-response retry repeats verbatim. Two drivers then share a holder:
// acquireRepositoryLock renews instead of denying, and whichever finishes first
// deletes the single repository_locks row the other is still working under, so
// `git worktree remove` keeps running with no exclusivity over the repository.
test('同一 commandId 的删除空间并发重放：先完成的一方不得解除另一方还在使用的仓库锁', async (t) => {
  const f = await fixture(t);
  const request = {
    commandId: 'cmd-remove-replay',
    projectId: 'proj-1',
    spaceId: f.spaceId,
    expectedRevision: f.revision,
  };
  const gateA = gate();
  const driverA = removeDevelopmentWorkspace(f.db, request, { probe: parkingProbe(gateA) });
  await withDeadline(gateA.parked, 30_000, () => {
    throw new Error('driver A never reached its post-lock probe');
  });

  const heldByA = lockRow(f.db, f.repositoryIdentity);
  assert.equal(heldByA?.holder, request.commandId, JSON.stringify(heldByA));

  const driverB = removeDevelopmentWorkspace(f.db, request, { probe: probeGitWorktree });
  const bSettled = await withDeadline(
    driverB.then((value) => ({ settled: true, value })),
    5_000, () => ({ settled: false }),
  );

  const stillHeld = lockRow(f.db, f.repositoryIdentity);
  assert.ok(stillHeld,
    `the repository lock vanished while driver A was still working in it `
    + `(driver B settled early: ${bSettled.settled})`);
  assert.equal(stillHeld.holder, request.commandId, JSON.stringify(stillHeld));

  const intruder = acquireRepositoryLock(f.db, {
    repositoryIdentity: f.repositoryIdentity,
    holder: 'cmd-another-writer',
    operation: 'merge_submission',
  });
  assert.equal(intruder.ok, false,
    `another writer entered the repository while a removal was in flight: ${JSON.stringify(intruder)}`);

  gateA.fireResume();
  await Promise.allSettled([driverA, driverB]);
});

test('同一 commandId 的复用空间并发重放：同样不得共享并可被解除的仓库锁', async (t) => {
  const f = await fixture(t);
  const request = {
    commandId: 'cmd-reuse-replay',
    projectId: 'proj-1',
    spaceId: f.spaceId,
    expectedRevision: f.revision,
    expectedBaseHead: f.observation.after.head,
  };
  const gateA = gate();
  const driverA = reuseDevelopmentWorkspace(f.db, request, { probe: parkingProbe(gateA) });
  await withDeadline(gateA.parked, 30_000, () => {
    throw new Error('driver A never reached its post-lock probe');
  });

  const heldByA = lockRow(f.db, f.repositoryIdentity);
  assert.equal(heldByA?.holder, request.commandId, JSON.stringify(heldByA));

  const driverB = reuseDevelopmentWorkspace(f.db, request, { probe: probeGitWorktree });
  const bSettled = await withDeadline(
    driverB.then((value) => ({ settled: true, value })),
    5_000, () => ({ settled: false }),
  );

  const stillHeld = lockRow(f.db, f.repositoryIdentity);
  assert.ok(stillHeld,
    `the repository lock vanished while driver A was still working in it `
    + `(driver B settled early: ${bSettled.settled})`);
  assert.equal(stillHeld.holder, request.commandId, JSON.stringify(stillHeld));

  gateA.fireResume();
  await Promise.allSettled([driverA, driverB]);
});

// Reverse control, green on the current main branch: the supported shape is a
// retry that arrives AFTER the first driver has settled. It must be answered from
// the durable journal without touching Git a second time, and must not leave a
// lock behind. The in-process gate being added for the concurrent shape must not
// change any of this.
test('反向对照：先后到达的同 commandId 重放只回放流水、不再触碰 Git 且不残留锁', async (t) => {
  const f = await fixture(t);
  const request = {
    commandId: 'cmd-remove-sequential',
    projectId: 'proj-1',
    spaceId: f.spaceId,
    expectedRevision: f.revision,
  };
  let probes = 0;
  const countingProbe = async (target) => { probes += 1; return probeGitWorktree(target); };

  const first = await removeDevelopmentWorkspace(f.db, request, { probe: countingProbe });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(existsSync(f.spacePath), false, 'the workspace directory is removed');
  assert.equal(lockRow(f.db, f.repositoryIdentity), undefined, 'no lock is left behind');
  const probesAfterFirst = probes;
  assert.ok(probesAfterFirst > 0, 'the first removal must have probed Git at least once');

  const replay = await removeDevelopmentWorkspace(f.db, request, { probe: countingProbe });
  assert.equal(probes, probesAfterFirst,
    `a journaled replay must not re-run the effect (probes ${probesAfterFirst} -> ${probes})`);
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.deepEqual(replay, first, 'the replay answers with the same receipt');
  assert.equal(lockRow(f.db, f.repositoryIdentity), undefined, 'a replay must not leave a lock');
});
