import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { registerProject, worktreeIdFor } from '../src/core/projects.mjs';
import { startWriteRun } from '../src/core/runs.mjs';
import { readCommand } from '../src/core/command-journal.mjs';

const tmpRoot = () => (process.platform === 'win32' ? os.tmpdir() : realpathSync(os.tmpdir()));

function observation(overrides = {}) {
  return {
    canonicalPath: '/fixture/rebound',
    repositoryIdentity: 'repository-one',
    worktreeIdentity: 'worktree-one',
    observedAt: '2026-09-01T00:00:00.000Z',
    coherence: 'coherent',
    after: { hasChanges: false },
    ...overrides,
  };
}

function snapshot(obs) {
  return {
    head: 'head-one', branch: 'main', indexFingerprint: 'index-one',
    worktreeFingerprint: 'worktree-one', repositoryIdentity: obs.repositoryIdentity,
    worktreeIdentity: obs.worktreeIdentity, headRelation: 'same', coherence: obs.coherence,
    observedAt: obs.observedAt,
  };
}

// worktrees.id is a hash of the identity fingerprint taken at registration
// time, and both the schema 30 migration and confirm-location rewrite that
// fingerprint in place without touching the id. Every consumer that recomputes
// the id from a fresh observation therefore stops matching the durable row.
test('a rebound location stays registerable and startable for write sessions', async (t) => {
  const root = mkdtempSync(path.join(tmpRoot(), 'ugk-rebind-'));
  const db = openCockpitDatabase(path.join(root, 'cockpit.db'));
  t.after(() => {
    try { db.close(); } catch {}
    rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  });
  const legacy = observation();
  const registered = registerProject(db, {
    commandId: 'reg-legacy', name: 'Rebind fixture', authorizedRoot: legacy.canonicalPath,
    observation: legacy,
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  const storedId = db.prepare('SELECT worktree_id FROM projects WHERE id = ?')
    .get(registered.projectId).worktree_id;
  assert.equal(storedId, worktreeIdFor(legacy.worktreeIdentity));

  // Exactly what the v30 migration and confirm-location persist: same row,
  // same id, new fingerprint and repository identity.
  const current = observation({ repositoryIdentity: 'repository-two', worktreeIdentity: 'worktree-two' });
  db.prepare('UPDATE worktrees SET repository_identity = ?, identity_fingerprint = ? WHERE id = ?')
    .run(current.repositoryIdentity, current.worktreeIdentity, storedId);
  db.prepare('UPDATE projects SET repository_identity = ? WHERE id = ?')
    .run(current.repositoryIdentity, registered.projectId);

  let result = null;
  let thrown = null;
  try {
    // Re-adding the same location is the documented recovery path for a
    // project that disappeared from the list, so this must not explode.
    result = registerProject(db, {
      commandId: 'reg-again', name: 'Rebind fixture', authorizedRoot: current.canonicalPath,
      observation: current,
    });
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown, null, `re-registering a rebound location threw: ${thrown?.message}`);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.projectId, registered.projectId, 'the same location keeps its project');
  assert.notEqual(readCommand(db, 'reg-again').state, 'received',
    'a rejected request must not leave a non-terminal journal row');

  // A new AI write session at the same, still-correct identity must be admitted.
  const run = startWriteRun(db, {
    commandId: 'run-after-rebind',
    worktreeId: worktreeIdFor(current.worktreeIdentity),
    canonicalPath: current.canonicalPath,
    repositoryIdentity: current.repositoryIdentity,
    worktreeIdentity: current.worktreeIdentity,
    agentClaim: 'claim',
    goal: '继续开发',
    baseline: snapshot(current),
  });
  assert.equal(run.ok, true, JSON.stringify(run));
  assert.deepEqual(
    db.prepare('SELECT worktree_id FROM runs WHERE id = ?').get(run.runId).worktree_id,
    storedId, 'the run must attach to the durable worktree row');
  assert.deepEqual(
    db.prepare('SELECT worktree_id FROM write_leases WHERE run_id = ?').get(run.runId).worktree_id,
    storedId, 'the write lease must guard the durable worktree row');
});
