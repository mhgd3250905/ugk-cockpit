import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { realpathSync } from 'node:fs';
import { openCockpitDatabase, SUPPORTED_SCHEMA_VERSION } from '../src/core/database.mjs';
import { EmptyFolderGrantStore, FolderGrantStore } from '../src/core/folder-grants.mjs';
import { stageProjectAvatar } from '../src/core/project-avatars.mjs';
import { authorizeEmptyDirectory } from '../src/core/path-guard.mjs';
import { registerProject } from '../src/core/projects.mjs';
import { createDevelopmentWorkspace } from '../src/core/workspaces.mjs';
import {
  currentProcessStartTime,
  reserveWorkspaceLifecycle,
} from '../src/core/workspace-lifecycle.mjs';
import { assertRepositoryAllowedForProbe } from '../src/git/repository-policy.mjs';
import {
  createGitWorktree,
  GIT_OBJECT_ID_PATTERN,
  switchGitWorktreeToNewBranch,
} from '../src/git/workspace-ops.mjs';
import { createCockpitHttpServer } from '../src/service/http-server.mjs';
import { probeGitWorktree } from '../src/git/probe.mjs';
import { inspectZcodeLegacy } from '../scripts/setup-zcode.mjs';

// POSIX 的系统临时目录本身是符号链接；路径授权按契约拒绝穿越链接。
function fixtureTempRoot() {
  return process.platform === 'win32' ? os.tmpdir() : realpathSync(os.tmpdir());
}

const TOKEN = 'audit-2026-09-11-token-that-is-long-enough';

async function post(service, pathname, body) {
  return fetch(`http://${service.host}:${service.port}${pathname}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// A repository whose local config declares a clean filter whose command writes
// a sentinel file. `git status` hashes the dirty tracked file through the
// filter, so the sentinel proves attacker-controlled code ran. The fixture
// itself triggers the filter once while committing .gitattributes, so it
// deletes the sentinel before returning: callers assert on absence AFTER the
// operation under test.
function createHostileRepo(parent, name, sentinelPath) {
  const repo = path.join(parent, name);
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@t.invalid'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
  writeFileSync(path.join(repo, 'file.txt'), 'hello\n');
  execFileSync('git', ['add', 'file.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });
  // `printf` needs no stdin, so the filter child can never linger waiting for
  // input that git may not close promptly; it just writes and exits.
  const command = process.platform === 'win32'
    ? `touch "${sentinelPath}"; printf x`
    : `touch '${sentinelPath}'; printf x`;
  execFileSync('git', ['config', 'filter.evil.clean', command], { cwd: repo });
  writeFileSync(path.join(repo, '.gitattributes'), '*.txt filter=evil\n');
  execFileSync('git', ['add', '.gitattributes'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'attr'], { cwd: repo });
  writeFileSync(path.join(repo, 'file.txt'), 'changed\n');
  rmSync(sentinelPath, { force: true });
  return repo;
}

test('hostile repository: folder selection and registration reject BEFORE the first probe runs filters', async (t) => {
  const container = mkdtempSync(path.join(fixtureTempRoot(), 'ugk-audit-hostile-'));
  const sentinel = path.join(container, 'sentinel-select.txt');
  const hostileRepo = createHostileRepo(container, 'hostile-select', sentinel);
  const cleanup = [];
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
    rmSync(container, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const service = await createCockpitHttpServer({
    dbPath: path.join(container, 'cockpit.db'),
    token: TOKEN,
    folderPicker: async () => hostileRepo,
  });
  cleanup.push(() => service.close());

  const selectResponse = await post(service, '/api/v1/folders/select', {});
  assert.equal(selectResponse.status, 409, `selection must be rejected, got ${selectResponse.status}`);
  const selectBody = await selectResponse.json();
  assert.equal(selectBody.code, 'GIT_FILTER_UNSUPPORTED');
  assert.equal(existsSync(sentinel), false, 'clean filter must not run during folder selection');

  // The same holds for the registration route: a pre-issued grant must not
  // let the registration probe execute repository-local filters either.
  const registrationSentinel = path.join(container, 'sentinel-register.txt');
  const hostileForRegistration = createHostileRepo(container, 'hostile-register', registrationSentinel);
  const grantsDb = openCockpitDatabase(path.join(container, 'cockpit-grants.db'));
  cleanup.push(() => grantsDb.close());
  const grants = new FolderGrantStore({ db: grantsDb });
  // The route claims the grant with sha256 of the bearer token.
  const principalHash = createHash('sha256').update(TOKEN).digest('hex');
  const grant = grants.issue({
    folderPath: hostileForRegistration,
    canonicalPath: hostileForRegistration,
    repositoryIdentity: 'fixture-repository-identity',
    worktreeIdentity: 'fixture-worktree-identity',
  }, principalHash);

  const service2 = await createCockpitHttpServer({
    dbPath: path.join(container, 'cockpit-register.db'),
    token: TOKEN,
    folderGrants: grants,
  });
  cleanup.push(() => service2.close());

  const registerResponse = await post(service2, '/api/v1/projects', {
    commandId: 'register-hostile-fixture',
    grantId: grant.grantId,
    name: 'Hostile Fixture',
  });
  assert.equal(registerResponse.status, 409, `registration must be rejected, got ${registerResponse.status}`);
  const registerBody = await registerResponse.json();
  assert.equal(registerBody.code, 'GIT_FILTER_UNSUPPORTED');
  assert.equal(existsSync(registrationSentinel), false, 'clean filter must not run during registration');
});

test('hostile repository: createDevelopmentWorkspace gates before its first probe', async (t) => {
  const container = mkdtempSync(path.join(fixtureTempRoot(), 'ugk-audit-create-'));
  t.after(() => rmSync(container, { recursive: true, force: true }));
  const sentinel = path.join(container, 'sentinel-create.txt');
  const hostileRepo = createHostileRepo(container, 'hostile-create', sentinel);

  // Setup runs one probe to register the project; remove the sentinel it
  // creates so the assertion afterwards only detects the flow under test.
  const observation = await probeGitWorktree(hostileRepo);
  assert.equal(existsSync(sentinel), true, 'fixture sanity: status itself runs the filter');
  rmSync(sentinel);

  const dbPath = path.join(container, 'cockpit.db');
  const db = openCockpitDatabase(dbPath);
  const registered = registerProject(db, {
    commandId: 'register-hostile-create',
    name: 'Hostile Create',
    authorizedRoot: hostileRepo,
    observation,
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));

  const emptyTarget = path.join(container, 'space-target');
  mkdirSync(emptyTarget);
  const binding = authorizeEmptyDirectory(emptyTarget);
  const grants = new EmptyFolderGrantStore({ db });
  const grant = grants.issue(binding, 'principal-1');

  let probeWasCalled = false;
  const result = await createDevelopmentWorkspace(db, {
    commandId: 'create-hostile-space',
    projectId: registered.projectId,
    grantId: grant.grantId,
    principalHash: 'principal-1',
    expectedBaseHead: observation.after.head,
  }, {
    assertRepositoryAllowed: assertRepositoryAllowedForProbe,
    probe: async () => {
      probeWasCalled = true;
      throw new Error('probe must not run before the repository gate');
    },
    createGitWorktree: async () => { throw new Error('git must not run'); },
    checkBranchExists: async () => { throw new Error('git must not run'); },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'GIT_FILTER_UNSUPPORTED');
  assert.equal(probeWasCalled, false, 'gate must run before the first probe');
  assert.equal(existsSync(sentinel), false, 'no filter execution may happen in the create flow');
  db.close();
});

test('assertRepositoryAllowedForProbe passes non-repositories through so the probe owns that error', async (t) => {
  const container = mkdtempSync(path.join(fixtureTempRoot(), 'ugk-audit-gate-'));
  t.after(() => rmSync(container, { recursive: true, force: true }));
  const plainDir = path.join(container, 'plain');
  mkdirSync(plainDir);
  await assert.doesNotReject(() => assertRepositoryAllowedForProbe(plainDir));
});

test('workspace git layer rejects option injection through baseCommit', async (t) => {
  const container = mkdtempSync(path.join(fixtureTempRoot(), 'ugk-audit-inject-'));
  t.after(() => rmSync(container, { recursive: true, force: true }));
  const repo = path.join(container, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@t.invalid'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
  writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  execFileSync('git', ['add', 'a.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  assert.match(head, GIT_OBJECT_ID_PATTERN, 'fixture sanity: HEAD is a full object id');

  const worktreeTarget = path.join(container, 'injected-worktree');
  for (const hostile of ['--force', 'main', `${head}; rm -rf /`, '--force extra']) {
    await assert.rejects(
      () => createGitWorktree(repo, { targetPath: worktreeTarget, branch: 'cockpit/work/x', baseCommit: hostile }),
      (error) => error.code === 'INVALID_BASE_COMMIT',
      `baseCommit ${JSON.stringify(hostile)} must be rejected`,
    );
    await assert.rejects(
      () => switchGitWorktreeToNewBranch(repo, { branch: 'cockpit/work/x', baseCommit: hostile }),
      (error) => error.code === 'INVALID_BASE_COMMIT',
    );
  }
  assert.equal(existsSync(worktreeTarget), false, 'no worktree may be created from injected values');

  // The honest value keeps working.
  const created = await createGitWorktree(repo, {
    targetPath: worktreeTarget, branch: 'cockpit/work/ok', baseCommit: head,
  });
  assert.equal(created.ok, true);
  rmSync(worktreeTarget, { recursive: true, force: true });
});

test('lifecycle reservation reclaim distinguishes a reused PID from the recorded owner', () => {
  const root = mkdtempSync(path.join(fixtureTempRoot(), 'ugk-audit-lifecycle-'));
  const db = openCockpitDatabase(path.join(root, 'cockpit.db'));
  const now = '2026-09-11T00:00:00.000Z';

  db.prepare(`INSERT INTO commands (id, kind, request_digest, request_json, state, created_at, updated_at)
    VALUES ('cmd-lifecycle', 'workspace.reuse', 'd', '{}', 'received', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO worktrees (id, canonical_path, repository_identity, created_at)
    VALUES ('wt-l', 'C:/nonexistent/lifecycle', 'repo-lifecycle', ?)`).run(now);
  db.prepare(`INSERT INTO projects (id, name, stage, worktree_id, status, status_reason, last_observed_at, created_at, updated_at)
    VALUES ('p-l', 'demo', 'development', 'wt-l', 'active', 'active_work', ?, ?, ?)`).run(now, now, now);
  db.prepare(`INSERT INTO development_spaces (id, project_id, name, branch, base_commit, worktree_id, status, created_at, updated_at)
    VALUES ('s-l', 'p-l', 'space', 'cockpit/work/l', 'head', 'wt-l', 'ready', ?, ?)`).run(now, now);

  const insertReservation = (ownerStartedAt) => db.prepare(`
    INSERT INTO workspace_lifecycle_reservations (
      repository_identity, worktree_id, project_id, space_id, command_id,
      operation, state, epoch, expected_revision, expected_status,
      owner_pid, owner_started_at, owner_token, started_at, updated_at
    ) VALUES ('repo-lifecycle', 'wt-l', 'p-l', 's-l', 'cmd-lifecycle', 'reuse', 'executing',
              1, 0, 'ready', ?, ?, 'token-of-crashed-owner', ?, ?)
  `).run(process.pid, ownerStartedAt, now, now);

  const retry = () => reserveWorkspaceLifecycle(db, {
    repositoryIdentity: 'repo-lifecycle',
    commandId: 'cmd-lifecycle',
    worktreeId: 'wt-l',
    projectId: 'p-l',
    spaceId: 's-l',
    operation: 'reuse',
    expectedRevision: 0,
    allowedStatuses: ['ready'],
  });

  // Same PID, same start time: the executor may genuinely still be running.
  insertReservation(currentProcessStartTime());
  const own = retry();
  assert.equal(own.ok, false);
  assert.equal(own.code, 'WORKSPACE_LIFECYCLE_IN_PROGRESS');

  // Same PID, different start time: a PID reincarnation, not the owner.
  db.prepare('UPDATE workspace_lifecycle_reservations SET owner_started_at = ?')
    .run(currentProcessStartTime() + 5);
  const reclaimed = retry();
  assert.equal(reclaimed.ok, true, JSON.stringify(reclaimed));
  assert.equal(reclaimed.reclaimed, true);

  db.prepare('DELETE FROM workspace_lifecycle_reservations').run();
  // Legacy rows without a recorded start time stay conservative.
  db.prepare(`
    INSERT INTO workspace_lifecycle_reservations (
      repository_identity, worktree_id, project_id, space_id, command_id,
      operation, state, epoch, expected_revision, expected_status,
      owner_pid, owner_token, started_at, updated_at
    ) VALUES ('repo-lifecycle', 'wt-l', 'p-l', 's-l', 'cmd-lifecycle', 'reuse', 'executing',
              1, 0, 'ready', ?, 'legacy-token', ?, ?)
  `).run(process.pid, now, now);
  const legacy = retry();
  assert.equal(legacy.ok, false);
  assert.equal(legacy.code, 'WORKSPACE_LIFECYCLE_IN_PROGRESS');

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('avatar staging failures expose controlled messages without local paths', (t) => {
  const root = mkdtempSync(path.join(fixtureTempRoot(), 'ugk-audit-avatar-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const blockFile = path.join(root, 'blocker');
  writeFileSync(blockFile, 'a plain file, so mkdir below hits ENOTDIR/ENOENT');

  try {
    stageProjectAvatar({
      content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
      originalName: 'avatar.png',
      mimeType: 'image/png',
      storageRoot: path.join(blockFile, 'avatars'),
      projectId: 'project-avatar-fix',
    });
    assert.fail('staging must fail when the storage root cannot be created');
  } catch (error) {
    assert.equal(error.code, 'INVALID_IMAGE_PATH');
    assert.ok(!String(error.message).includes(root), `message must not leak local paths: ${error.message}`);
    assert.match(String(error.message), /头像/);
  }
});

test('schema 28 records reservation owner identity and stays repeatable', (t) => {
  const root = mkdtempSync(path.join(fixtureTempRoot(), 'ugk-audit-schema-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openCockpitDatabase(path.join(root, 'cockpit.db'));
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SUPPORTED_SCHEMA_VERSION);
  assert.equal(SUPPORTED_SCHEMA_VERSION, 28);
  const columns = db.prepare('PRAGMA table_info(workspace_lifecycle_reservations)').all().map((row) => row.name);
  assert.ok(columns.includes('owner_started_at'), 'owner_started_at column must exist');
  db.close();
});

test('setup-zcode legacy detection prefers USERPROFILE over a redirected HOME on Windows', { skip: process.platform !== 'win32' }, (t) => {
  const root = mkdtempSync(path.join(fixtureTempRoot(), 'ugk-audit-home-'));
  const originalHome = process.env.HOME;
  const originalProfile = process.env.USERPROFILE;
  t.after(() => {
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    if (originalProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = originalProfile;
    rmSync(root, { recursive: true, force: true });
  });

  const profileDir = path.join(root, 'profile');
  mkdirSync(path.join(profileDir, '.zcode', 'cli'), { recursive: true });
  writeFileSync(path.join(profileDir, '.zcode', 'cli', 'config.json'), '{ corrupted');
  const redirectedHome = path.join(root, 'bash-home');
  mkdirSync(redirectedHome, { recursive: true });

  process.env.USERPROFILE = profileDir;
  process.env.HOME = redirectedHome;
  assert.throws(
    () => inspectZcodeLegacy(),
    (error) => /repair it before installing/.test(error.message),
    'the existing (corrupt) config under USERPROFILE must be detected even with HOME redirected',
  );
});
