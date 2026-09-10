import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { EmptyFolderGrantStore } from '../src/core/folder-grants.mjs';
import { authorizeEmptyDirectory } from '../src/core/path-guard.mjs';
import { setWorkLineClosed } from '../src/core/manual-records.mjs';
import { startWriteRun } from '../src/core/runs.mjs';
import { createDevelopmentWorkspace, removeDevelopmentWorkspace, reuseDevelopmentWorkspace } from '../src/core/workspaces.mjs';
import { probeGitWorktree, safeGitEnvironment, SAFE_GIT_PREFIX } from '../src/git/probe.mjs';
import { listGitWorktrees, removeGitWorktree, switchGitWorktreeToNewBranch } from '../src/git/workspace-ops.mjs';
import { createApiClient } from '../web/src/api.js';
import { beginCommand } from '../src/core/command-journal.mjs';
import { createAssignment } from '../src/core/assignments.mjs';
import { generateStableBranchName } from '../src/git/workspace-ops.mjs';
import { createWorkspaceActionRecord, upsertWorkspaceActionRecord, readWorkspaceActionRecords,
  classifyWorkspaceActionError, markWorkspaceActionUnknown, removeWorkspaceActionRecord } from '../web/src/workspace-action-recovery.mjs';

async function fixture(t) {
  const root = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'ugk-lifecycle-regression-'));
  const connections = [];
  const children = [];
  t.after(async () => {
    for (const item of children) {
      if (item.child.exitCode === null && item.child.signalCode === null) item.child.kill('SIGKILL');
      await item.exit;
    }
    for (const connection of connections) connection.close();
    rmSync(root, { recursive: true, force: true });
  });
  const repo = path.join(root, 'main');
  mkdirSync(repo);
  const git = (args) => execFileSync('git', [...SAFE_GIT_PREFIX, ...args], {
    cwd: repo, windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024, env: safeGitEnvironment(),
  });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Lifecycle Fixture']);
  git(['config', 'user.email', 'fixture@example.test']);
  writeFileSync(path.join(repo, 'README.md'), 'preserved history\n');
  git(['add', '.']);
  git(['commit', '-m', 'baseline']);
  const observed = await probeGitWorktree(repo);
  const dbPath = path.join(root, 'cockpit.db');
  const db = openCockpitDatabase(dbPath);
  connections.push(db);
  const stamp = new Date().toISOString();
  db.prepare('INSERT INTO worktrees (id, canonical_path, repository_identity, identity_fingerprint, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('main-wt', observed.canonicalPath, observed.repositoryIdentity, observed.worktreeIdentity, stamp);
  db.prepare(`INSERT INTO projects (id, name, stage, worktree_id, status, status_reason, last_observed_at, created_at, updated_at, repository_identity, authorized_root)
    VALUES ('project', 'Fixture', 'development', 'main-wt', 'ready', 'ready_to_start', ?, ?, ?, ?, ?)`)
    .run(stamp, stamp, stamp, observed.repositoryIdentity, observed.canonicalPath);
  const target = path.join(root, 'space');
  mkdirSync(target);
  const grant = new EmptyFolderGrantStore({ db }).issue(authorizeEmptyDirectory(target), 'fixture-principal');
  const created = await createDevelopmentWorkspace(db, {
    commandId: 'fixture-create', projectId: 'project', name: 'Fixture space',
    grantId: grant.grantId, principalHash: 'fixture-principal', expectedBaseHead: observed.after.head,
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const request = (kind) => ({ commandId: `fixture-${kind}`, projectId: 'project', spaceId: created.spaceId,
    expectedRevision: created.space.revision, ...(kind === 'reuse' ? { expectedBaseHead: observed.after.head } : {}) });
  return { root, repo, target, db, dbPath, created, request, git, connections, children };
}

function admit(db, created, observation, commandId) {
  return startWriteRun(db, { commandId, worktreeId: created.worktreeId,
    canonicalPath: observation.canonicalPath, repositoryIdentity: observation.repositoryIdentity,
    worktreeIdentity: observation.worktreeIdentity, agentClaim: 'test', goal: 'concurrent work',
    baseline: { ...observation.after, coherence: observation.coherence, observedAt: observation.observedAt } });
}

function worker(fixture, config) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/workspace-lifecycle-test-worker.mjs', import.meta.url)),
    Buffer.from(JSON.stringify(config)).toString('base64url')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const exit = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  fixture.children.push({ child, exit });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const message = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`worker timeout: ${stderr}`)); }, 30000);
    child.once('message', (value) => { clearTimeout(timer); resolve(value); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => { clearTimeout(timer); reject(new Error(`worker exited ${code}: ${stderr}`)); });
  });
  return { child, exit, message };
}

function browserClient(port, storage) {
  const origin = `http://127.0.0.1:${port}`;
  let cookie = '';
  return createApiClient({ origin, storage, randomUUID: () => 'lifecycle-browser-client',
    fetchImpl: async (pathname, options) => {
      const response = await fetch(new URL(pathname, origin), { ...options,
        headers: { ...options.headers, cookie, origin, 'sec-fetch-site': 'same-origin' },
        signal: AbortSignal.timeout(15000),
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) cookie = cookies.map((item) => item.split(';')[0]).join('; ');
      return response;
    },
  });
}

function schema26Fixture(db) {
  db.exec(`DROP TABLE workspace_lifecycle_reservations;
    ALTER TABLE worktrees DROP COLUMN lifecycle_epoch;
    ALTER TABLE worktrees DROP COLUMN lifecycle_started_at;
    ALTER TABLE worktrees DROP COLUMN lifecycle_completed_at;
    ALTER TABLE snapshots DROP COLUMN lifecycle_epoch;
    DELETE FROM schema_migrations WHERE version >= 27;
    PRAGMA user_version = 26;`);
}

test('schema 26 history upgrades repeatedly without changing existing work, leases or records', { timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  const observation = await probeGitWorktree(f.target);
  assert.equal(admit(f.db, f.created, observation, 'historical-run').ok, true);
  assert.equal(setWorkLineClosed(f.db, { commandId: 'historical-close', projectId: 'project',
    worktreeId: f.created.worktreeId, expectedRevision: 0, closed: true }).ok, true);
  schema26Fixture(f.db);
  const tables = ['projects', 'worktrees', 'development_spaces', 'runs', 'write_leases', 'snapshots', 'commands', 'work_line_events'];
  const before = tables.map((table) => {
    const columns = f.db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    const query = `SELECT ${columns.map((column) => `"${column}"`).join(', ')} FROM ${table} ORDER BY rowid`;
    return { query, rows: f.db.prepare(query).all() };
  });
  f.connections.splice(f.connections.indexOf(f.db), 1);
  f.db.close();
  for (let pass = 0; pass < 2; pass += 1) {
    const upgraded = openCockpitDatabase(f.dbPath);
    try {
      assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, 28);
      assert.equal(upgraded.prepare('SELECT count(*) AS n FROM schema_migrations WHERE version = 27').get().n, 1);
      assert.equal(upgraded.prepare('SELECT count(*) AS n FROM schema_migrations WHERE version = 28').get().n, 1);
      for (const entry of before) assert.deepEqual(upgraded.prepare(entry.query).all(), entry.rows, entry.query);
      assert.equal(upgraded.prepare('PRAGMA foreign_key_check').all().length, 0);
      assert.equal(upgraded.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    } finally { upgraded.close(); }
  }
});

test('schema 26 ambiguous pending operations remain unknown without assigning effects to either request', { timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  schema26Fixture(f.db);
  const removal = f.request('remove');
  const reuse = f.request('reuse');
  beginCommand(f.db, { commandId: removal.commandId, kind: 'workspace.remove', request: removal });
  beginCommand(f.db, { commandId: reuse.commandId, kind: 'workspace.reuse',
    request: { ...reuse, nextBranch: generateStableBranchName(reuse.projectId, reuse.commandId) } });
  f.connections.splice(f.connections.indexOf(f.db), 1);
  f.db.close();
  const upgraded = openCockpitDatabase(f.dbPath);
  f.connections.push(upgraded);
  const result = await removeDevelopmentWorkspace(upgraded, removal);
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'unknown');
  for (const request of [removal, reuse]) {
    assert.equal(upgraded.prepare('SELECT state FROM commands WHERE id = ?').get(request.commandId).state, 'received');
  }
  assert.equal(existsSync(f.target), true);
  assert.equal((await probeGitWorktree(f.target)).after.branch, f.created.branch);
  assert.equal(upgraded.prepare('SELECT revision FROM development_spaces WHERE id = ?').get(f.created.spaceId).revision, 0);
});

for (const kind of ['remove', 'reuse']) {
  const operation = kind === 'remove' ? removeDevelopmentWorkspace : reuseDevelopmentWorkspace;
  test(`schema 26 pending ${kind}: upgrade fences admission and preserves original recovery`, { timeout: 60000 }, async (t) => {
    const f = await fixture(t);
    const stale = await probeGitWorktree(f.target);
    schema26Fixture(f.db);
    const request = f.request(kind);
    const nextBranch = generateStableBranchName(request.projectId, request.commandId);
    beginCommand(f.db, { commandId: request.commandId, kind: `workspace.${kind}`,
      request: { ...request, ...(kind === 'reuse' ? { nextBranch } : {}) } });
    if (kind === 'reuse') await switchGitWorktreeToNewBranch(f.target, { branch: nextBranch, baseCommit: request.expectedBaseHead });
    else await removeGitWorktree(f.repo, { targetPath: f.target });
    f.connections.splice(f.connections.indexOf(f.db), 1);
    f.db.close();
    const upgraded = openCockpitDatabase(f.dbPath);
    f.connections.push(upgraded);
    assert.equal(admit(upgraded, f.created, stale, 'legacy-pending-admission').ok, false);
    const result = await operation(upgraded, request);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(upgraded.prepare('SELECT revision FROM development_spaces WHERE id = ?').get(f.created.spaceId).revision, 1);
    assert.equal(upgraded.prepare('SELECT count(*) AS n FROM write_leases').get().n, 0);
    assert.equal(upgraded.prepare('PRAGMA foreign_key_check').all().length, 0);
    assert.equal(existsSync(f.target), kind === 'reuse');
  });

  test(`REAL GIT ${kind}: admission during async probe cannot acquire a lease across the effect`, { timeout: 60000 }, async (t) => {
    const f = await fixture(t);
    const competitor = openCockpitDatabase(f.dbPath);
    f.connections.push(competitor);
    let attempted = false;
    const result = await operation(f.db, f.request(kind), { probe: async (target) => {
      const observation = await probeGitWorktree(target);
      if (target === f.created.canonicalPath && !attempted) {
        attempted = true;
        const admitted = admit(competitor, f.created, observation, 'during-probe');
        assert.equal(admitted.ok, false, 'lifecycle reservation must exclude lease acquisition');
        const assigned = createAssignment(competitor, { commandId: 'assignment-during-probe', projectId: 'project',
          spaceId: f.created.spaceId, agentId: 'test', taskId: 'concurrent-assignment' });
        assert.equal(assigned.ok, false, 'pending dispatch cannot enter the Git operation window');
      }
      return observation;
    } });
    assert.equal(attempted, true);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM write_leases').get().n, 0);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM runs WHERE lifecycle = 'active'").get().n, 0);
    assert.equal(existsSync(f.target), kind === 'reuse');
    if (kind === 'reuse') assert.equal((await probeGitWorktree(f.target)).after.branch, result.branch);
  });

  test(`REAL GIT ${kind}: a successfully acquired lease keeps its directory and branch`, { timeout: 60000 }, async (t) => {
    const f = await fixture(t);
    const observation = await probeGitWorktree(f.target);
    const admitted = admit(f.db, f.created, observation, 'before-lifecycle');
    assert.equal(admitted.ok, true, JSON.stringify(admitted));
    const result = await operation(f.db, f.request(kind));
    assert.equal(result.ok, false);
    assert.equal(existsSync(f.target), true);
    assert.equal((await probeGitWorktree(f.target)).after.branch, f.created.branch);
    assert.equal(f.db.prepare('SELECT run_id FROM write_leases WHERE worktree_id = ?').get(f.created.worktreeId).run_id, admitted.runId);
    assert.equal(f.db.prepare('SELECT lifecycle FROM runs WHERE id = ?').get(admitted.runId).lifecycle, 'active');
  });

  test(`REAL GIT ${kind}: changed revision during probe is checked before Git mutation`, { timeout: 60000 }, async (t) => {
    const f = await fixture(t);
    let changed = false;
    const result = await operation(f.db, f.request(kind), { probe: async (target) => {
      const observation = await probeGitWorktree(target);
      if (target === f.created.canonicalPath && !changed) {
        changed = true;
        f.db.prepare('UPDATE development_spaces SET revision = revision + 1 WHERE id = ?').run(f.created.spaceId);
      }
      return observation;
    } });
    assert.equal(changed, true);
    assert.equal(result.ok, false);
    assert.equal(existsSync(f.target), true);
    assert.equal((await probeGitWorktree(f.target)).after.branch, f.created.branch);
    assert.equal(f.db.prepare('SELECT revision FROM development_spaces WHERE id = ?').get(f.created.spaceId).revision, 1);
  });

  test(`REAL GIT ${kind}: admission cannot use a snapshot captured before the lifecycle operation`, { timeout: 60000 }, async (t) => {
    const f = await fixture(t);
    const stale = await probeGitWorktree(f.target);
    const result = await operation(f.db, f.request(kind));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(admit(f.db, f.created, stale, 'stale-admission').ok, false);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM write_leases').get().n, 0);
    if (kind === 'reuse') {
      const fresh = await probeGitWorktree(f.target);
      const admitted = admit(f.db, f.created, fresh, 'fresh-admission');
      assert.equal(admitted.ok, true, JSON.stringify(admitted));
      assert.equal(f.db.prepare("SELECT branch FROM snapshots WHERE run_id = ? AND phase = 'baseline'").get(admitted.runId).branch, result.branch);
      const assigned = createAssignment(f.db, { commandId: 'assignment-after-reuse', projectId: 'project',
        spaceId: f.created.spaceId, agentId: 'test', taskId: 'fresh-assignment' });
      assert.equal(assigned.ok, true, JSON.stringify(assigned));
    }
  });

  test(`REAL GIT ${kind}: simultaneous original-request retries perform one Git mutation`, { timeout: 60000 }, async (t) => {
    const f = await fixture(t);
    const competitor = openCockpitDatabase(f.dbPath);
    f.connections.push(competitor);
    let signalEntered;
    let release;
    const entered = new Promise((resolve) => { signalEntered = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    let firstProbe = true;
    let mutations = 0;
    const options = {
      probe: async (target) => {
        const observation = await probeGitWorktree(target);
        if (firstProbe) { firstProbe = false; signalEntered(); await gate; }
        return observation;
      },
      removeGitWorktree: async (...args) => { mutations += 1; return removeGitWorktree(...args); },
      switchGitWorktreeToNewBranch: async (...args) => { mutations += 1; return switchGitWorktreeToNewBranch(...args); },
    };
    const first = operation(f.db, f.request(kind), options);
    await entered;
    const second = operation(competitor, f.request(kind), options);
    release();
    const results = await Promise.all([first, second]);
    assert.ok(results.some((result) => result.ok), JSON.stringify(results));
    assert.equal(mutations, 1, 'concurrent replay cannot repeat the Git effect');
    const replay = await operation(f.db, f.request(kind));
    assert.equal(replay.ok, true, JSON.stringify(replay));
    assert.equal(f.db.prepare('SELECT revision FROM development_spaces WHERE id = ?').get(f.created.spaceId).revision, 1);
  });

  test(`REAL GIT ${kind}: unknown post-effect read can recover in the same live process`, { timeout: 60000 }, async (t) => {
    const f = await fixture(t);
    let effectDone = false;
    let mutations = 0;
    const mutate = async (fn, ...args) => {
      mutations += 1;
      await fn(...args);
      effectDone = true;
    };
    const options = {
      removeGitWorktree: (...args) => mutate(removeGitWorktree, ...args),
      switchGitWorktreeToNewBranch: (...args) => mutate(switchGitWorktreeToNewBranch, ...args),
      probe: async (...args) => {
        if (effectDone) throw new Error('transient post-effect probe failure');
        return probeGitWorktree(...args);
      },
      listGitWorktrees: async (...args) => {
        if (effectDone) throw new Error('transient post-effect list failure');
        return listGitWorktrees(...args);
      },
    };
    const result = await operation(f.db, f.request(kind), options).catch(() => null);
    assert.equal(effectDone, true);
    assert.notEqual(result?.ok, true);
    assert.equal(f.db.prepare('SELECT state FROM commands WHERE id = ?').get(f.request(kind).commandId).state, 'received');
    const recovered = await operation(f.db, f.request(kind), {
      removeGitWorktree: (...args) => mutate(removeGitWorktree, ...args),
      switchGitWorktreeToNewBranch: (...args) => mutate(switchGitWorktreeToNewBranch, ...args),
    });
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    assert.equal(mutations, 1);
    assert.equal(f.db.prepare('SELECT revision FROM development_spaces WHERE id = ?').get(f.created.spaceId).revision, 1);
  });

  test(`REAL PROCESS KILL ${kind}: original request recovers once after Git effect before receipt`, { timeout: 60000 }, async (t) => {
    const f = await fixture(t);
    assert.equal(setWorkLineClosed(f.db, { commandId: 'close-history', projectId: 'project', worktreeId: f.created.worktreeId,
      expectedRevision: 0, closed: true }).ok, true);
    const effectsPath = path.join(f.root, 'effects.txt');
    const before = await probeGitWorktree(f.target);
    const config = { dbPath: f.dbPath, kind, request: f.request(kind), effectsPath };
    const crashing = worker(f, { ...config, crash: true });
    assert.deepEqual(await crashing.message, { phase: 'git-complete' });
    crashing.child.kill('SIGKILL');
    await crashing.exit;
    assert.equal(f.db.prepare('SELECT state FROM commands WHERE id = ?').get(config.request.commandId).state, 'received');
    assert.equal(f.db.prepare('SELECT revision FROM development_spaces WHERE id = ?').get(f.created.spaceId).revision, 0);
    assert.equal(existsSync(f.target), kind === 'reuse');
    const transientRecovery = await operation(f.db, config.request, {
      probe: async () => { throw new Error('recovery observation temporarily unavailable'); },
      listGitWorktrees: async () => { throw new Error('recovery listing temporarily unavailable'); },
    }).catch(() => null);
    assert.notEqual(transientRecovery?.ok, true);
    assert.equal(f.db.prepare('SELECT state FROM commands WHERE id = ?').get(config.request.commandId).state, 'received',
      'a failed recovery observation cannot turn a possibly completed effect into a confirmed failure');
    assert.equal(admit(f.db, f.created, before, 'admit-after-crash').ok, false,
      'pending Git effect must remain fenced after process death');
    const unrelated = await operation(f.db, { ...config.request, commandId: 'different-request-after-crash' });
    assert.equal(unrelated.ok, false, 'a fresh request cannot replace the pending original operation');
    const restart = worker(f, config);
    const response = await restart.message;
    assert.equal(response.phase, 'result', JSON.stringify(response));
    assert.equal(response.result.ok, true, JSON.stringify(response));
    assert.equal((await restart.exit).code, 0);
    const replay = worker(f, config);
    assert.deepEqual(await replay.message, response);
    assert.equal((await replay.exit).code, 0);
    assert.equal(readFileSync(effectsPath, 'utf8'), `${kind}\n`, 'recovery must not repeat Git mutation');
    const row = f.db.prepare('SELECT * FROM development_spaces WHERE id = ?').get(f.created.spaceId);
    assert.equal(row.revision, 1);
    assert.equal(row.status, kind === 'remove' ? 'archived' : 'ready');
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM commands WHERE id = ?').get(config.request.commandId).n, 1);
    assert.deepEqual(f.db.prepare('SELECT event FROM work_line_events ORDER BY revision').all().map((r) => r.event), kind === 'reuse' ? ['close', 'reopen'] : ['close']);
    assert.equal(f.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(f.db.prepare('PRAGMA foreign_key_check').all().length, 0);
    const listed = await listGitWorktrees(f.repo);
    assert.equal(listed.some((entry) => path.resolve(entry.worktree) === path.resolve(f.target)), kind === 'reuse');
    if (kind === 'reuse') assert.equal((await probeGitWorktree(f.target)).after.branch, row.branch);
    assert.ok(f.git(['show', `${f.created.branch}:README.md`]).toString().includes('preserved history'));
    if (kind === 'reuse') {
      const fresh = await probeGitWorktree(f.target);
      const admitted = admit(f.db, f.created, fresh, 'admission-after-recovery');
      assert.equal(admitted.ok, true, 'a rejected competing request must not fence future work after original recovery');
    }
  });

  test(`HTTP PROCESS KILL ${kind}: browser client renews credentials and replays original request after restart`, { timeout: 60000 }, async (t) => {
    const f = await fixture(t);
    const effectsPath = path.join(f.root, 'http-effects.txt');
    const config = { dbPath: f.dbPath, kind, effectsPath, repo: f.repo, http: true };
    const values = new Map();
    const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
    const { projectId, spaceId, ...body } = f.request(kind);
    const pathname = `/api/v1/projects/${projectId}/spaces/${spaceId}/${kind}`;
    const record = createWorkspaceActionRecord({ kind, projectId, spaceId, request: body });
    upsertWorkspaceActionRecord(record, storage);
    const crashing = worker(f, { ...config, crash: true });
    const ready = await crashing.message;
    assert.equal(ready.phase, 'ready', JSON.stringify(ready));
    const api = browserClient(ready.port, storage);
    await assert.rejects(api(pathname, { method: 'POST', body: JSON.stringify(record.request) }), (error) => {
      assert.equal(classifyWorkspaceActionError(error), 'unknown');
      markWorkspaceActionUnknown(record, error, storage);
      return true;
    });
    await crashing.exit;
    assert.equal(readFileSync(effectsPath, 'utf8'), `${kind}\n`);
    const restarted = worker(f, config);
    const nextReady = await restarted.message;
    assert.equal(nextReady.phase, 'ready', JSON.stringify(nextReady));
    const newPageApi = browserClient(nextReady.port, storage);
    const page = await newPageApi(`/api/v1/projects/${projectId}`);
    assert.equal(page.ok, true, JSON.stringify(page));
    assert.equal(page.project.id, projectId, 'project page remains available for the recovery entry');
    const [restored] = readWorkspaceActionRecords(storage);
    assert.equal(restored.state, 'unknown');
    assert.deepEqual(restored.request, body);
    const restoredPath = `/api/v1/projects/${restored.projectId}/spaces/${restored.spaceId}/${restored.kind}`;
    const result = await newPageApi(restoredPath, { method: 'POST', body: JSON.stringify(restored.request) });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(await newPageApi(pathname, { method: 'POST', body: JSON.stringify(body) }), result);
    await assert.rejects(newPageApi(pathname, {
      method: 'POST', body: JSON.stringify({ ...body, commandId: 'confirmed-stale-request' }),
    }), (error) => {
      assert.equal(error.outcome, 'confirmed_failure');
      assert.equal(error.state, 'failed');
      assert.equal(error.retryable, false);
      assert.equal(classifyWorkspaceActionError(error), 'definitive');
      return true;
    });
    assert.equal(readFileSync(effectsPath, 'utf8'), `${kind}\n`, 'HTTP recovery must not repeat the effect');
    assert.equal(f.db.prepare('SELECT revision FROM development_spaces WHERE id = ?').get(f.created.spaceId).revision, 1);
    assert.equal(f.db.prepare('PRAGMA foreign_key_check').all().length, 0);
    removeWorkspaceActionRecord(restored, storage);
    assert.deepEqual(readWorkspaceActionRecords(storage), []);
    restarted.child.kill('SIGKILL');
    await restarted.exit;
  });
}
