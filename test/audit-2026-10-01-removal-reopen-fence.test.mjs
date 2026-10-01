import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { EmptyFolderGrantStore } from '../src/core/folder-grants.mjs';
import { authorizeEmptyDirectory } from '../src/core/path-guard.mjs';
import { beginCommand } from '../src/core/command-journal.mjs';
import { createAssignment, issueDispatchGrant } from '../src/core/assignments.mjs';
import { setWorkLineClosed } from '../src/core/manual-records.mjs';
import { abandonWorkspaceLifecycle } from '../src/core/workspace-lifecycle.mjs';
import { createDevelopmentWorkspace, removeDevelopmentWorkspace } from '../src/core/workspaces.mjs';
import { probeGitWorktree, safeGitEnvironment, SAFE_GIT_PREFIX } from '../src/git/probe.mjs';
import { removeGitWorktree } from '../src/git/workspace-ops.mjs';

const execFileAsync = promisify(execFile);
const PROCESS_BUDGET_MS = 30_000;

async function runGit(cwd, args) {
  return (await execFileAsync('git', [...SAFE_GIT_PREFIX, ...args], {
    cwd, windowsHide: true, shell: false, encoding: 'utf8', env: safeGitEnvironment(),
    timeout: 15_000, maxBuffer: 2 * 1024 * 1024,
  })).stdout.trim();
}

async function fixture(t) {
  const tempRoot = process.platform === 'win32' ? os.tmpdir() : realpathSync(os.tmpdir());
  const root = mkdtempSync(path.join(tempRoot, 'ugk-removal-reopen-fence-'));
  const dbPath = path.join(root, 'cockpit.db');
  const db = openCockpitDatabase(dbPath);
  const children = [];
  t.after(async () => {
    for (const worker of children) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGKILL');
      await worker.exit;
    }
    db.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const repo = path.join(root, 'main');
  mkdirSync(repo);
  await runGit(repo, ['init', '-b', 'main']);
  await runGit(repo, ['config', 'user.name', 'Removal Fence Fixture']);
  await runGit(repo, ['config', 'user.email', 'fixture@example.test']);
  writeFileSync(path.join(repo, 'README.md'), 'preserved history\n');
  await runGit(repo, ['add', 'README.md']);
  await runGit(repo, ['commit', '-m', 'baseline']);
  const observation = await probeGitWorktree(repo);
  const at = new Date().toISOString();
  db.prepare(`INSERT INTO worktrees (id, canonical_path, repository_identity, identity_fingerprint, created_at)
    VALUES ('main-wt', ?, ?, ?, ?)`)
    .run(observation.canonicalPath, observation.repositoryIdentity, observation.worktreeIdentity, at);
  db.prepare(`INSERT INTO projects (id, name, stage, worktree_id, status, status_reason,
    last_observed_at, created_at, updated_at, repository_identity, authorized_root)
    VALUES ('project', 'Removal Fence Project', 'development', 'main-wt', 'ready',
      'ready_to_start', ?, ?, ?, ?, ?)`)
    .run(at, at, at, observation.repositoryIdentity, observation.canonicalPath);

  async function createSpace(name) {
    const target = path.join(root, name);
    mkdirSync(target);
    const grant = new EmptyFolderGrantStore({ db }).issue(authorizeEmptyDirectory(target), 'principal');
    const created = await createDevelopmentWorkspace(db, {
      commandId: `create-${name}`, projectId: 'project', name,
      grantId: grant.grantId, principalHash: 'principal', expectedBaseHead: observation.after.head,
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    return { created, target };
  }
  const { created, target } = await createSpace('removing-space');
  const closed = setWorkLineClosed(db, {
    commandId: 'close-history', projectId: 'project', worktreeId: created.worktreeId,
    expectedRevision: 0, closed: true,
  });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  // Historical data can contain an invitation after the close. Removal permits
  // only this never-accepted invitation and retires it on successful commit.
  db.prepare(`INSERT INTO assignments (id, project_id, worktree_id, agent_id, task_id, scope_json,
    status, revision, session_id, created_at, updated_at)
    VALUES ('invite', 'project', ?, 'Codex', 'waiting', '{"mode":"write"}', 'pending', 1, NULL, ?, ?)`)
    .run(created.worktreeId, at, at);
  db.prepare(`INSERT INTO dispatch_grants (id, assignment_id, project_id, worktree_id, agent_id,
    task_id, scope_json, code_hash, state, expires_at, created_at)
    VALUES ('invite-grant', 'invite', 'project', ?, 'Codex', 'waiting', '{"mode":"write"}',
      'fixture-hash', 'active', ?, ?)`)
    .run(created.worktreeId, Date.now() + 3_600_000, at);
  const request = {
    commandId: 'remove-space', projectId: 'project', spaceId: created.spaceId,
    expectedRevision: created.space.revision,
  };
  const reopen = {
    commandId: 'reopen-during-removal', projectId: 'project', worktreeId: created.worktreeId,
    expectedRevision: 1, closed: false,
  };
  return { root, repo, db, dbPath, target, created, request, reopen, createSpace, children };
}

const invitation = (db) => db.prepare("SELECT status, revision FROM assignments WHERE id = 'invite'").get();
const grant = (db) => db.prepare("SELECT state, revoked_at FROM dispatch_grants WHERE id = 'invite-grant'").get();
const line = (f) => f.db.prepare('SELECT status, revision FROM work_line_states WHERE project_id = ? AND worktree_id = ?')
  .get('project', f.created.worktreeId);
const journalState = (db, commandId) => db.prepare('SELECT state FROM commands WHERE id = ?').get(commandId)?.state;
const reservation = (db) => db.prepare('SELECT * FROM workspace_lifecycle_reservations').get();

function assertBlockedReopen(f, result) {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.code, 'WORKSPACE_LIFECYCLE_IN_PROGRESS', JSON.stringify(result));
  assert.equal(result.blockedCommandId, f.request.commandId, JSON.stringify(result));
  assert.equal(result.retryable, true, JSON.stringify(result));
  assert.equal(result.outcome, 'unknown', JSON.stringify(result));
  assert.equal(journalState(f.db, f.reopen.commandId), 'received', 'the unchanged command remains retryable');
  assert.deepEqual({ ...line(f) }, { status: 'closed', revision: 1 });
  assert.deepEqual({ ...invitation(f.db) }, { status: 'pending', revision: 1 });
  assert.equal(grant(f.db).state, 'active');
}

function assertRetired(f) {
  assert.deepEqual({ ...invitation(f.db) }, { status: 'cancelled', revision: 2 });
  assert.equal(grant(f.db).state, 'revoked');
  assert.ok(grant(f.db).revoked_at);
  assert.equal(existsSync(f.target), false);
  assert.equal(f.db.prepare('SELECT status FROM development_spaces WHERE id = ?').get(f.created.spaceId).status, 'archived');
  assert.equal(reservation(f.db), undefined, 'a settled removal releases its durable fence');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM repository_locks').get().n, 0);
}

for (const phase of ['probe', 'git-effect']) {
  test(`删除期间 ${phase}：公开重开不能穿越围栏，成功后原请求可重放`, { timeout: 60_000 }, async (t) => {
    const f = await fixture(t);
    let attempted = false;
    let mutations = 0;
    const attempt = () => {
      attempted = true;
      assertBlockedReopen(f, setWorkLineClosed(f.db, f.reopen));
    };
    const result = await removeDevelopmentWorkspace(f.db, f.request, {
      probe: async (target) => {
        const observation = await probeGitWorktree(target);
        if (phase === 'probe' && !attempted) attempt();
        return observation;
      },
      removeGitWorktree: async (...args) => {
        mutations += 1;
        if (phase === 'git-effect') attempt();
        return removeGitWorktree(...args);
      },
    });
    assert.equal(attempted, true);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(mutations, 1);
    assertRetired(f);
    // Historical markers remain editable after the operation settles. Retrying
    // the exact blocked request must work without changing its commandId or CAS.
    const reopened = setWorkLineClosed(f.db, f.reopen);
    assert.equal(reopened.ok, true, JSON.stringify(reopened));
    assert.equal(reopened.revision, 2);
    assert.deepEqual(setWorkLineClosed(f.db, f.reopen), reopened);
    const replay = await removeDevelopmentWorkspace(f.db, f.request, {
      probe: () => { throw new Error('a terminal replay must not probe'); },
      removeGitWorktree: () => { throw new Error('a terminal replay must not mutate'); },
    });
    assert.deepEqual(replay, result);
    assert.equal(mutations, 1);
    assert.equal(invitation(f.db).revision, 2, 'terminal replay cannot cancel twice');
  });
}

for (const phase of ['probe', 'git-effect']) {
  test(`持久标记在 ${phase} 变为 open：旧运行时 scope 不得继续忽略邀请`, { timeout: 60_000 }, async (t) => {
    const f = await fixture(t);
    let changed = false;
    let mutations = 0;
    const reopenStoredFact = () => {
      changed = true;
      f.db.prepare("UPDATE work_line_states SET status = 'open', revision = revision + 1 WHERE project_id = ? AND worktree_id = ?")
        .run('project', f.created.worktreeId);
    };
    const result = await removeDevelopmentWorkspace(f.db, f.request, {
      probe: async (target) => {
        const observation = await probeGitWorktree(target);
        if (phase === 'probe' && !changed) reopenStoredFact();
        return observation;
      },
      removeGitWorktree: async (...args) => {
        mutations += 1;
        if (phase === 'git-effect') reopenStoredFact();
        return removeGitWorktree(...args);
      },
    });
    assert.equal(changed, true);
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.code, 'SPACE_HAS_ACTIVE_WORK', JSON.stringify(result));
    assert.equal(result.assignmentId, 'invite', JSON.stringify(result));
    assert.deepEqual({ ...invitation(f.db) }, { status: 'pending', revision: 1 });
    assert.equal(grant(f.db).state, 'active');
    if (phase === 'probe') {
      assert.equal(mutations, 0, 'fresh durable facts are checked before Git mutation');
      assert.equal(existsSync(f.target), true);
      assert.equal(reservation(f.db), undefined);
      assert.equal(journalState(f.db, f.request.commandId), 'failed');
    } else {
      assert.equal(mutations, 1);
      assert.equal(existsSync(f.target), false);
      assert.equal(result.outcome, 'unknown', 'a post-effect conflict must not claim settled success or failure');
      assert.equal(journalState(f.db, f.request.commandId), 'received');
      assert.equal(reservation(f.db)?.state, 'unknown', 'uncertain post-effect state retains its fence');
    }
  });
}

test('删除确认失败释放围栏：被挡住的重开原样重试成功，删除原样重放不触碰 Git', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  let probes = 0;
  let blockedReopen;
  const result = await removeDevelopmentWorkspace(f.db, f.request, {
    probe: async () => {
      probes += 1;
      blockedReopen = setWorkLineClosed(f.db, f.reopen);
      throw new Error('fixture probe failure before any effect');
    },
    removeGitWorktree: () => { throw new Error('a failed probe must not mutate'); },
  });
  assertBlockedReopen(f, blockedReopen);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.code, 'WORKSPACE_PROBE_FAILED', JSON.stringify(result));
  assert.equal(result.outcome, 'confirmed_failure', JSON.stringify(result));
  assert.equal(existsSync(f.target), true);
  assert.equal(reservation(f.db), undefined);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM repository_locks').get().n, 0);
  const reopened = setWorkLineClosed(f.db, f.reopen);
  assert.equal(reopened.ok, true, JSON.stringify(reopened));
  assert.equal(reopened.revision, 2);
  assert.deepEqual(setWorkLineClosed(f.db, f.reopen), reopened);
  assert.equal(invitation(f.db).status, 'pending');
  assert.equal(grant(f.db).state, 'active');
  assert.deepEqual(await removeDevelopmentWorkspace(f.db, f.request, {
    probe: () => { probes += 1; throw new Error('terminal failure must replay'); },
  }), result);
  assert.equal(probes, 1);
});

function trackedWorker(f, args) {
  const child = spawn(process.execPath, args, { cwd: fileURLToPath(new URL('..', import.meta.url)), windowsHide: true,
    shell: false, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const exit = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  f.children.push({ child, exit });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const message = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`worker timeout: ${stderr}`));
    }, PROCESS_BUDGET_MS);
    child.once('message', (value) => { clearTimeout(timer); resolve(value); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => { clearTimeout(timer); reject(new Error(`worker exited ${code}: ${stderr}`)); });
  });
  return { child, exit, message };
}

function lifecycleWorker(f, config) {
  return trackedWorker(f, [
    fileURLToPath(new URL('../scripts/workspace-lifecycle-test-worker.mjs', import.meta.url)),
    Buffer.from(JSON.stringify(config)).toString('base64url'),
  ]);
}

async function reopenInFreshProcess(f, request = f.reopen) {
  // A separate, newly started process opens the same durable database. No PID or
  // in-memory executor state is forged, and the installed service is never used.
  const source = `
    import { openCockpitDatabase } from ${JSON.stringify(new URL('../src/core/database.mjs', import.meta.url).href)};
    import { setWorkLineClosed } from ${JSON.stringify(new URL('../src/core/manual-records.mjs', import.meta.url).href)};
    const config = JSON.parse(Buffer.from(process.argv[1], 'base64url').toString());
    const db = openCockpitDatabase(config.dbPath);
    try { process.stdout.write(JSON.stringify(setWorkLineClosed(db, config.request))); }
    finally { db.close(); }
  `;
  const output = await execFileAsync(process.execPath, ['--input-type=module', '--eval', source,
    Buffer.from(JSON.stringify({ dbPath: f.dbPath, request })).toString('base64url')], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), windowsHide: true, shell: false,
    encoding: 'utf8', timeout: PROCESS_BUDGET_MS, maxBuffer: 1024 * 1024,
  });
  return JSON.parse(output.stdout);
}

test('真实进程终止与重建：未决删除仍挡重开，原删除恢复后才释放并清理邀请', { timeout: 90_000 }, async (t) => {
  const f = await fixture(t);
  const effectsPath = path.join(f.root, 'effects.txt');
  const config = { dbPath: f.dbPath, request: f.request, kind: 'remove', effectsPath };
  const crashing = lifecycleWorker(f, { ...config, crash: true });
  assert.deepEqual(await crashing.message, { phase: 'git-complete' });
  crashing.child.kill('SIGKILL');
  await crashing.exit;
  assert.equal(existsSync(f.target), false, 'the real Git effect happened before process death');
  assert.equal(journalState(f.db, f.request.commandId), 'received');
  assert.ok(reservation(f.db), 'a killed executor leaves the durable fence');
  assertBlockedReopen(f, await reopenInFreshProcess(f));

  const recovering = lifecycleWorker(f, config);
  const recovered = await recovering.message;
  assert.equal(recovered.phase, 'result', JSON.stringify(recovered));
  assert.equal(recovered.result.ok, true, JSON.stringify(recovered));
  assert.equal((await recovering.exit).code, 0);
  assertRetired(f);
  const reopened = await reopenInFreshProcess(f);
  assert.equal(reopened.ok, true, JSON.stringify(reopened));
  assert.equal(reopened.revision, 2);
  assert.deepEqual(await reopenInFreshProcess(f), reopened);
  const replay = lifecycleWorker(f, config);
  assert.deepEqual(await replay.message, recovered);
  assert.equal((await replay.exit).code, 0);
  assert.equal(readFileSync(effectsPath, 'utf8'), 'remove\n', 'recovery and terminal replay must not repeat Git');
  assert.equal(f.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(f.db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('旧未决 journal 没有 reservation 也挡同一工作线；其他工作线历史标记不受影响', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const other = await f.createSpace('other-space');
  assert.equal(setWorkLineClosed(f.db, {
    commandId: 'close-other-line', projectId: 'project', worktreeId: other.created.worktreeId,
    expectedRevision: 0, closed: true,
  }).ok, true);
  beginCommand(f.db, { commandId: f.request.commandId, kind: 'workspace.remove', request: f.request });
  assert.equal(reservation(f.db), undefined, 'this is an unresolved legacy journal, not a reservation');
  assertBlockedReopen(f, setWorkLineClosed(f.db, f.reopen));
  const otherReopened = setWorkLineClosed(f.db, {
    commandId: 'reopen-other-line', projectId: 'project', worktreeId: other.created.worktreeId,
    expectedRevision: 1, closed: false,
  });
  assert.equal(otherReopened.ok, true, JSON.stringify(otherReopened));
  assert.equal(otherReopened.status, 'open');
  assert.equal(otherReopened.revision, 2);
  const noChange = setWorkLineClosed(f.db, {
    ...f.reopen, commandId: 'closed-line-no-change', closed: true,
  });
  assert.equal(noChange.ok, true, 'a no-op does not cross the lifecycle fence');
  assert.equal(noChange.changed, false);
  assert.deepEqual({ ...line(f) }, { status: 'closed', revision: 1 });
});

test('真实 journal 提交后进程终止：关闭须能取消正常邀请并解除未决删除死角', { timeout: 90_000 }, async (t) => {
  const f = await fixture(t);
  // Replace the historical invitation with a normal API-created invitation on
  // an open line. This recovery scenario does not need an unusual persisted row.
  f.db.prepare("DELETE FROM dispatch_grants WHERE id = 'invite-grant'").run();
  f.db.prepare("DELETE FROM assignments WHERE id = 'invite'").run();
  const opened = setWorkLineClosed(f.db, f.reopen);
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.equal(opened.revision, 2);
  const assigned = createAssignment(f.db, {
    commandId: 'create-normal-invitation', assignmentId: 'invite', projectId: 'project',
    spaceId: f.created.spaceId, agentId: 'Codex', taskId: 'waiting', scope: { mode: 'write' },
  });
  assert.equal(assigned.ok, true, JSON.stringify(assigned));
  const issued = issueDispatchGrant(f.db, {
    assignmentId: assigned.assignmentId, grantId: 'invite-grant', dispatchCode: 'isolated-recovery-fixture',
  });
  assert.equal(issued.ok, true, JSON.stringify(issued));
  assert.deepEqual({ ...invitation(f.db) }, { status: 'pending', revision: 0 });
  assert.equal(grant(f.db).state, 'active');

  const source = `
    import { openCockpitDatabase } from ${JSON.stringify(new URL('../src/core/database.mjs', import.meta.url).href)};
    import { beginCommand } from ${JSON.stringify(new URL('../src/core/command-journal.mjs', import.meta.url).href)};
    const config = JSON.parse(Buffer.from(process.argv[1], 'base64url').toString());
    const db = openCockpitDatabase(config.dbPath);
    beginCommand(db, { commandId: config.request.commandId, kind: 'workspace.remove', request: config.request });
    process.send({ phase: 'journal-persisted' });
    await new Promise(() => { setInterval(() => {}, 1000); });
  `;
  const crashing = trackedWorker(f, ['--input-type=module', '--eval', source,
    Buffer.from(JSON.stringify({ dbPath: f.dbPath, request: f.request })).toString('base64url')]);
  assert.deepEqual(await crashing.message, { phase: 'journal-persisted' });
  crashing.child.kill('SIGKILL');
  await crashing.exit;
  assert.equal(journalState(f.db, f.request.commandId), 'received');
  assert.equal(reservation(f.db), undefined, 'the executor died before reservation or active-work refusal');
  assert.equal(existsSync(f.target), true);

  const repositoryIdentity = f.db.prepare('SELECT repository_identity FROM worktrees WHERE id = ?')
    .get(f.created.worktreeId).repository_identity;
  const abandonRequest = {
    commandId: 'abandon-interrupted-removal', blockedCommandId: f.request.commandId,
    repositoryIdentity, userConfirmed: true,
  };
  const blockedAbandon = abandonWorkspaceLifecycle(f.db, abandonRequest);
  assert.equal(blockedAbandon.ok, false, JSON.stringify(blockedAbandon));
  assert.equal(blockedAbandon.code, 'SPACE_HAS_ACTIVE_WORK', JSON.stringify(blockedAbandon));
  assert.equal(blockedAbandon.retryable, true);
  assert.equal(journalState(f.db, abandonRequest.commandId), 'received');

  const closeRequest = { ...f.reopen, commandId: 'close-stuck-line', expectedRevision: 2, closed: true };
  const closed = await reopenInFreshProcess(f, closeRequest);
  assert.equal(closed.ok, true, JSON.stringify(closed));
  assert.equal(closed.changed, true);
  assert.equal(closed.revision, 3);
  assert.deepEqual({ ...line(f) }, { status: 'closed', revision: 3 });
  assert.deepEqual({ ...invitation(f.db) }, { status: 'cancelled', revision: 1 });
  assert.equal(grant(f.db).state, 'revoked');
  assert.ok(grant(f.db).revoked_at);
  assert.deepEqual(await reopenInFreshProcess(f, closeRequest), closed, 'close replays without cancelling twice');

  const abandoned = abandonWorkspaceLifecycle(f.db, abandonRequest);
  assert.equal(abandoned.ok, true, JSON.stringify(abandoned));
  assert.equal(abandoned.fenceSource, 'journal');
  assert.deepEqual(abandoned.remainingPendingCommandIds, []);
  assert.equal(journalState(f.db, f.request.commandId), 'failed');
  assert.equal(journalState(f.db, abandonRequest.commandId), 'committed');
  assert.deepEqual(abandonWorkspaceLifecycle(f.db, abandonRequest), abandoned);
  const originalReplay = await removeDevelopmentWorkspace(f.db, f.request, {
    probe: () => { throw new Error('abandoned command is terminal'); },
    removeGitWorktree: () => { throw new Error('abandoned command must not mutate'); },
  });
  assert.equal(originalReplay.ok, false);
  assert.equal(originalReplay.code, 'WORKSPACE_LIFECYCLE_ABANDONED');
  assert.equal(originalReplay.outcome, 'confirmed_failure');
  assert.equal(originalReplay.retryable, false);
  assert.equal(existsSync(f.target), true, 'closing and abandoning alter records only');
  assert.equal((await probeGitWorktree(f.target)).after.branch, f.created.branch);
  assert.equal(invitation(f.db).revision, 1, 'terminal replays must not cancel twice');
  assert.equal(f.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(f.db.prepare('PRAGMA foreign_key_check').all().length, 0);
});
