import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { EmptyFolderGrantStore } from '../src/core/folder-grants.mjs';
import { authorizeEmptyDirectory } from '../src/core/path-guard.mjs';
import { createDevelopmentWorkspace, removeDevelopmentWorkspace } from '../src/core/workspaces.mjs';
import { probeGitWorktree, safeGitEnvironment, SAFE_GIT_PREFIX } from '../src/git/probe.mjs';

const execFileAsync = promisify(execFile);

async function runGit(cwd, args) {
  return (await execFileAsync('git', [...SAFE_GIT_PREFIX, ...args], {
    cwd, windowsHide: true, shell: false, encoding: 'utf8', env: safeGitEnvironment(),
  })).stdout.trim();
}

function fixtureTempRoot() {
  return process.platform === 'win32' ? os.tmpdir() : realpathSync(os.tmpdir());
}

// A closed work line that still carries one never-accepted invitation, plus a
// repository lock held by an unrelated operation so the removal must refuse.
async function fixture(t) {
  const root = mkdtempSync(path.join(fixtureTempRoot(), 'ugk-cockpit-refused-removal-'));
  const db = openCockpitDatabase(path.join(root, 'cockpit.db'));
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const repoDir = path.join(root, 'main-repo');
  mkdirSync(repoDir, { recursive: true });
  await runGit(repoDir, ['init', '-b', 'main']);
  await runGit(repoDir, ['config', 'user.name', 'Test User']);
  await runGit(repoDir, ['config', 'user.email', 'test@example.com']);
  writeFileSync(path.join(repoDir, 'README.md'), '# Main Repo\n');
  await runGit(repoDir, ['add', 'README.md']);
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
    ) VALUES ('proj-1', 'Refused Removal Project', 'development',
      'wt-main', 'ready', 'ready_to_start', ?, ?, ?, ?, ?)
  `).run(at, at, at, observation.repositoryIdentity, observation.canonicalPath);

  const spacePath = path.join(root, 'space-a');
  mkdirSync(spacePath);
  const grantStore = new EmptyFolderGrantStore({ db });
  const grant = grantStore.issue(authorizeEmptyDirectory(spacePath), 'principal-a');
  const created = await createDevelopmentWorkspace(db, {
    commandId: 'cmd-create-refused',
    projectId: 'proj-1',
    name: 'refused-space',
    grantId: grant.grantId,
    principalHash: 'principal-a',
    expectedBaseHead: observation.after.head,
  });
  assert.equal(created.ok, true, JSON.stringify(created));

  const worktreeId = created.space.worktreeId;
  db.prepare(`
    INSERT INTO work_line_states (project_id, worktree_id, status, revision, updated_at)
    VALUES ('proj-1', ?, 'closed', 1, ?)
  `).run(worktreeId, at);
  db.prepare(`
    INSERT INTO assignments (
      id, project_id, worktree_id, agent_id, task_id, scope_json,
      status, revision, session_id, created_at, updated_at
    ) VALUES ('assignment-invite', 'proj-1', ?, 'Codex', '等待接手', '{"mode":"write"}',
      'pending', 1, NULL, ?, ?)
  `).run(worktreeId, at, at);
  db.prepare(`
    INSERT INTO dispatch_grants (
      id, assignment_id, project_id, worktree_id, agent_id, task_id, scope_json,
      code_hash, state, expires_at, created_at
    ) VALUES ('grant-invite', 'assignment-invite', 'proj-1', ?, 'Codex', '等待接手',
      '{"mode":"write"}', 'hash-invite', 'active', ?, ?)
  `).run(worktreeId, Date.now() + 3_600_000, at);
  db.prepare(`
    INSERT INTO repository_locks (
      repository_identity, lock_id, holder, operation, expires_at, acquired_at, updated_at
    ) VALUES (?, 'lock-foreign', 'cmd-unrelated-merge', 'merge_submission', ?, ?, ?)
  `).run(observation.repositoryIdentity, Date.now() + 3_600_000, at, at);

  return {
    db, observation, spacePath, spaceId: created.spaceId, revision: created.space.revision,
    worktreeId,
  };
}

const invitation = (db) => db.prepare(
  "SELECT status, revision FROM assignments WHERE id = 'assignment-invite'",
).get();
const dispatchedGrant = (db) => db.prepare(
  "SELECT state, revoked_at FROM dispatch_grants WHERE id = 'grant-invite'",
).get();

// removeDevelopmentWorkspace commits cancelClosedWorkLineInvitations before the
// gates that can still refuse it (repository lock, worktree identity, ignored
// content confirmation, Git failure). Those refusals tell the operator the
// operation did not run, while the invitation and its dispatch grant are already
// cancelled — and a cancelled invitation has no path back to pending.
test('删除空间被拒时不得顺手撤销未被接手的邀请', async (t) => {
  const f = await fixture(t);

  const before = { assignment: invitation(f.db), grant: dispatchedGrant(f.db) };
  assert.equal(before.assignment.status, 'pending', JSON.stringify(before));
  assert.equal(before.grant.state, 'active', JSON.stringify(before));

  const result = await removeDevelopmentWorkspace(f.db, {
    commandId: 'cmd-remove-refused',
    projectId: 'proj-1',
    spaceId: f.spaceId,
    expectedRevision: f.revision,
  }, { probe: probeGitWorktree });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.code, 'REPOSITORY_LOCKED', JSON.stringify(result));

  assert.deepEqual(invitation(f.db), before.assignment,
    'a refused removal must leave the never-accepted invitation pending');
  assert.deepEqual(dispatchedGrant(f.db), before.grant,
    'a refused removal must leave the dispatch grant active');
});

// Reverse control, green on the current main branch: the cleanup the product DOES
// intend still happens when the removal completes. Closing the line first would
// have cancelled it; here the invitation is created after the close, so a
// successful removal is the moment it is retired.
test('反向对照：删除真正完成时才清理关闭工作线上未被接手的邀请', async (t) => {
  const f = await fixture(t);
  f.db.prepare('DELETE FROM repository_locks').run();

  const result = await removeDevelopmentWorkspace(f.db, {
    commandId: 'cmd-remove-completes',
    projectId: 'proj-1',
    spaceId: f.spaceId,
    expectedRevision: f.revision,
  }, { probe: probeGitWorktree });
  assert.equal(result.ok, true, JSON.stringify(result));

  assert.equal(invitation(f.db).status, 'cancelled',
    'completing the removal retires the never-accepted invitation');
  assert.equal(invitation(f.db).revision, 2, 'the cancellation bumps the revision exactly once');
  assert.equal(dispatchedGrant(f.db).state, 'revoked', 'and revokes its dispatch grant');
});

// The exclusion has to be exactly as narrow as the cancellation it replaces. A
// mutation that drops `status='pending' AND session_id IS NULL` from the predicate
// (so every assignment of the removing project stops blocking) keeps both tests above
// green, so they are pinned here instead.
for (const [label, row] of [
  ['accepted', { status: 'accepted', sessionId: 'session-accepted' }],
  ['pending with a session', { status: 'pending', sessionId: 'session-held' }],
]) {
  test(`例外只针对从未被接手的邀请：${label} 的邀请仍然挡住删除`, async (t) => {
    const f = await fixture(t);
    f.db.prepare('DELETE FROM repository_locks').run();
    f.db.prepare('UPDATE assignments SET status = ?, session_id = ? WHERE id = ?')
      .run(row.status, row.sessionId, 'assignment-invite');

    const result = await removeDevelopmentWorkspace(f.db, {
      commandId: `cmd-remove-${row.status}`,
      projectId: 'proj-1',
      spaceId: f.spaceId,
      expectedRevision: f.revision,
    }, { probe: probeGitWorktree });

    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.code, 'SPACE_CLOSED_HAS_ACTIVE_WORK', JSON.stringify(result));
    assert.equal(invitation(f.db).status, row.status,
      `a ${label} invitation must keep counting as active work`);
    assert.equal(existsSync(f.spacePath), true, 'the workspace must survive');
  });
}
