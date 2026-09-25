import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { EmptyFolderGrantStore } from '../src/core/folder-grants.mjs';
import { authorizeEmptyDirectory } from '../src/core/path-guard.mjs';
import { updateDevelopmentSpaceStatus } from '../src/core/spaces.mjs';
import {
  abandonWorkspaceLifecycle,
  currentProcessStartTime,
  describeWorkspaceLifecycleFence,
  resolveFenceRepositoryIdentity,
} from '../src/core/workspace-lifecycle.mjs';
import { beginCommand, readCommand } from '../src/core/command-journal.mjs';
import { releaseOrphanedWriteRun, startWriteRun } from '../src/core/runs.mjs';
import { readFileSync } from 'node:fs';
import { worktreeIdFor } from '../src/core/projects.mjs';
import {
  createDevelopmentWorkspace,
  removeDevelopmentWorkspace,
  reuseDevelopmentWorkspace,
} from '../src/core/workspaces.mjs';
import { probeGitWorktree, safeGitEnvironment, SAFE_GIT_PREFIX } from '../src/git/probe.mjs';
import { PERSISTENT_LOCK_EXPIRY } from '../src/core/integrations.mjs';
import { createCockpitHttpServer } from '../src/service/http-server.mjs';

const execFileAsync = promisify(execFile);
const tmpRoot = () => (process.platform === 'win32' ? os.tmpdir() : realpathSync(os.tmpdir()));

// Fixture git must not inherit the host's configuration: the product always
// runs git through safeGitEnvironment(), so an ambient core.autocrlf or a
// hostile http.* would create changes only the fixture can see.
const runGit = (cwd, args) => execFileAsync('git', [...SAFE_GIT_PREFIX, ...args], {
  cwd,
  windowsHide: true,
  shell: false,
  encoding: 'utf8',
  env: safeGitEnvironment(),
});

async function fixture(t, { autoCleanup = true } = {}) {
  const root = mkdtempSync(path.join(tmpRoot(), 'ugk-lifecycle-fence-'));
  const db = openCockpitDatabase(path.join(root, 'cockpit.db'));
  // Ordered: an open SQLite handle keeps Windows from deleting the directory,
  // so every handle must be closed before the removal is attempted.
  const cleanup = () => {
    try { db.close(); } catch {}
    rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  };
  if (autoCleanup) t.after(cleanup);

  const repoDir = path.join(root, 'main-repo');
  mkdirSync(repoDir, { recursive: true });
  await runGit(repoDir, ['init', '-b', 'main']);
  await runGit(repoDir, ['config', 'user.name', 'UGK Fixture']);
  await runGit(repoDir, ['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(path.join(repoDir, 'README.md'), '# fence fixture\n');
  await runGit(repoDir, ['add', 'README.md']);
  await runGit(repoDir, ['-c', 'core.hooksPath=.git/hooks', 'commit', '--quiet', '-m', 'fixture']);

  const observation = await probeGitWorktree(repoDir);
  const at = new Date().toISOString();
  const mainWorktreeId = worktreeIdFor(observation.worktreeIdentity);
  db.prepare(`
    INSERT INTO worktrees (
      id, canonical_path, repository_identity, identity_fingerprint, created_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(mainWorktreeId, observation.canonicalPath, observation.repositoryIdentity,
    observation.worktreeIdentity, at);
  db.prepare(`
    INSERT INTO projects (
      id, name, stage, worktree_id, status, status_reason,
      last_observed_at, created_at, updated_at, repository_identity, authorized_root
    ) VALUES ('proj-fence', 'Fence Fixture', 'development', ?,
      'ready', 'ready_to_start', ?, ?, ?, ?, ?)
  `).run(mainWorktreeId, at, at, at, observation.repositoryIdentity, observation.canonicalPath);

  const targetPath = path.join(root, 'space-a');
  mkdirSync(targetPath);
  const grantStore = new EmptyFolderGrantStore({ db });
  const grant = grantStore.issue(authorizeEmptyDirectory(targetPath), 'principal-fence');
  const created = await createDevelopmentWorkspace(db, {
    commandId: 'cmd-fence-create',
    projectId: 'proj-fence',
    name: 'fence-space',
    grantId: grant.grantId,
    principalHash: 'principal-fence',
    expectedBaseHead: observation.after.head,
  }, { probe: probeGitWorktree, grantStore });
  assert.equal(created.ok, true, JSON.stringify(created));

  return {
    root, db, repoDir, targetPath,
    repositoryIdentity: observation.repositoryIdentity,
    mainWorktreeId,
    headSha: observation.after.head,
    space: created,
    cleanup,
  };
}

const reservationRow = (db, repositoryIdentity) => db.prepare(
  'SELECT * FROM workspace_lifecycle_reservations WHERE repository_identity = ?',
).get(repositoryIdentity);

const commandRow = (db, commandId) => db.prepare('SELECT * FROM commands WHERE id = ?').get(commandId);

const RUN_LEASE_CONFIRMATION_REQUIRED_TEXT = (() => {
  const source = readFileSync(new URL('../src/service/http-server.mjs', import.meta.url), 'utf8');
  const entry = source.split('RUN_LEASE_CONFIRMATION_REQUIRED: {')[1] ?? '';
  return entry.split('},')[0];
})();

const CRASH_POINT = 'workspace.reuse.after_git_before_finalize';

// Reproduces the defect the stage log records as verified-but-unrepaired: a
// lifecycle command that dies after its Git effect keeps a durable reservation
// keyed on the repository, and once the frozen CAS baseline stops matching
// reality no product path can end either the reservation or its journal row.
test('a lifecycle command that dies after its Git effect leaves a non-expiring repository fence', async (t) => {
  const f = await fixture(t);
  const reuseRequest = {
    commandId: 'cmd-fence-reuse',
    projectId: 'proj-fence',
    spaceId: f.space.spaceId,
    expectedRevision: f.space.space.revision,
    expectedBaseHead: f.headSha,
  };

  // 1. The Git effect lands, then the executor dies before finalisation.
  await assert.rejects(() => reuseDevelopmentWorkspace(f.db, reuseRequest, {
    faultInjector: (point) => {
      if (point === CRASH_POINT) throw new Error('simulated executor loss');
    },
  }));

  const afterCrash = reservationRow(f.db, f.repositoryIdentity);
  assert.ok(afterCrash, 'the reservation must survive the crash as a durable fence');
  assert.equal(afterCrash.state, 'unknown');
  assert.equal(afterCrash.command_id, reuseRequest.commandId);
  assert.equal(commandRow(f.db, reuseRequest.commandId).state, 'received',
    'the journal row stays non-terminal');

  // 2. The repository lock the same command held is persistent: it is not
  // merely long-lived, it is dated at the end of time and only its owner can
  // renew or release it.
  const lock = f.db.prepare('SELECT * FROM repository_locks WHERE repository_identity = ?')
    .get(f.repositoryIdentity);
  assert.ok(lock, 'the crashed command must still hold the repository lock');
  assert.equal(lock.holder, reuseRequest.commandId);
  assert.equal(lock.expires_at, PERSISTENT_LOCK_EXPIRY);
  assert.ok(new Date(lock.expires_at).getUTCFullYear() > 9000,
    'the fence must not depend on an ordinary TTL expiring');

  // 3. Any unrelated durable change to the space is enough to strand it: the
  // workbench offers pause, so a user pressing a normal button does it.
  const paused = updateDevelopmentSpaceStatus(f.db, {
    commandId: 'cmd-fence-pause',
    spaceId: f.space.spaceId,
    expectedRevision: f.space.space.revision,
    status: 'paused',
    statusReason: 'user_paused',
  });
  assert.equal(paused.ok, true, JSON.stringify(paused));

  // 4. Replaying the original command can never succeed again: its baseline is
  // frozen, and the failure is reported as unknown so the fence stays.
  const retry = await reuseDevelopmentWorkspace(f.db, reuseRequest);
  assert.equal(retry.ok, false);
  assert.equal(retry.code, 'SPACE_REVISION_CONFLICT');
  assert.equal(retry.outcome, 'unknown');
  assert.ok(reservationRow(f.db, f.repositoryIdentity), 'the fence survives the replay');

  // 5. A brand new command for the same space is refused, and the refusal names
  // the dead command as its blocker: nothing can retire that command.
  const fresh = await reuseDevelopmentWorkspace(f.db, {
    ...reuseRequest,
    commandId: 'cmd-fence-reuse-2',
    expectedRevision: paused.revision,
  });
  assert.equal(fresh.ok, false);
  assert.equal(fresh.code, 'REPOSITORY_LOCKED');
  assert.equal(fresh.blockedByCommandId, reuseRequest.commandId);

  // 6. The fence is keyed on the repository, so an unrelated worktree — the
  // main checkout a new AI session would use — cannot take a write lease.
  const mainObservation = await probeGitWorktree(f.repoDir);
  const run = startWriteRun(f.db, {
    commandId: 'cmd-fence-run',
    worktreeId: f.mainWorktreeId,
    canonicalPath: mainObservation.canonicalPath,
    repositoryIdentity: f.repositoryIdentity,
    worktreeIdentity: mainObservation.worktreeIdentity,
    agentClaim: 'claim',
    goal: 'goal',
    baseline: {
      head: mainObservation.after.head,
      branch: mainObservation.after.branch,
      indexFingerprint: mainObservation.after.indexFingerprint,
      worktreeFingerprint: mainObservation.after.worktreeFingerprint,
      repositoryIdentity: f.repositoryIdentity,
      worktreeIdentity: mainObservation.worktreeIdentity,
      coherence: mainObservation.coherence,
      observedAt: mainObservation.observedAt,
    },
  });
  assert.equal(run.ok, false, JSON.stringify(run));
  assert.equal(run.code, 'WORKSPACE_LIFECYCLE_IN_PROGRESS',
    'a stuck space reservation must not fence the repository write path');

  // 7. Deleting the reservation row alone does not help: the non-terminal
  // journal row rebuilds the same lock refusal, so a repair has to settle
  // every layer at once.
  f.db.prepare('DELETE FROM workspace_lifecycle_reservations').run();
  const removal = await removeDevelopmentWorkspace(f.db, {
    commandId: 'cmd-fence-remove',
    projectId: 'proj-fence',
    spaceId: f.space.spaceId,
    expectedRevision: paused.revision,
  });
  assert.equal(removal.ok, false);
  assert.equal(removal.code, 'REPOSITORY_LOCKED', JSON.stringify(removal));
});

// The repair: one explicit, user-confirmed abandon settles every durable layer
// at once, refuses while an executor could still be running, replays
// idempotently, and leaves the code itself untouched.
test('a user-confirmed abandon ends the fence and the repository works again', async (t) => {
  const f = await fixture(t);
  const reuseRequest = {
    commandId: 'cmd-abandon-reuse',
    projectId: 'proj-fence',
    spaceId: f.space.spaceId,
    expectedRevision: f.space.space.revision,
    expectedBaseHead: f.headSha,
  };
  const abandonBase = {
    repositoryIdentity: f.repositoryIdentity,
    blockedCommandId: reuseRequest.commandId,
  };

  await assert.rejects(() => reuseDevelopmentWorkspace(f.db, reuseRequest, {
    faultInjector: (point) => {
      if (point === CRASH_POINT) throw new Error('simulated executor loss');
    },
  }));
  assert.ok(reservationRow(f.db, f.repositoryIdentity));

  // Without the confirmation marker nothing is released.
  const unconfirmed = abandonWorkspaceLifecycle(f.db, {
    commandId: 'cmd-abandon-unconfirmed', ...abandonBase,
  });
  assert.equal(unconfirmed.ok, false);
  assert.equal(unconfirmed.code, 'WORKSPACE_LIFECYCLE_CONFIRMATION_REQUIRED');
  assert.ok(reservationRow(f.db, f.repositoryIdentity), 'a refusal must not lift the fence');

  // While this very process generation could still be the executor, abandoning
  // would let a second lifecycle operation race the first one's Git effect.
  f.db.prepare(
    'UPDATE workspace_lifecycle_reservations SET owner_pid = ?, owner_started_at = ? WHERE repository_identity = ?',
  ).run(process.pid, currentProcessStartTime(), f.repositoryIdentity);
  const tooEarly = abandonWorkspaceLifecycle(f.db, {
    commandId: 'cmd-abandon-too-early', ...abandonBase, userConfirmed: true,
  });
  assert.equal(tooEarly.ok, false);
  assert.equal(tooEarly.code, 'WORKSPACE_LIFECYCLE_EXECUTING');
  assert.ok(reservationRow(f.db, f.repositoryIdentity));
  f.db.prepare(
    'UPDATE workspace_lifecycle_reservations SET owner_pid = 0, owner_started_at = NULL WHERE repository_identity = ?',
  ).run(f.repositoryIdentity);

  const branchesBefore = execFileSync('git', [...SAFE_GIT_PREFIX, 'branch', '--format=%(refname:short)'], {
    cwd: f.repoDir, encoding: 'utf8', env: safeGitEnvironment(), windowsHide: true,
  });

  const abandoned = abandonWorkspaceLifecycle(f.db, {
    commandId: 'cmd-abandon', ...abandonBase, userConfirmed: true,
  });
  assert.equal(abandoned.ok, true, JSON.stringify(abandoned));
  assert.equal(abandoned.abandonedCommandId, reuseRequest.commandId);
  assert.equal(reservationRow(f.db, f.repositoryIdentity), undefined, 'reservation released');
  assert.equal(commandRow(f.db, reuseRequest.commandId).state, 'failed', 'journal row settled');
  assert.equal(f.db.prepare('SELECT * FROM repository_locks WHERE repository_identity = ?')
    .get(f.repositoryIdentity), undefined, 'persistent repository lock released');

  const branchesAfter = execFileSync('git', [...SAFE_GIT_PREFIX, 'branch', '--format=%(refname:short)'], {
    cwd: f.repoDir, encoding: 'utf8', env: safeGitEnvironment(), windowsHide: true,
  });
  assert.equal(branchesAfter, branchesBefore, 'abandoning a fence must not touch the code');

  // The same abandon command replays with the original receipt.
  const replay = abandonWorkspaceLifecycle(f.db, {
    commandId: 'cmd-abandon', ...abandonBase, userConfirmed: true,
  });
  assert.deepEqual(replay, abandoned);

  // A new command for the same space now reaches the real preconditions, and a
  // new lifecycle fence can be raised and cleared on its own terms.
  const spaceNow = f.db.prepare('SELECT * FROM development_spaces WHERE id = ?').get(f.space.spaceId);
  assert.equal(spaceNow.status, 'attention');
  const recovered = await reuseDevelopmentWorkspace(f.db, {
    commandId: 'cmd-abandon-reuse-2',
    projectId: 'proj-fence',
    spaceId: f.space.spaceId,
    expectedRevision: spaceNow.revision,
    expectedBaseHead: f.headSha,
  });
  assert.equal(recovered.ok, true, JSON.stringify(recovered));

  const mainObservation = await probeGitWorktree(f.repoDir);
  const run = startWriteRun(f.db, {
    commandId: 'cmd-abandon-run',
    worktreeId: f.mainWorktreeId,
    canonicalPath: mainObservation.canonicalPath,
    repositoryIdentity: f.repositoryIdentity,
    worktreeIdentity: mainObservation.worktreeIdentity,
    agentClaim: 'claim',
    goal: 'goal',
    baseline: {
      head: mainObservation.after.head,
      branch: mainObservation.after.branch,
      indexFingerprint: mainObservation.after.indexFingerprint,
      worktreeFingerprint: mainObservation.after.worktreeFingerprint,
      repositoryIdentity: f.repositoryIdentity,
      worktreeIdentity: mainObservation.worktreeIdentity,
      coherence: mainObservation.coherence,
      observedAt: mainObservation.observedAt,
    },
  });
  assert.equal(run.ok, true, JSON.stringify(run));
});

// The fence has to be escapable from the product, not only from JavaScript:
// the route is browser-only, refuses without the confirmation marker, settles
// the fence, and replays its receipt.
test('the workbench route exposes, guards and clears the lifecycle fence', async (t) => {
  const f = await fixture(t, { autoCleanup: false });
  const reuseRequest = {
    commandId: 'cmd-http-reuse',
    projectId: 'proj-fence',
    spaceId: f.space.spaceId,
    expectedRevision: f.space.space.revision,
    expectedBaseHead: f.headSha,
  };
  await assert.rejects(() => reuseDevelopmentWorkspace(f.db, reuseRequest, {
    faultInjector: (point) => {
      if (point === CRASH_POINT) throw new Error('simulated executor loss');
    },
  }));

  const apiToken = 'lifecycle-fence-fixture-token-0000000000000000';
  const service = await createCockpitHttpServer({
    dbPath: path.join(f.root, 'cockpit.db'),
    token: apiToken,
    serveWebAsset: async ({ pathname, response, sessionToken }) => {
      if (pathname !== '/') return false;
      response.setHeader('set-cookie', `ugk_cockpit_session=${sessionToken}; HttpOnly; SameSite=Strict`);
      response.end('fixture');
      return true;
    },
  });
  t.after(async () => {
    await service.close();
    f.cleanup();
  });

  const base = `http://${service.host}:${service.port}`;
  const shell = await fetch(`${base}/`);
  await shell.text();
  const browserHeaders = {
    cookie: shell.headers.get('set-cookie'),
    origin: base,
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
    'x-ugk-client-id': 'lifecycle-fence-browser',
  };
  const route = '/api/v1/projects/proj-fence/workspace-lifecycle';

  const seen = await (await fetch(`${base}${route}`, {
    headers: { authorization: `Bearer ${apiToken}` },
  })).json();
  assert.equal(seen.ok, true);
  assert.equal(seen.fence.blockedCommandId, reuseRequest.commandId);
  assert.equal(seen.fence.executorCouldBeRunning, false);
  assert.equal(seen.fence.canAbandon, true);

  const agentHeaders = { ...browserHeaders, authorization: `Bearer ${apiToken}` };
  delete agentHeaders.cookie;
  const asAgent = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: agentHeaders,
    body: JSON.stringify({ commandId: 'cmd-http-abandon', blockedCommandId: reuseRequest.commandId, userConfirmed: true }),
  });
  assert.equal(asAgent.status, 401, 'an Agent credential must not lift a user fence');
  await asAgent.text();

  const unconfirmed = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: browserHeaders,
    body: JSON.stringify({ commandId: 'cmd-http-abandon-nc', blockedCommandId: reuseRequest.commandId }),
  });
  assert.equal(unconfirmed.status, 409);
  assert.equal((await unconfirmed.json()).code, 'WORKSPACE_LIFECYCLE_CONFIRMATION_REQUIRED');
  assert.ok(reservationRow(f.db, f.repositoryIdentity), 'a refused abandon must leave the fence');

  const done = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: browserHeaders,
    body: JSON.stringify({ commandId: 'cmd-http-abandon', blockedCommandId: reuseRequest.commandId, userConfirmed: true }),
  });
  assert.equal(done.status, 200, await done.clone().text());
  const receipt = await done.json();
  assert.equal(receipt.ok, true);
  assert.equal(receipt.lockReleased, true);

  const replay = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: browserHeaders,
    body: JSON.stringify({ commandId: 'cmd-http-abandon', blockedCommandId: reuseRequest.commandId, userConfirmed: true }),
  });
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), receipt, 'the same request replays the same receipt');

  const after = await (await fetch(`${base}${route}`, {
    headers: { authorization: `Bearer ${apiToken}` },
  })).json();
  assert.equal(after.fence, null);
});

// A fence can also exist without any reservation row: the migration that
// backfilled reservations refused to guess which of several unsettled commands
// produced a Git effect, and a command can outlive its reservation. The exit has
// to name those commands too, or the console reports "nothing is stuck" while
// every write session keeps being refused.
test('a fence carried only by journal rows is described and can be settled', async (t) => {
  const f = await fixture(t);
  const space = f.db.prepare('SELECT * FROM development_spaces WHERE id = ?').get(f.space.spaceId);
  const pending = (commandId, spaceId) => {
    beginCommand(f.db, {
      commandId,
      kind: 'workspace.reuse',
      request: {
        commandId,
        projectId: 'proj-fence',
        spaceId,
        expectedRevision: space.revision,
        expectedBaseHead: f.headSha,
        nextBranch: 'cockpit/orphaned',
      },
    });
  };
  pending('cmd-orphan-1', f.space.spaceId);
  pending('cmd-orphan-2', f.space.spaceId);

  const fence = describeWorkspaceLifecycleFence(f.db, f.repositoryIdentity);
  assert.ok(fence, 'a journal-only fence must still be visible');
  assert.equal(fence.source, 'journal');
  assert.deepEqual(fence.pendingCommandIds, ['cmd-orphan-1', 'cmd-orphan-2']);
  assert.equal(fence.canAbandon, true);

  const first = abandonWorkspaceLifecycle(f.db, {
    commandId: 'cmd-settle-1',
    repositoryIdentity: f.repositoryIdentity,
    blockedCommandId: 'cmd-orphan-1',
    userConfirmed: true,
  });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.fenceSource, 'journal');
  assert.deepEqual(first.remainingPendingCommandIds, ['cmd-orphan-2']);
  assert.equal(commandRow(f.db, 'cmd-orphan-1').state, 'failed');

  const still = describeWorkspaceLifecycleFence(f.db, f.repositoryIdentity);
  assert.deepEqual(still.pendingCommandIds, ['cmd-orphan-2']);

  const second = abandonWorkspaceLifecycle(f.db, {
    commandId: 'cmd-settle-2',
    repositoryIdentity: f.repositoryIdentity,
    blockedCommandId: 'cmd-orphan-2',
    userConfirmed: true,
  });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(describeWorkspaceLifecycleFence(f.db, f.repositoryIdentity), null,
    'settling every unsettled command must leave no fence');

  // A project that is off the dashboard still owns its fence.
  f.db.prepare('UPDATE projects SET removed_at = ? WHERE id = ?')
    .run(new Date().toISOString(), 'proj-fence');
  pending('cmd-orphan-3', f.space.spaceId);
  assert.equal(resolveFenceRepositoryIdentity(f.db, 'proj-fence'), f.repositoryIdentity,
    'a removed project must still resolve to its repository fence');
  const third = abandonWorkspaceLifecycle(f.db, {
    commandId: 'cmd-settle-3',
    repositoryIdentity: f.repositoryIdentity,
    blockedCommandId: 'cmd-orphan-3',
    userConfirmed: true,
  });
  assert.equal(third.ok, true, JSON.stringify(third));
});

// Every refusal that only lasts until something else clears must leave this
// request open, or the retry the workbench offers would keep replaying a cached
// "no" after the reason is gone. The confirmation refusal must not consume the
// command id either, so the operator can confirm under the same id.
test('abandon refusals stay retryable under the same command id', async (t) => {
  const f = await fixture(t);
  const reuseRequest = {
    commandId: 'cmd-retry-reuse',
    projectId: 'proj-fence',
    spaceId: f.space.spaceId,
    expectedRevision: f.space.space.revision,
    expectedBaseHead: f.headSha,
  };
  await assert.rejects(() => reuseDevelopmentWorkspace(f.db, reuseRequest, {
    faultInjector: (point) => {
      if (point === CRASH_POINT) throw new Error('simulated executor loss');
    },
  }));
  const base = {
    repositoryIdentity: f.repositoryIdentity,
    blockedCommandId: reuseRequest.commandId,
  };

  // 1. Refused for missing confirmation: no journal row is consumed, so the very
  // same command id can carry the confirmation.
  const unconfirmed = abandonWorkspaceLifecycle(f.db, { commandId: 'cmd-retry-1', ...base });
  assert.equal(unconfirmed.code, 'WORKSPACE_LIFECYCLE_CONFIRMATION_REQUIRED');
  assert.equal(readCommand(f.db, 'cmd-retry-1'), undefined,
    'a refusal before the request is recorded must not burn the command id');

  // 2. Refused while this process generation could still be the executor, and
  // the command stays non-terminal so the retry is not a cached answer.
  f.db.prepare(
    'UPDATE workspace_lifecycle_reservations SET owner_pid = ?, owner_started_at = ? WHERE repository_identity = ?',
  ).run(process.pid, currentProcessStartTime(), f.repositoryIdentity);
  const executing = abandonWorkspaceLifecycle(f.db, { commandId: 'cmd-retry-1', ...base, userConfirmed: true });
  assert.equal(executing.code, 'WORKSPACE_LIFECYCLE_EXECUTING');
  assert.equal(readCommand(f.db, 'cmd-retry-1').state, 'received',
    'a transient refusal must leave the request open');

  // 3. Refused while the worktree still has live work — also transient.
  f.db.prepare(
    'UPDATE workspace_lifecycle_reservations SET owner_pid = 0, owner_started_at = NULL WHERE repository_identity = ?',
  ).run(f.repositoryIdentity);
  // Live work is recorded directly: new work sessions cannot get past the
  // fence itself, so this guard protects the state that was already there when
  // the fence went up, and that is exactly the case the operator must not be
  // allowed to unwind by accident.
  const at = new Date().toISOString();
  f.db.prepare(`
    INSERT INTO runs (
      id, worktree_id, mode, lifecycle, health, revision, lease_generation,
      agent_claim, goal, created_at
    ) VALUES ('session-holding-lease', ?, 'write', 'active', 'healthy', 1, 0, 'claim', '占住这个开发空间', ?)
  `).run(f.space.worktreeId, at);
  f.db.prepare(
    'INSERT INTO write_leases (worktree_id, run_id, generation, acquired_at) VALUES (?, ?, 1, ?)',
  ).run(f.space.worktreeId, 'session-holding-lease', at);
  const busy = abandonWorkspaceLifecycle(f.db, { commandId: 'cmd-retry-1', ...base, userConfirmed: true });
  assert.equal(busy.code, 'SPACE_HAS_ACTIVE_WORK', JSON.stringify(busy));
  assert.equal(readCommand(f.db, 'cmd-retry-1').state, 'received',
    'the active-work refusal must stay retryable too');
  assert.ok(reservationRow(f.db, f.repositoryIdentity), 'a refusal leaves the fence intact');

  // 4. Once the condition clears, the same command id completes.
  f.db.prepare('DELETE FROM write_leases WHERE run_id = ?').run('session-holding-lease');
  f.db.prepare("UPDATE runs SET lifecycle = 'completed' WHERE id = ?").run('session-holding-lease');
  const after = abandonWorkspaceLifecycle(f.db, { commandId: 'cmd-retry-1', ...base, userConfirmed: true });
  assert.equal(after.ok, true, JSON.stringify(after));
  assert.equal(readCommand(f.db, 'cmd-retry-1').state, 'committed');
  assert.equal(reservationRow(f.db, f.repositoryIdentity), undefined);
});

// Two more ways the console could tell a comfortable lie about the same fence.
test('the fence description also names lock-only and snake_case journal rows', async (t) => {
  const f = await fixture(t);

  // A persistent lock whose command already reached a terminal state: writes
  // stay refused, so reporting "nothing is stuck" would be wrong.
  const at = new Date().toISOString();
  f.db.prepare(`
    INSERT INTO commands (id, kind, request_digest, request_json, state, run_id, created_at, updated_at)
    VALUES ('cmd-terminal-holder', 'workspace.reuse', 'digest', '{}', 'failed', NULL, ?, ?)
  `).run(at, at);
  f.db.prepare(`
    INSERT INTO repository_locks (
      repository_identity, lock_id, holder, operation, expires_at, acquired_at, updated_at, command_id
    ) VALUES (?, 'lock-orphan', 'cmd-terminal-holder', 'reuse_workspace', ?, ?, ?, NULL)
  `).run(f.repositoryIdentity, PERSISTENT_LOCK_EXPIRY, at, at);

  const lockOnly = describeWorkspaceLifecycleFence(f.db, f.repositoryIdentity);
  assert.equal(lockOnly.source, 'lock');
  assert.equal(lockOnly.canAbandon, false, 'no release path is offered for an orphan lock');
  assert.equal(lockOnly.lock.holder, 'cmd-terminal-holder');

  f.db.prepare('DELETE FROM repository_locks WHERE repository_identity = ?').run(f.repositoryIdentity);
  f.db.prepare('DELETE FROM commands WHERE id = ?').run('cmd-terminal-holder');
  assert.equal(describeWorkspaceLifecycleFence(f.db, f.repositoryIdentity), null);

  // A frozen request written with snake_case keys is still a fence: the write
  // admission accepts both spellings, so the console must not lose it.
  const space = f.db.prepare('SELECT * FROM development_spaces WHERE id = ?').get(f.space.spaceId);
  beginCommand(f.db, {
    commandId: 'cmd-snake',
    kind: 'workspace.remove',
    request: { command_id: 'cmd-snake', project_id: 'proj-fence', space_id: f.space.spaceId },
  });
  assert.ok(space);
  const snake = describeWorkspaceLifecycleFence(f.db, f.repositoryIdentity);
  assert.equal(snake.source, 'journal');
  assert.deepEqual(snake.pendingCommandIds, ['cmd-snake']);
});

// The published guidance for the orphaned-lease release used to tell the
// operator to "run the release again with the confirmation marker". That is not
// possible: the unconfirmed attempt is terminalized in the journal by design (the
// refusal must be on record), and the marker is part of the frozen request, so
// replaying the same command id either returns the cached refusal or fails as
// COMMAND_CONFLICT. Reproduced: `Command cmd-lease-release was already used with
// a different request.` The guidance now says to use a new operation id, and this
// pins the path it describes.
test('the orphaned write lease release guidance matches real behaviour', async (t) => {
  const f = await fixture(t);
  const mainObservation = await probeGitWorktree(f.repoDir);
  const start = startWriteRun(f.db, {
    commandId: 'cmd-lease-run',
    runId: 'session-orphan',
    worktreeId: f.mainWorktreeId,
    canonicalPath: mainObservation.canonicalPath,
    repositoryIdentity: f.repositoryIdentity,
    worktreeIdentity: mainObservation.worktreeIdentity,
    agentClaim: 'claim',
    goal: '留下一个孤儿租约',
    baseline: {
      head: mainObservation.after.head, branch: mainObservation.after.branch,
      indexFingerprint: mainObservation.after.indexFingerprint,
      worktreeFingerprint: mainObservation.after.worktreeFingerprint,
      repositoryIdentity: f.repositoryIdentity,
      worktreeIdentity: mainObservation.worktreeIdentity,
      coherence: mainObservation.coherence, observedAt: mainObservation.observedAt,
    },
  });
  assert.equal(start.ok, true, JSON.stringify(start));

  const refused = releaseOrphanedWriteRun(f.db, {
    commandId: 'cmd-lease-refused', runId: 'session-orphan',
    expectedRevision: 1, leaseGeneration: start.leaseGeneration,
  });
  assert.equal(refused.code, 'RUN_LEASE_CONFIRMATION_REQUIRED', JSON.stringify(refused));
  assert.equal(commandRow(f.db, 'cmd-lease-refused').state, 'failed',
    'the refusal itself stays on the record, by design');

  // Replaying it with the marker is not the way out; a new operation id is.
  assert.throws(() => releaseOrphanedWriteRun(f.db, {
    commandId: 'cmd-lease-refused', runId: 'session-orphan',
    expectedRevision: 1, leaseGeneration: start.leaseGeneration, userConfirmed: true,
  }), /already used with a different request/);
  const released = releaseOrphanedWriteRun(f.db, {
    commandId: 'cmd-lease-release', runId: 'session-orphan',
    expectedRevision: 1, leaseGeneration: start.leaseGeneration, userConfirmed: true,
  });
  assert.equal(released.ok, true, JSON.stringify(released));
  assert.equal(RUN_LEASE_CONFIRMATION_REQUIRED_TEXT.includes('新的操作编号'), true,
    'the message the operator is shown must match the step that actually works');
});
