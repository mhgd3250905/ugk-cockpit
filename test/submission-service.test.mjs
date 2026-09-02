import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { registerProject, worktreeIdFor } from '../src/core/projects.mjs';
import { createDevelopmentSpace, readDevelopmentSpace } from '../src/core/spaces.mjs';
import { startWriteRun } from '../src/core/runs.mjs';
import {
  readSubmissionAttempt,
  submitDevelopmentSpace,
} from '../src/core/submission-service.mjs';
import { probeGitWorktree } from '../src/git/probe.mjs';
import { pushSubmissionBranch } from '../src/git/submit-ops.mjs';

const git = (cwd, args) => execFileSync('git', args, {
  cwd,
  encoding: 'utf8',
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

function snapshot(observation) {
  return {
    head: observation.after.head,
    branch: observation.after.branch,
    indexFingerprint: observation.after.indexFingerprint,
    worktreeFingerprint: observation.after.worktreeFingerprint,
    repositoryIdentity: observation.repositoryIdentity,
    worktreeIdentity: observation.worktreeIdentity,
    headRelation: 'same',
    coherence: observation.coherence,
    observedAt: observation.observedAt,
  };
}

async function fixture(t, { withRemote = true } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-submit-'));
  const mainPath = path.join(root, 'main');
  const spacePath = path.join(root, 'space');
  const remotePath = path.join(root, 'remote.git');
  git(root, ['init', '--bare', remotePath]);
  git(root, ['init', '-b', 'main', mainPath]);
  git(mainPath, ['config', 'user.name', 'UGK Test']);
  git(mainPath, ['config', 'user.email', 'ugk@example.invalid']);
  writeFileSync(path.join(mainPath, 'README.md'), 'seed\n');
  git(mainPath, ['add', 'README.md']);
  git(mainPath, ['commit', '-m', 'seed']);
  if (withRemote) {
    git(mainPath, ['remote', 'add', 'origin', remotePath]);
    git(mainPath, ['push', '--set-upstream', 'origin', 'main']);
  }
  git(mainPath, ['worktree', 'add', '-b', 'cockpit/work/submit-test', spacePath, 'HEAD']);

  const db = openCockpitDatabase(path.join(root, 'cockpit.db'));
  const mainObservation = await probeGitWorktree(mainPath);
  const sourceObservation = await probeGitWorktree(spacePath);
  const registered = registerProject(db, {
    commandId: 'register-submit-project',
    name: 'Submit Project',
    observation: mainObservation,
    authorizedRoot: mainPath,
  });
  assert.equal(registered.ok, true);
  const sourceWorktreeId = worktreeIdFor(sourceObservation.worktreeIdentity);
  const createdSpace = createDevelopmentSpace(db, {
    commandId: 'create-submit-space',
    projectId: registered.projectId,
    name: 'Submit Space',
    branch: sourceObservation.after.branch,
    baseCommit: sourceObservation.after.head,
    worktreeId: sourceWorktreeId,
    canonicalPath: sourceObservation.canonicalPath,
    repositoryIdentity: sourceObservation.repositoryIdentity,
    worktreeIdentity: sourceObservation.worktreeIdentity,
  });
  assert.equal(createdSpace.ok, true);

  const sessionId = 'session-submit-test';
  const timestamp = new Date().toISOString();
  db.prepare(`
    INSERT INTO assignments (
      id, project_id, worktree_id, agent_id, task_id, scope_json,
      status, revision, session_id, created_at, updated_at
    ) VALUES (?, ?, ?, 'Codex', 'Implement feature', '{"mode":"write"}',
      'active', 2, ?, ?, ?)
  `).run('assignment-submit-test', registered.projectId, sourceWorktreeId, sessionId, timestamp, timestamp);
  const started = startWriteRun(db, {
    commandId: 'start-submit-run',
    runId: sessionId,
    worktreeId: sourceWorktreeId,
    canonicalPath: sourceObservation.canonicalPath,
    repositoryIdentity: sourceObservation.repositoryIdentity,
    worktreeIdentity: sourceObservation.worktreeIdentity,
    agentClaim: 'Codex',
    goal: 'Implement feature',
    baseline: snapshot(sourceObservation),
  });
  assert.equal(started.ok, true);

  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    db,
    mainPath,
    spacePath,
    remotePath,
    projectId: registered.projectId,
    spaceId: createdSpace.spaceId,
    sourceWorktreeId,
    sessionId,
    baseHead: sourceObservation.after.head,
    branch: sourceObservation.after.branch,
  };
}

test('dirty development space is committed, pushed, recorded, and replayed idempotently', async (t) => {
  const f = await fixture(t);
  writeFileSync(path.join(f.spacePath, 'feature.txt'), 'done\n');
  const request = {
    commandId: 'submit-dirty-success',
    sessionId: f.sessionId,
    expectedRevision: 2,
    summary: '完成开发空间功能',
  };

  const result = await submitDevelopmentSpace(f.db, request);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.localSaved, true);
  assert.equal(result.pushed, true);
  assert.notEqual(result.sourceCommit, f.baseHead);
  assert.equal(git(f.remotePath, ['rev-parse', `refs/heads/${f.branch}`]), result.sourceCommit);
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM submissions').get().count, 1);
  assert.equal(readDevelopmentSpace(f.db, f.spaceId).status, 'awaiting_review');
  assert.equal(readSubmissionAttempt(f.db, request.commandId).state, 'completed');

  const replay = await submitDevelopmentSpace(f.db, request);
  assert.deepEqual(replay, result);
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM submissions').get().count, 1);
});

test('push failure preserves the local commit and same command resumes only the push', async (t) => {
  const f = await fixture(t);
  writeFileSync(path.join(f.spacePath, 'retry.txt'), 'retry\n');
  let pushes = 0;
  const request = {
    commandId: 'submit-push-retry',
    sessionId: f.sessionId,
    expectedRevision: 2,
    summary: '保存后重试推送',
  };
  const first = await submitDevelopmentSpace(f.db, request, {
    pushSubmissionBranch: async () => {
      pushes += 1;
      const error = new Error('remote unavailable');
      error.code = 'REMOTE_UNAVAILABLE';
      throw error;
    },
  });
  assert.equal(first.ok, false);
  assert.equal(first.code, 'PUSH_FAILED');
  assert.equal(first.localSaved, true);
  assert.equal(first.pushed, false);
  const savedHead = git(f.spacePath, ['rev-parse', 'HEAD']);

  const second = await submitDevelopmentSpace(f.db, request, {
    pushSubmissionBranch: async (...args) => {
      pushes += 1;
      return pushSubmissionBranch(...args);
    },
  });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(git(f.spacePath, ['rev-parse', 'HEAD']), savedHead);
  assert.equal(pushes, 2);
});

test('commit-side crash is recovered from deterministic trailer without a duplicate commit', async (t) => {
  const f = await fixture(t);
  writeFileSync(path.join(f.spacePath, 'crash.txt'), 'crash recovery\n');
  const request = {
    commandId: 'submit-commit-crash',
    sessionId: f.sessionId,
    expectedRevision: 2,
    summary: '验证提交崩溃恢复',
  };
  const crash = new Error('simulated process crash');
  crash.simulateCrash = true;
  await assert.rejects(
    submitDevelopmentSpace(f.db, request, {
      faultInjector(point) {
        if (point === 'after_commit_before_persist') throw crash;
      },
    }),
    /simulated process crash/,
  );
  const committedHead = git(f.spacePath, ['rev-parse', 'HEAD']);
  assert.equal(readSubmissionAttempt(f.db, request.commandId).state, 'prepared');

  const recovered = await submitDevelopmentSpace(f.db, request);
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(recovered.sourceCommit, committedHead);
  assert.equal(git(f.spacePath, ['rev-list', '--count', f.baseHead + '..HEAD']), '1');
});

test('missing remote fails before any local commit and no-change submit is rejected', async (t) => {
  const noRemote = await fixture(t, { withRemote: false });
  writeFileSync(path.join(noRemote.spacePath, 'local.txt'), 'local\n');
  const missing = await submitDevelopmentSpace(noRemote.db, {
    commandId: 'submit-no-remote',
    sessionId: noRemote.sessionId,
    expectedRevision: 2,
    summary: '没有远端',
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'PUSH_REMOTE_MISSING');
  assert.equal(git(noRemote.spacePath, ['rev-parse', 'HEAD']), noRemote.baseHead);

  const clean = await fixture(t);
  const unchanged = await submitDevelopmentSpace(clean.db, {
    commandId: 'submit-no-change',
    sessionId: clean.sessionId,
    expectedRevision: 2,
    summary: '没有变化',
  });
  assert.equal(unchanged.ok, false);
  assert.equal(unchanged.code, 'NO_CHANGES_TO_SUBMIT');
});

test('Git filters are rejected before staging or committing', async (t) => {
  const f = await fixture(t);
  writeFileSync(path.join(f.spacePath, '.gitattributes'), '*.bin filter=lfs diff=lfs\n');
  writeFileSync(path.join(f.spacePath, 'asset.bin'), 'not-a-pointer\n');
  const result = await submitDevelopmentSpace(f.db, {
    commandId: 'submit-lfs-rejected',
    sessionId: f.sessionId,
    expectedRevision: 2,
    summary: '不支持的过滤器',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'GIT_FILTER_UNSUPPORTED');
  assert.equal(git(f.spacePath, ['rev-parse', 'HEAD']), f.baseHead);
  assert.match(git(f.spacePath, ['status', '--short']), /\.gitattributes/);
});
