// Audit round 2026-09-26, finding 3 (P1, lost mutual exclusion).
//
// A client that lost the response retries with the identical request id, so two
// in-flight `workspace.create` drivers are a supported outcome. The repository
// lock names the *command* as its holder, so the second driver renewed the lock
// instead of being denied: two `git worktree add` calls ran against one
// repository at the same time, and the first driver to finish deleted the lock
// row the second was still relying on. `singleFlight` already gates the delivery
// and integration flows for exactly this reason.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openCockpitDatabase } from '../src/core/database.mjs';
import { EmptyFolderGrantStore } from '../src/core/folder-grants.mjs';
import { authorizeEmptyDirectory } from '../src/core/path-guard.mjs';
import { createDevelopmentWorkspace } from '../src/core/workspaces.mjs';
import { acquireRepositoryLock } from '../src/core/integrations.mjs';
import { generateStableBranchName } from '../src/git/workspace-ops.mjs';

const AT = '2026-09-26T00:00:00.000Z';

function fixture(t) {
  const base = process.platform === 'win32' ? os.tmpdir() : realpathSync(os.tmpdir());
  const root = mkdtempSync(path.join(base, 'ugk-workspace-race-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  const db = openCockpitDatabase(path.join(root, 'cockpit.db'));
  const repoDir = path.join(root, 'main-repo');
  mkdirSync(repoDir, { recursive: true });
  db.prepare(`
    INSERT INTO worktrees (id, canonical_path, repository_identity, identity_fingerprint, created_at)
    VALUES ('wt-main', ?, 'repo-id-alpha', 'fp-main', ?)
  `).run(repoDir, AT);
  db.prepare(`
    INSERT INTO projects (id, name, stage, worktree_id, status, status_reason, last_observed_at,
      created_at, updated_at, repository_identity, authorized_root)
    VALUES ('proj-1', 'Race Project', 'development', 'wt-main', 'ready', 'ready_to_start', ?, ?, ?,
      'repo-id-alpha', ?)
  `).run(AT, AT, AT, repoDir);

  const spaceDir = path.join(root, 'space-target-1');
  mkdirSync(spaceDir);
  const binding = authorizeEmptyDirectory(spaceDir);
  const grant = new EmptyFolderGrantStore({ db }).issue(binding, 'principal-user-1');
  return { db, repoDir, binding, grant };
}

function observation(target, { isMain, branch }) {
  return {
    canonicalPath: target,
    repositoryIdentity: 'repo-id-alpha',
    worktreeIdentity: isMain ? 'fp-main' : 'fp-space',
    coherence: 'coherent',
    before: { head: 'head-1', branch, hasChanges: false },
    after: { head: 'head-1', branch, hasChanges: false },
    observedAt: AT,
  };
}

// Both drivers are parked inside the Git worktree creation, which is the only
// window that matters: whatever happens next is done with two writers in one
// repository.
async function parkedDrivers(t, { commandId = 'cmd-shared-1' } = {}) {
  const { db, repoDir, binding, grant } = fixture(t);
  const branch = generateStableBranchName('proj-1', commandId);
  let created = false;
  let parked = 0;
  const releases = [];
  const options = {
    probe: async (target) => {
      if (target === repoDir) return observation(repoDir, { isMain: true, branch: 'main' });
      if (!created) throw Object.assign(new Error('not a git repository'), { code: 128 });
      return observation(binding.candidateReal, { isMain: false, branch });
    },
    createGitWorktree: async () => {
      parked += 1;
      await new Promise((resolve) => releases.push(resolve));
      created = true;
      parked -= 1;
    },
    checkBranchExists: async () => false,
    assertRepositoryAllowed: async () => {},
  };
  const request = {
    commandId,
    projectId: 'proj-1',
    name: 'race',
    grantId: grant.grantId,
    principalHash: 'principal-user-1',
    expectedBaseHead: 'head-1',
  };
  const results = Promise.all([
    createDevelopmentWorkspace(db, request, options),
    createDevelopmentWorkspace(db, request, options),
  ]);
  // Give a second driver time to join the first inside Git: on an unfixed core
  // both park within a few ticks, and the assertion below is about the count.
  for (let attempt = 0; attempt < 120 && parked < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  return { db, repoDir, parked, releases, results };
}

test('one command id drives one Git worktree creation at a time', async (t) => {
  const { db, parked, releases, results } = await parkedDrivers(t);
  assert.equal(parked, 1,
    'two drivers were inside git worktree add at once for the same command id');
  for (const release of releases) release();
  const [first, second] = await results;
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.commandId, first.commandId);
  assert.equal(second.spaceId, first.spaceId, 'the replay resolved a different space');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM development_spaces').get().c, 1);
  db.close();
});

test('a running creation keeps the repository lock against another operation', async (t) => {
  const { db, parked, releases, results } = await parkedDrivers(t);
  assert.equal(parked, 1);
  // Both callers are still awaiting the one driver, which is parked inside Git,
  // so the repository lock must still be held against anybody else.
  const locks = db.prepare('SELECT holder, operation FROM repository_locks').all();
  assert.equal(locks.length, 1, `repository_locks lost the row a driver still needed: ${JSON.stringify(locks)}`);
  const intruder = acquireRepositoryLock(db, {
    repositoryIdentity: 'repo-id-alpha',
    holder: 'cmd-intruder',
    operation: 'merge_integration',
    ttlMs: 60_000,
  });
  assert.equal(intruder.ok, false, 'another operation took the repository mid-creation');
  assert.equal(intruder.code, 'REPOSITORY_LOCKED');
  for (const release of releases) release();
  await results;
  db.close();
});

test('a same-id retry with a different body is refused, not run twice', async (t) => {
  const { db, repoDir, binding, grant } = fixture(t);
  const branch = generateStableBranchName('proj-1', 'cmd-mixed');
  let created = false;
  let inside = 0;
  let releaseInside;
  const gate = new Promise((resolve) => { releaseInside = resolve; });
  const options = {
    probe: async (target) => {
      if (target === repoDir) return observation(repoDir, { isMain: true, branch: 'main' });
      if (!created) throw Object.assign(new Error('not a git repository'), { code: 128 });
      return observation(binding.candidateReal, { isMain: false, branch });
    },
    createGitWorktree: async () => {
      inside += 1;
      await gate;
      created = true;
      inside -= 1;
    },
    checkBranchExists: async () => false,
    assertRepositoryAllowed: async () => {},
  };
  const base = {
    commandId: 'cmd-mixed',
    projectId: 'proj-1',
    grantId: grant.grantId,
    principalHash: 'principal-user-1',
    expectedBaseHead: 'head-1',
  };
  const running = createDevelopmentWorkspace(db, { ...base, name: 'first' }, options);
  for (let attempt = 0; attempt < 400 && inside < 1; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const conflicting = await createDevelopmentWorkspace(db, { ...base, name: 'second' }, options);
  assert.equal(conflicting.ok, false);
  assert.equal(conflicting.code, 'COMMAND_CONFLICT');
  releaseInside();
  assert.equal((await running).ok, true);
  db.close();
});

test('a genuine replay after completion still returns the frozen result', async (t) => {
  const { db, repoDir, binding, grant } = fixture(t);
  const branch = generateStableBranchName('proj-1', 'cmd-replay');
  let created = false;
  const options = {
    probe: async (target) => {
      if (target === repoDir) return observation(repoDir, { isMain: true, branch: 'main' });
      if (!created) throw Object.assign(new Error('not a git repository'), { code: 128 });
      return observation(binding.candidateReal, { isMain: false, branch });
    },
    createGitWorktree: async () => { created = true; },
    checkBranchExists: async () => false,
    assertRepositoryAllowed: async () => {},
  };
  const request = {
    commandId: 'cmd-replay',
    projectId: 'proj-1',
    name: 'replayed',
    grantId: grant.grantId,
    principalHash: 'principal-user-1',
    expectedBaseHead: 'head-1',
  };
  const first = await createDevelopmentWorkspace(db, request, options);
  assert.equal(first.ok, true, JSON.stringify(first));
  const replay = await createDevelopmentWorkspace(db, request, options);
  assert.equal(replay.ok, true);
  assert.equal(replay.spaceId, first.spaceId);
  assert.equal(replay.canonicalPath, first.canonicalPath);
  db.close();
});
