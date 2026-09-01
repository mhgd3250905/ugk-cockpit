import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCockpitDatabase } from '../../src/core/database.mjs';
import {
  finishRun,
  heartbeatWriteRun,
  startWriteRun,
  takeoverWriteRun,
} from '../../src/core/runs.mjs';

function baseline(marker) {
  return {
    head: marker.repeat(40),
    branch: 'main',
    indexFingerprint: `index-${marker}`,
    worktreeFingerprint: `tree-${marker}`,
    coherence: 'coherent',
  };
}

test('confirmed takeover fences the previous writer', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-fence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openCockpitDatabase(path.join(root, 'cockpit.db'));
  const first = startWriteRun(db, {
    commandId: 'start-first',
    runId: 'run-first',
    worktreeId: 'worktree-one',
    canonicalPath: 'E:\\fixture\\fence',
    repositoryIdentity: 'repo-one',
    agentClaim: 'codex',
    goal: 'first writer',
    baseline: baseline('a'),
  });
  assert.equal(first.leaseGeneration, 1);

  const denied = takeoverWriteRun(db, {
    commandId: 'takeover-denied',
    worktreeId: 'worktree-one',
    previousRunId: 'run-first',
    expectedPreviousRevision: 1,
    newRunId: 'run-denied',
    agentClaim: 'luna',
    goal: 'must ask user',
    baseline: baseline('b'),
    userConfirmed: false,
  });
  assert.equal(denied.code, 'USER_CONFIRMATION_REQUIRED');

  const second = takeoverWriteRun(db, {
    commandId: 'takeover-confirmed',
    worktreeId: 'worktree-one',
    previousRunId: 'run-first',
    expectedPreviousRevision: 1,
    newRunId: 'run-second',
    agentClaim: 'luna',
    goal: 'new writer',
    baseline: baseline('b'),
    userConfirmed: true,
  });
  assert.equal(second.ok, true);
  assert.equal(second.leaseGeneration, 2);
  assert.equal(
    db.prepare('SELECT lifecycle FROM runs WHERE id = ?').get('run-first').lifecycle,
    'superseded',
  );

  const oldFinish = finishRun(db, {
    commandId: 'old-finish',
    runId: 'run-first',
    expectedRevision: 1,
    leaseGeneration: first.leaseGeneration,
    outcome: 'completed',
    summary: 'must be fenced',
    finalSnapshot: baseline('c'),
  });
  assert.equal(oldFinish.code, 'STALE_WRITE_LEASE');

  const oldHeartbeat = heartbeatWriteRun(db, {
    commandId: 'old-heartbeat',
    runId: 'run-first',
    expectedRevision: 1,
    leaseGeneration: first.leaseGeneration,
  });
  assert.equal(oldHeartbeat.code, 'STALE_WRITE_LEASE');
  db.close();
});

test('an existing worktree identity cannot silently point at another repository', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-rebind-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openCockpitDatabase(path.join(root, 'cockpit.db'));
  const first = startWriteRun(db, {
    commandId: 'identity-first',
    runId: 'identity-run-first',
    worktreeId: 'identity-worktree',
    canonicalPath: 'E:\\fixture\\repository-a',
    repositoryIdentity: 'repository-a',
    agentClaim: 'codex',
    goal: 'identity baseline',
    baseline: baseline('a'),
  });
  assert.equal(finishRun(db, {
    commandId: 'identity-finish',
    runId: first.runId,
    expectedRevision: first.revision,
    leaseGeneration: first.leaseGeneration,
    outcome: 'completed',
    summary: 'release lease',
    finalSnapshot: {
      ...baseline('a'),
      repositoryIdentity: 'repository-a',
      worktreeIdentity: 'identity-worktree',
      headRelation: 'same',
    },
  }).ok, true);

  assert.throws(
    () => startWriteRun(db, {
      commandId: 'identity-second',
      runId: 'identity-run-second',
      worktreeId: 'identity-worktree',
      canonicalPath: 'E:\\fixture\\repository-b',
      repositoryIdentity: 'repository-b',
      agentClaim: 'luna',
      goal: 'must not rebind silently',
      baseline: baseline('b'),
    }),
    /rebound without validation/,
  );
  assert.equal(db.prepare('SELECT count(*) AS count FROM runs').get().count, 1);
  db.close();
});
