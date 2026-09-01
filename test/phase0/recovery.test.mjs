import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { beginCommand, readCommand } from '../../src/core/command-journal.mjs';
import { openCockpitDatabase } from '../../src/core/database.mjs';
import { finalizeFinish, finishRun, prepareFinish, startWriteRun } from '../../src/core/runs.mjs';

const workerPath = fileURLToPath(new URL('../../scripts/phase0-worker.mjs', import.meta.url));

function crashWorker(dbPath, action, payload) {
  const encoded = Buffer.from(JSON.stringify({ action, payload })).toString('base64url');
  return spawnSync(process.execPath, [workerPath, dbPath, encoded], {
    windowsHide: true,
    stdio: 'pipe',
    encoding: 'utf8',
  });
}

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, dbPath: path.join(root, 'cockpit.db') };
}

function startRequest() {
  return {
    commandId: 'recover-start',
    runId: 'recover-run',
    worktreeId: 'recover-worktree',
    canonicalPath: 'E:\\fixture\\recover',
    repositoryIdentity: 'fixture-repository',
    agentClaim: 'antigravity',
    goal: 'prove crash recovery',
    baseline: {
      head: 'b'.repeat(40),
      branch: 'main',
      indexFingerprint: 'index-before',
      worktreeFingerprint: 'tree-before',
      coherence: 'coherent',
    },
  };
}

test('received start command can be replayed without phantom run', (t) => {
  const { dbPath } = fixture(t);
  let db = openCockpitDatabase(dbPath);
  const request = startRequest();
  beginCommand(db, {
    commandId: request.commandId,
    kind: 'run.start',
    request: Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'baseline')),
    runId: request.runId,
  });
  assert.equal(db.prepare('SELECT count(*) AS count FROM runs').get().count, 0);
  db.close();

  db = openCockpitDatabase(dbPath, { migrate: false });
  const replay = startWriteRun(db, request);
  assert.equal(replay.ok, true);
  assert.equal(db.prepare('SELECT count(*) AS count FROM runs').get().count, 1);
  assert.equal(readCommand(db, request.commandId).state, 'committed');
  db.close();
});

test('observing finish command has no phantom receipt and can be resumed', (t) => {
  const { dbPath } = fixture(t);
  let db = openCockpitDatabase(dbPath);
  assert.equal(startWriteRun(db, startRequest()).ok, true);
  const finish = {
    commandId: 'recover-finish',
    runId: 'recover-run',
    expectedRevision: 1,
    leaseGeneration: 1,
    outcome: 'completed',
    summary: 'recovered',
    finalSnapshot: {
      head: 'c'.repeat(40),
      branch: 'main',
      indexFingerprint: 'index-after',
      worktreeFingerprint: 'tree-after',
      repositoryIdentity: 'fixture-repository',
      worktreeIdentity: 'recover-worktree',
      headRelation: 'descendant',
      coherence: 'coherent',
    },
    commitRefs: ['c'.repeat(40)],
    acknowledgeUnattributed: true,
  };
  prepareFinish(db, finish);
  assert.equal(readCommand(db, finish.commandId).state, 'observing');
  assert.equal(db.prepare('SELECT count(*) AS count FROM handoff_receipts').get().count, 0);
  assert.equal(db.prepare('SELECT lifecycle FROM runs WHERE id = ?').get('recover-run').lifecycle, 'active');
  db.close();

  db = openCockpitDatabase(dbPath, { migrate: false });
  const replay = finishRun(db, finish);
  assert.equal(replay.ok, true);
  assert.equal(db.prepare('SELECT count(*) AS count FROM handoff_receipts').get().count, 1);
  assert.equal(db.prepare('SELECT lifecycle FROM runs WHERE id = ?').get('recover-run').lifecycle, 'completed');
  db.close();
});

test('same command id with another payload is rejected', (t) => {
  const { dbPath } = fixture(t);
  const db = openCockpitDatabase(dbPath);
  const request = startRequest();
  assert.equal(startWriteRun(db, request).ok, true);
  assert.throws(
    () => startWriteRun(db, { ...request, goal: 'different request' }),
    { code: 'COMMAND_CONFLICT' },
  );
  db.close();
});

test('completed outcome is refused for an incoherent final snapshot', (t) => {
  const { dbPath } = fixture(t);
  const db = openCockpitDatabase(dbPath);
  assert.equal(startWriteRun(db, startRequest()).ok, true);
  const result = finishRun(db, {
    commandId: 'finish-incoherent',
    runId: 'recover-run',
    expectedRevision: 1,
    leaseGeneration: 1,
    outcome: 'completed',
    summary: 'must not complete',
    finalSnapshot: { coherence: 'incoherent' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INCOHERENT_FINAL_SNAPSHOT');
  assert.equal(db.prepare('SELECT count(*) AS count FROM handoff_receipts').get().count, 0);
  assert.equal(db.prepare('SELECT lifecycle FROM runs WHERE id = ?').get('recover-run').lifecycle, 'active');
  db.close();
});

test('50 forced exits at start and finish durable boundaries recover cleanly', (t) => {
  const { dbPath } = fixture(t);
  const db = openCockpitDatabase(dbPath);
  const startPoints = [
    'start.after_run_insert',
    'start.after_snapshot_insert',
    'start.after_lease_insert',
    'start.after_command_commit_before_transaction_commit',
    'start.after_transaction_commit_before_response',
  ];
  const finishPoints = [
    'finish.after_snapshot_insert',
    'finish.after_receipt_insert',
    'finish.after_run_cas',
    'finish.after_lease_release',
    'finish.after_command_commit_before_transaction_commit',
    'finish.after_transaction_commit_before_response',
  ];
  for (let index = 0; index < 50; index += 1) {
    const start = {
      ...startRequest(),
      commandId: `crash-start-${index}`,
      runId: `crash-run-${index}`,
      worktreeId: `crash-worktree-${index}`,
      canonicalPath: `E:\\fixture\\crash-${index}`,
    };
    assert.equal(crashWorker(dbPath, 'crash-start-at', {
      request: start,
      faultPoint: startPoints[index % startPoints.length],
    }).status, 91);
    const started = startWriteRun(db, start);
    assert.equal(started.ok, true);

    const finish = {
      commandId: `crash-finish-${index}`,
      runId: start.runId,
      expectedRevision: 1,
      leaseGeneration: started.leaseGeneration,
      outcome: 'completed',
      summary: 'recovered after forced exit',
      acknowledgeUnattributed: true,
      finalSnapshot: {
        ...start.baseline,
        worktreeFingerprint: `tree-after-${index}`,
        repositoryIdentity: start.repositoryIdentity,
        worktreeIdentity: start.worktreeId,
        headRelation: 'same',
      },
    };
    assert.equal(crashWorker(dbPath, 'crash-finish-at', {
      request: finish,
      faultPoint: finishPoints[index % finishPoints.length],
    }).status, 91);
    assert.equal(finishRun(db, finish).ok, true);
  }
  assert.equal(db.prepare('SELECT count(*) AS count FROM runs').get().count, 50);
  assert.equal(db.prepare('SELECT count(*) AS count FROM handoff_receipts').get().count, 50);
  assert.equal(db.prepare('SELECT count(*) AS count FROM write_leases').get().count, 0);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();
});

test('finalize cannot change the frozen finish outcome or summary', (t) => {
  const { dbPath } = fixture(t);
  const db = openCockpitDatabase(dbPath);
  assert.equal(startWriteRun(db, startRequest()).ok, true);
  const original = {
    commandId: 'frozen-finish',
    runId: 'recover-run',
    expectedRevision: 1,
    leaseGeneration: 1,
    outcome: 'blocked',
    summary: 'original blocked reason',
    finalSnapshot: {
      ...startRequest().baseline,
      repositoryIdentity: 'fixture-repository',
      worktreeIdentity: 'recover-worktree',
      headRelation: 'same',
    },
  };
  prepareFinish(db, original);
  assert.throws(
    () => finalizeFinish(db, {
      ...original,
      outcome: 'completed',
      summary: 'mutated payload',
    }),
    { code: 'COMMAND_CONFLICT' },
  );
  assert.equal(db.prepare('SELECT count(*) AS count FROM handoff_receipts').get().count, 0);
  assert.equal(db.prepare('SELECT lifecycle FROM runs WHERE id = ?').get('recover-run').lifecycle, 'active');
  db.close();
});

test('a frozen finish command cannot be redirected to another Run', (t) => {
  const { dbPath } = fixture(t);
  const db = openCockpitDatabase(dbPath);
  const first = startRequest();
  assert.equal(startWriteRun(db, first).ok, true);
  const second = {
    ...startRequest(),
    commandId: 'second-start',
    runId: 'second-run',
    worktreeId: 'second-worktree',
    canonicalPath: 'E:\\fixture\\second',
  };
  assert.equal(startWriteRun(db, second).ok, true);

  const frozen = {
    commandId: 'cross-run-finish',
    runId: first.runId,
    expectedRevision: 1,
    leaseGeneration: 1,
    outcome: 'completed',
    summary: 'must belong to the first Run',
  };
  prepareFinish(db, frozen);
  assert.throws(
    () => finalizeFinish(db, {
      ...frozen,
      runId: second.runId,
      commandPayload: frozen,
      finalSnapshot: {
        ...second.baseline,
        repositoryIdentity: second.repositoryIdentity,
        worktreeIdentity: second.worktreeId,
        headRelation: 'same',
      },
    }),
    { code: 'COMMAND_CONFLICT' },
  );
  assert.equal(db.prepare('SELECT count(*) AS count FROM handoff_receipts').get().count, 0);
  assert.equal(db.prepare("SELECT count(*) AS count FROM runs WHERE lifecycle = 'active'").get().count, 2);
  db.close();
});
