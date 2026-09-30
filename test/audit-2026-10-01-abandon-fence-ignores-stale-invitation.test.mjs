import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { beginCommand } from '../src/core/command-journal.mjs';
import { EmptyFolderGrantStore } from '../src/core/folder-grants.mjs';
import { authorizeEmptyDirectory } from '../src/core/path-guard.mjs';
import {
  abandonWorkspaceLifecycle,
  reserveWorkspaceLifecycle,
} from '../src/core/workspace-lifecycle.mjs';
import { createDevelopmentWorkspace } from '../src/core/workspaces.mjs';
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

async function fixture(t) {
  const root = mkdtempSync(path.join(fixtureTempRoot(), 'ugk-cockpit-abandon-rule-'));
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
    ) VALUES ('proj-1', 'Abandon Rule Project', 'development',
      'wt-main', 'ready', 'ready_to_start', ?, ?, ?, ?, ?)
  `).run(at, at, at, observation.repositoryIdentity, observation.canonicalPath);

  const spacePath = path.join(root, 'space-a');
  mkdirSync(spacePath);
  const grantStore = new EmptyFolderGrantStore({ db });
  const grant = grantStore.issue(authorizeEmptyDirectory(spacePath), 'principal-a');
  const created = await createDevelopmentWorkspace(db, {
    commandId: 'cmd-create-abandon-rule',
    projectId: 'proj-1',
    name: 'abandon-space',
    grantId: grant.grantId,
    principalHash: 'principal-a',
    expectedBaseHead: observation.after.head,
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  return {
    db, observation, spaceId: created.spaceId,
    worktreeId: created.space.worktreeId,
    repositoryIdentity: observation.repositoryIdentity,
    revision: created.space.revision, status: created.space.status, at,
  };
}

// The fence is wedged by a lifecycle command whose executor is gone. Abandon is
// the operator's only way out, and it refuses while the worktree "holds work".
// A closed work line's never-accepted invitation is not work by the rule this
// product now reads at the removal gate and at the durable fence — so the escape
// hatch must not be walled off by that very row.
test('放弃卡住的生命周期围栏不得被关闭工作线上未被接手的邀请挡住', async (t) => {
  const f = await fixture(t);

  // The reservation row keys on a journal command, so the wedged lifecycle
  // command has to exist before the fence can be taken.
  beginCommand(f.db, {
    commandId: 'cmd-wedged-remove',
    kind: 'workspace.remove',
    request: { commandId: 'cmd-wedged-remove', projectId: 'proj-1', spaceId: f.spaceId },
  });

  const wedged = reserveWorkspaceLifecycle(f.db, {
    commandId: 'cmd-wedged-remove',
    projectId: 'proj-1',
    spaceId: f.spaceId,
    worktreeId: f.worktreeId,
    repositoryIdentity: f.repositoryIdentity,
    operation: 'remove',
    expectedRevision: f.revision,
    allowedStatuses: [f.status],
  }, {});
  assert.equal(wedged.ok, true, JSON.stringify(wedged));

  f.db.prepare(`
    INSERT INTO work_line_states (project_id, worktree_id, status, revision, updated_at)
    VALUES ('proj-1', ?, 'closed', 1, ?)
  `).run(f.worktreeId, f.at);
  f.db.prepare(`
    INSERT INTO assignments (
      id, project_id, worktree_id, agent_id, task_id, scope_json,
      status, revision, session_id, created_at, updated_at
    ) VALUES ('assignment-invite', 'proj-1', ?, 'Codex', '等待接手', '{"mode":"write"}',
      'pending', 1, NULL, ?, ?)
  `).run(f.worktreeId, f.at, f.at);

  // Pretend the executor died with this process generation unknown.
  f.db.prepare(
    'UPDATE workspace_lifecycle_reservations SET owner_pid = 0, owner_started_at = NULL WHERE repository_identity = ?',
  ).run(f.repositoryIdentity);

  const abandoned = abandonWorkspaceLifecycle(f.db, {
    commandId: 'cmd-abandon-invite',
    repositoryIdentity: f.repositoryIdentity,
    blockedCommandId: 'cmd-wedged-remove',
    userConfirmed: true,
  });
  assert.equal(abandoned.ok, true, JSON.stringify(abandoned));
  assert.equal(abandoned.abandonedCommandId, 'cmd-wedged-remove');
  assert.equal(f.db.prepare('SELECT 1 FROM workspace_lifecycle_reservations WHERE repository_identity = ?')
    .get(f.repositoryIdentity), undefined, 'the fence is released');

  // The invitation is left exactly as found: abandoning a fence is not a licence
  // to retire an unaccepted invitation either.
  assert.equal(f.db.prepare("SELECT status FROM assignments WHERE id = 'assignment-invite'").get().status,
    'pending', 'abandon must neither block on nor silently cancel the invitation');
});
