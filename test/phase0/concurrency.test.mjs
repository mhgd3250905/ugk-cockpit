import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { openCockpitDatabase } from '../../src/core/database.mjs';
import { startWriteRun } from '../../src/core/runs.mjs';

const workerPath = fileURLToPath(new URL('../../scripts/phase0-worker.mjs', import.meta.url));

function worker(dbPath, action, payload) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(JSON.stringify({ action, payload })).toString('base64url');
    const child = spawn(process.execPath, [workerPath, dbPath, encoded], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`worker failed (${code}): ${stderr}`));
      resolve(JSON.parse(stdout));
    });
  });
}

async function runPool(items, concurrency, operation) {
  const results = new Array(items.length);
  let cursor = 0;
  async function lane() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await operation(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => lane()));
  return results;
}

function baseline() {
  return {
    head: 'a'.repeat(40),
    branch: 'main',
    indexFingerprint: 'index-1',
    worktreeFingerprint: 'tree-1',
    coherence: 'coherent',
  };
}

test('100 competing starts yield exactly one write lease', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-start-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dbPath = path.join(root, 'cockpit.db');
  openCockpitDatabase(dbPath).close();

  const requests = Array.from({ length: 100 }, (_, index) => ({
    commandId: `start-${index}`,
    runId: `run-${index}`,
    worktreeId: 'worktree-shared',
    canonicalPath: 'E:\\fixture\\shared',
    repositoryIdentity: 'fixture-repository',
    agentClaim: `luna-${index}`,
    goal: 'contention test',
    baseline: baseline(),
  }));
  const results = await runPool(requests, 100, (request) => worker(dbPath, 'start', request));

  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => result.code === 'WRITE_LEASE_CONFLICT').length, 99);

  const db = openCockpitDatabase(dbPath, { migrate: false });
  assert.equal(db.prepare('SELECT count(*) AS count FROM write_leases').get().count, 1);
  assert.equal(db.prepare("SELECT count(*) AS count FROM runs WHERE lifecycle = 'active'").get().count, 1);
  db.close();
});

test('100 retries of the same start command return one run', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-start-retry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dbPath = path.join(root, 'cockpit.db');
  openCockpitDatabase(dbPath).close();
  const request = {
    commandId: 'start-same',
    runId: 'run-same',
    worktreeId: 'worktree-same',
    canonicalPath: 'E:\\fixture\\same',
    repositoryIdentity: 'fixture-repository',
    agentClaim: 'codex',
    goal: 'idempotency test',
    baseline: baseline(),
  };
  const results = await runPool(
    Array.from({ length: 100 }, () => request),
    100,
    (item) => worker(dbPath, 'start', item),
  );
  assert.ok(results.every((result) => result.ok && result.runId === 'run-same'));

  const db = openCockpitDatabase(dbPath, { migrate: false });
  assert.equal(db.prepare('SELECT count(*) AS count FROM commands').get().count, 1);
  assert.equal(db.prepare('SELECT count(*) AS count FROM runs').get().count, 1);
  assert.equal(db.prepare('SELECT count(*) AS count FROM write_leases').get().count, 1);
  db.close();
});

test('CAS allows one of 100 heartbeat updates at the same revision', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-cas-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dbPath = path.join(root, 'cockpit.db');
  const db = openCockpitDatabase(dbPath);
  const start = startWriteRun(db, {
    commandId: 'start-cas',
    runId: 'run-cas',
    worktreeId: 'worktree-cas',
    canonicalPath: 'E:\\fixture\\cas',
    repositoryIdentity: 'fixture-repository',
    agentClaim: 'codex',
    goal: 'CAS test',
    baseline: baseline(),
  });
  db.close();

  const requests = Array.from({ length: 100 }, (_, index) => ({
    commandId: `heartbeat-${index}`,
    runId: 'run-cas',
    expectedRevision: 1,
    leaseGeneration: start.leaseGeneration,
  }));
  const results = await runPool(requests, 8, (request) => worker(dbPath, 'heartbeat', request));
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => result.code === 'RUN_REVISION_CONFLICT').length, 99);

  const finalDb = openCockpitDatabase(dbPath, { migrate: false });
  assert.equal(finalDb.prepare('SELECT revision FROM runs WHERE id = ?').get('run-cas').revision, 2);
  assert.equal(finalDb.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(finalDb.prepare('PRAGMA foreign_key_check').all(), []);
  finalDb.close();
});

test('100 concurrent retries produce one immutable finish receipt', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-finish-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dbPath = path.join(root, 'cockpit.db');
  const db = openCockpitDatabase(dbPath);
  const start = startWriteRun(db, {
    commandId: 'start-one',
    runId: 'run-one',
    worktreeId: 'worktree-one',
    canonicalPath: 'E:\\fixture\\one',
    repositoryIdentity: 'fixture-repository',
    agentClaim: 'codex',
    goal: 'finish contention test',
    baseline: baseline(),
  });
  assert.equal(start.ok, true);
  db.close();

  const finishRequest = {
    commandId: 'finish-one',
    runId: 'run-one',
    expectedRevision: 1,
    leaseGeneration: start.leaseGeneration,
    outcome: 'completed',
    summary: 'done',
    acknowledgeUnattributed: true,
    finalSnapshot: {
      ...baseline(),
      worktreeFingerprint: 'tree-2',
      repositoryIdentity: 'fixture-repository',
      worktreeIdentity: 'worktree-one',
      headRelation: 'same',
    },
  };
  const results = await runPool(
    Array.from({ length: 100 }, () => finishRequest),
    100,
    (request) => worker(dbPath, 'finish', request),
  );

  assert.ok(results.every((result) => result.ok));
  assert.equal(new Set(results.map((result) => result.receiptId)).size, 1);

  const finalDb = openCockpitDatabase(dbPath, { migrate: false });
  assert.equal(finalDb.prepare('SELECT count(*) AS count FROM handoff_receipts').get().count, 1);
  assert.equal(finalDb.prepare('SELECT count(*) AS count FROM write_leases').get().count, 0);
  assert.equal(finalDb.prepare('SELECT lifecycle FROM runs WHERE id = ?').get('run-one').lifecycle, 'completed');
  finalDb.close();
});

test('100 different finish commands elect one winner and preserve one receipt', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-finish-race-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dbPath = path.join(root, 'cockpit.db');
  const db = openCockpitDatabase(dbPath);
  const start = startWriteRun(db, {
    commandId: 'start-race',
    runId: 'run-race',
    worktreeId: 'worktree-race',
    canonicalPath: 'E:\\fixture\\race',
    repositoryIdentity: 'fixture-repository',
    agentClaim: 'codex',
    goal: 'different finish command race',
    baseline: baseline(),
  });
  db.close();

  const requests = Array.from({ length: 100 }, (_, index) => ({
    commandId: `finish-race-${index}`,
    runId: 'run-race',
    expectedRevision: 1,
    leaseGeneration: start.leaseGeneration,
    outcome: 'completed',
    summary: `candidate ${index}`,
    acknowledgeUnattributed: true,
    finalSnapshot: {
      ...baseline(),
      worktreeFingerprint: 'tree-2',
      repositoryIdentity: 'fixture-repository',
      worktreeIdentity: 'worktree-race',
      headRelation: 'same',
    },
  }));
  const results = await runPool(
    requests,
    100,
    (request) => worker(dbPath, 'finish', request),
  );

  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => result.code === 'STALE_WRITE_LEASE').length, 99);
  const finalDb = openCockpitDatabase(dbPath, { migrate: false });
  assert.equal(finalDb.prepare('SELECT count(*) AS count FROM handoff_receipts').get().count, 1);
  assert.equal(finalDb.prepare("SELECT count(*) AS count FROM runs WHERE lifecycle = 'completed'").get().count, 1);
  assert.equal(finalDb.prepare('SELECT count(*) AS count FROM write_leases').get().count, 0);
  assert.equal(finalDb.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  finalDb.close();
});
