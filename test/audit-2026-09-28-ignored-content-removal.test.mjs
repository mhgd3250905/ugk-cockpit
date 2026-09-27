import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { EmptyFolderGrantStore } from '../src/core/folder-grants.mjs';
import { authorizeEmptyDirectory } from '../src/core/path-guard.mjs';
import {
  createDevelopmentWorkspace,
  removeDevelopmentWorkspace,
} from '../src/core/workspaces.mjs';
import { probeGitWorktree, safeGitEnvironment, SAFE_GIT_PREFIX } from '../src/git/probe.mjs';
import { createCockpitHttpServer } from '../src/service/http-server.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const execFileAsync = promisify(execFile);

async function runGit(cwd, args) {
  return (await execFileAsync('git', [...SAFE_GIT_PREFIX, ...args], {
    cwd,
    windowsHide: true,
    shell: false,
    encoding: 'utf8',
    env: safeGitEnvironment(),
  })).stdout.trim();
}

function fixtureTempRoot() {
  return process.platform === 'win32' ? os.tmpdir() : realpathSync(os.tmpdir());
}

async function workspaceFixture(t, gitignoreContent) {
  const root = mkdtempSync(path.join(fixtureTempRoot(), 'ugk-cockpit-ignored-'));
  const db = openCockpitDatabase(path.join(root, 'cockpit.db'));
  // One hook, ordered: node:test runs t.after callbacks FIFO, so a directory
  // removal registered before db.close() would hit an open SQLite handle.
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const repoDir = path.join(root, 'main-repo');
  mkdirSync(repoDir, { recursive: true });
  await runGit(repoDir, ['init', '-b', 'main']);
  await runGit(repoDir, ['config', 'user.name', 'Test User']);
  await runGit(repoDir, ['config', 'user.email', 'test@example.com']);
  if (gitignoreContent !== undefined) {
    writeFileSync(path.join(repoDir, '.gitignore'), gitignoreContent);
  }
  writeFileSync(path.join(repoDir, 'README.md'), '# Main Repo\n');
  await runGit(repoDir, ['add', '.']);
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
    ) VALUES ('proj-1', 'Ignored Content Project', 'development',
      'wt-main', 'ready', 'ready_to_start', ?, ?, ?, ?, ?)
  `).run(at, at, at, observation.repositoryIdentity, observation.canonicalPath);

  const spacePath = path.join(root, 'space-a');
  mkdirSync(spacePath);
  const grantStore = new EmptyFolderGrantStore({ db });
  const grant = grantStore.issue(authorizeEmptyDirectory(spacePath), 'principal-a');
  const created = await createDevelopmentWorkspace(db, {
    commandId: 'cmd-create-ignored',
    projectId: 'proj-1',
    name: 'ignored-space',
    grantId: grant.grantId,
    principalHash: 'principal-a',
    expectedBaseHead: observation.after.head,
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  return { root, db, repoDir, spacePath, space: created.space, spaceId: created.spaceId };
}

// The product refuses to remove a workspace whose tracked files are dirty
// (`status --porcelain -z --untracked-files=normal`), but that口径 never lists
// git-IGNORED paths, while `git worktree remove` deletes them anyway.
test('删除含被忽略文件的工作副本必须先取得用户确认，且未确认时一个字节都不删', async (t) => {
  const f = await workspaceFixture(t, 'local-data/\n');
  mkdirSync(path.join(f.spacePath, 'local-data'), { recursive: true });
  const onlyCopy = path.join(f.spacePath, 'local-data', 'only-copy.md');
  writeFileSync(onlyCopy, '只存在于这台机器上的资料\n');

  // The existing dirty gate cannot see it: the workspace counts as clean.
  const observation = await probeGitWorktree(f.spacePath);
  assert.equal(observation.after.hasChanges, false,
    'the ignored file is invisible to the hasChanges口径 this test is about');

  const refused = await removeDevelopmentWorkspace(f.db, {
    commandId: 'cmd-remove-ignored-unconfirmed',
    projectId: 'proj-1',
    spaceId: f.spaceId,
    expectedRevision: f.space.revision,
  });
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.equal(refused.code, 'WORKSPACE_IGNORED_CONTENT_CONFIRMATION_REQUIRED',
    JSON.stringify(refused));
  assert.equal(existsSync(onlyCopy), true,
    'an ignored-only copy must survive an unconfirmed removal');
  assert.equal(existsSync(f.spacePath), true, 'the workspace directory must survive too');

  // Confirming with a NEW command id (the refusal is journaled under the old
  // one) removes it, and says how much content went with it.
  const removed = await removeDevelopmentWorkspace(f.db, {
    commandId: 'cmd-remove-ignored-confirmed',
    projectId: 'proj-1',
    spaceId: f.spaceId,
    expectedRevision: f.space.revision,
    userConfirmedIgnoredRemoval: true,
  }, { probe: probeGitWorktree });
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.equal(existsSync(f.spacePath), false);
});

test('反向界：没有被忽略内容的工作副本仍按原样直接删除，不要求确认', async (t) => {
  const f = await workspaceFixture(t, 'local-data/\n');
  const removed = await removeDevelopmentWorkspace(f.db, {
    commandId: 'cmd-remove-clean',
    projectId: 'proj-1',
    spaceId: f.spaceId,
    expectedRevision: f.space.revision,
  }, { probe: probeGitWorktree });
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.equal(existsSync(f.spacePath), false);
});

test('未跟踪文件仍然直接拒绝删除，确认被忽略内容也不能绕过它', async (t) => {
  const f = await workspaceFixture(t, 'local-data/\n');
  mkdirSync(path.join(f.spacePath, 'local-data'), { recursive: true });
  writeFileSync(path.join(f.spacePath, 'local-data', 'ignored.md'), 'ignored\n');
  writeFileSync(path.join(f.spacePath, 'unfinished.txt'), '还没有保存的工作\n');

  const refused = await removeDevelopmentWorkspace(f.db, {
    commandId: 'cmd-remove-untracked',
    projectId: 'proj-1',
    spaceId: f.spaceId,
    expectedRevision: f.space.revision,
    userConfirmedIgnoredRemoval: true,
  }, { probe: probeGitWorktree });
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.equal(refused.code, 'WORKSPACE_HAS_CHANGES', JSON.stringify(refused));
  assert.equal(existsSync(path.join(f.spacePath, 'unfinished.txt')), true,
    'unsaved work must never be deleted on the strength of an ignored-content confirmation');
});

// The same decision has to survive the HTTP boundary: the workbench sends the
// flag, an unknown key is still refused, and the refusal arrives with the
// what-happened / is-my-code-safe / what-next triple AGENTS.md requires.
test('HTTP 边界：确认标记被接受，未确认的删除返回 409 与可执行的下一步', async (t) => {
  const f = await workspaceFixture(t, 'local-data/\n');
  mkdirSync(path.join(f.spacePath, 'local-data'), { recursive: true });
  const onlyCopy = path.join(f.spacePath, 'local-data', 'only-copy.md');
  writeFileSync(onlyCopy, '只存在于这台机器上的资料\n');

  const token = 'e'.repeat(40);
  const dbPath = path.join(f.root, 'cockpit.db');
  const service = await createCockpitHttpServer({ dbPath, token });
  try {
    const post = (body, spaceId = f.spaceId) => fetch(
      `http://${service.host}:${service.port}/api/v1/projects/proj-1/spaces/${spaceId}/remove`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );

    const unknownKey = await post({ commandId: 'cmd-http-unknown', expectedRevision: 1, bogus: 1 });
    assert.equal(unknownKey.status, 400, await unknownKey.clone().text());

    // The confirmation is a boolean by contract; a non-boolean must not be
    // silently coerced into "not confirmed" downstream.
    const badFlag = await post({
      commandId: 'cmd-http-bad-flag',
      expectedRevision: f.space.revision,
      userConfirmedIgnoredRemoval: 'yes',
    });
    assert.equal(badFlag.status, 400, await badFlag.clone().text());
    assert.equal(existsSync(onlyCopy), true, 'a rejected body must not delete anything');

    // The flag must not leak into the reuse branch of the same route.
    const reuseWithFlag = await fetch(
      `http://${service.host}:${service.port}/api/v1/projects/proj-1/spaces/${f.spaceId}/reuse`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId: 'cmd-http-reuse-flag',
          expectedRevision: f.space.revision,
          expectedBaseHead: f.space.baseCommit,
          userConfirmedIgnoredRemoval: true,
        }),
      },
    );
    assert.equal(reuseWithFlag.status, 400, await reuseWithFlag.clone().text());

    const unconfirmed = await post({ commandId: 'cmd-http-unconfirmed', expectedRevision: f.space.revision });
    assert.equal(unconfirmed.status, 409, await unconfirmed.clone().text());
    const refusal = await unconfirmed.json();
    assert.equal(refusal.code, 'WORKSPACE_IGNORED_CONTENT_CONFIRMATION_REQUIRED');
    assert.ok(refusal.message && refusal.impact && refusal.required_action,
      JSON.stringify(refusal));
    assert.match(refusal.required_action, /重新发起/, JSON.stringify(refusal));
    assert.equal(existsSync(onlyCopy), true, 'the HTTP refusal must not have deleted anything');

    // A new command id carries the confirmation (the refusal is journaled under
    // the old one, so replaying it could never proceed).
    const confirmed = await post({
      commandId: 'cmd-http-confirmed',
      expectedRevision: f.space.revision,
      userConfirmedIgnoredRemoval: true,
    });
    assert.equal(confirmed.status, 200, await confirmed.clone().text());
    assert.equal(existsSync(f.spacePath), false);
  } finally {
    // Close the service before the fixture hook closes the database handle.
    await service.close();
  }
});

test('工作台文案必须说明被忽略的文件也会一起删除，并带上确认标记', () => {
  const mainJsx = readFileSync(path.join(repoRoot, 'web', 'src', 'main.jsx'), 'utf8');
  assert.match(mainJsx, /被 Git 忽略的内容（依赖、构建产物、本地数据）也会一起删除/,
    'the remove dialog has to disclose what else is deleted');
  const NL = String.fromCharCode(10);
  const branchStart = mainJsx.indexOf(': {' + NL + '            commandId,' + NL
    + '            expectedRevision: action.space.revision,');
  assert.ok(branchStart >= 0, 'the confirmed remove request block was not found');
  const removeBranch = mainJsx.slice(branchStart, mainJsx.indexOf('record = createWorkspaceActionRecord'));
  assert.match(removeBranch, /userConfirmedIgnoredRemoval: true/,
    'the confirmed dialog action must send the confirmation flag');
});

// The ignored-content probe is a new git call on the deletion path. If it throws
// (locked folder, offline drive, hostile config discovered late) the removal must
// settle like any other pre-effect refusal: a journaled failure, the reservation
// released, and nothing deleted.
test('被忽略内容探测失败时按预检拒绝收束，不把异常抛出删除流程', async (t) => {
  const f = await workspaceFixture(t, 'local-data' + String.fromCharCode(10));
  mkdirSync(path.join(f.spacePath, 'local-data'), { recursive: true });
  const onlyCopy = path.join(f.spacePath, 'local-data', 'only-copy.md');
  writeFileSync(onlyCopy, '只存在于这台机器上的资料' + String.fromCharCode(10));

  const failing = Object.assign(new Error('status probe timed out'), {
    code: 'GIT_STATUS_TIMEOUT',
  });
  const result = await removeDevelopmentWorkspace(f.db, {
    commandId: 'cmd-remove-probe-fails',
    projectId: 'proj-1',
    spaceId: f.spaceId,
    expectedRevision: f.space.revision,
  }, {
    probe: probeGitWorktree,
    countIgnoredWorktreeEntries: async () => { throw failing; },
  });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.code, 'GIT_STATUS_TIMEOUT', JSON.stringify(result));
  assert.equal(result.outcome, 'confirmed_failure', JSON.stringify(result));
  assert.equal(existsSync(onlyCopy), true, 'a failed probe must not delete anything');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM repository_locks').get().n, 0,
    'the repository lock must not be stranded by the failed probe');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM workspace_lifecycle_reservations').get().n, 0,
    'the lifecycle reservation must be settled, not left held open');

  // The same command id replays the journaled refusal instead of retrying git.
  const replay = await removeDevelopmentWorkspace(f.db, {
    commandId: 'cmd-remove-probe-fails',
    projectId: 'proj-1',
    spaceId: f.spaceId,
    expectedRevision: f.space.revision,
  }, { probe: probeGitWorktree });
  assert.equal(replay.code, 'GIT_STATUS_TIMEOUT', JSON.stringify(replay));
});
