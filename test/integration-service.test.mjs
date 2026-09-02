import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCockpitDatabase } from '../src/core/database.mjs';
import {
  beginIntegrationReview,
  mergeApprovedSubmission,
  readIntegrationAttempt,
  recordSessionIntegrationReview,
} from '../src/core/integration-service.mjs';
import { readSubmission } from '../src/core/integrations.mjs';
import { registerProject, worktreeIdFor } from '../src/core/projects.mjs';
import { startWriteRun } from '../src/core/runs.mjs';
import { createDevelopmentSpace, readDevelopmentSpace } from '../src/core/spaces.mjs';
import { submitDevelopmentSpace } from '../src/core/submission-service.mjs';
import { probeGitWorktree } from '../src/git/probe.mjs';
import { pushIntegratedMain } from '../src/git/integration-ops.mjs';

const git = (cwd, args) => execFileSync('git', args, {
  cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
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

async function fixture(t) {
  const container = mkdtempSync(path.join(os.tmpdir(), 'ugk-integrate-'));
  const mainPath = path.join(container, 'main');
  const spacePath = path.join(container, 'space');
  const remotePath = path.join(container, 'remote.git');
  git(container, ['init', '--bare', remotePath]);
  git(container, ['init', '-b', 'main', mainPath]);
  git(mainPath, ['config', 'user.name', 'UGK Test']);
  git(mainPath, ['config', 'user.email', 'ugk@example.invalid']);
  writeFileSync(path.join(mainPath, 'README.md'), 'seed\n');
  git(mainPath, ['add', 'README.md']);
  git(mainPath, ['commit', '-m', 'seed']);
  git(mainPath, ['remote', 'add', 'origin', remotePath]);
  git(mainPath, ['push', '--set-upstream', 'origin', 'main']);
  git(mainPath, ['worktree', 'add', '-b', 'cockpit/work/integration-test', spacePath, 'HEAD']);

  const db = openCockpitDatabase(path.join(container, 'cockpit.db'));
  const mainObservation = await probeGitWorktree(mainPath);
  const spaceObservation = await probeGitWorktree(spacePath);
  const mainWorktreeId = worktreeIdFor(mainObservation.worktreeIdentity);
  const project = registerProject(db, {
    commandId: 'register-integration-project',
    name: 'Integration Project',
    authorizedRoot: mainPath,
    observation: mainObservation,
  });
  const spaceWorktreeId = worktreeIdFor(spaceObservation.worktreeIdentity);
  const space = createDevelopmentSpace(db, {
    commandId: 'create-integration-space',
    projectId: project.projectId,
    name: '功能开发',
    branch: spaceObservation.after.branch,
    baseCommit: spaceObservation.after.head,
    worktreeId: spaceWorktreeId,
    canonicalPath: spaceObservation.canonicalPath,
    repositoryIdentity: spaceObservation.repositoryIdentity,
    worktreeIdentity: spaceObservation.worktreeIdentity,
  });

  const createdAt = new Date().toISOString();
  for (const [assignmentId, sessionId, worktreeId, goal, observation] of [
    ['assignment-dev', 'session-dev', spaceWorktreeId, '实现功能', spaceObservation],
    ['assignment-main', 'session-main', mainWorktreeId, '审核待办', mainObservation],
  ]) {
    db.prepare(`
      INSERT INTO assignments (
        id, project_id, worktree_id, agent_id, task_id, scope_json,
        status, revision, session_id, created_at, updated_at
      ) VALUES (?, ?, ?, 'Codex', ?, '{"mode":"write"}', 'active', 2, ?, ?, ?)
    `).run(assignmentId, project.projectId, worktreeId, goal, sessionId, createdAt, createdAt);
    const started = startWriteRun(db, {
      commandId: `start-${sessionId}`,
      runId: sessionId,
      worktreeId,
      canonicalPath: observation.canonicalPath,
      repositoryIdentity: observation.repositoryIdentity,
      worktreeIdentity: observation.worktreeIdentity,
      agentClaim: 'Codex',
      goal,
      baseline: snapshot(observation),
    });
    assert.equal(started.ok, true);
  }

  writeFileSync(path.join(spacePath, 'feature.txt'), 'ready\n');
  const submitted = await submitDevelopmentSpace(db, {
    commandId: 'submit-integration-feature',
    sessionId: 'session-dev',
    expectedRevision: 2,
    summary: '完成功能',
  });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));

  t.after(() => {
    db.close();
    rmSync(container, { recursive: true, force: true });
  });
  return {
    db, mainPath, spacePath, remotePath,
    projectId: project.projectId,
    spaceId: space.spaceId,
    submissionId: submitted.submissionId,
    sourceCommit: submitted.sourceCommit,
  };
}

async function approve(f) {
  const begun = await beginIntegrationReview(f.db, {
    commandId: 'begin-review',
    sessionId: 'session-main',
    submissionId: f.submissionId,
    expectedRevision: 2,
    expectedSubmissionRevision: 0,
  });
  assert.equal(begun.ok, true, JSON.stringify(begun));
  const reviewed = await recordSessionIntegrationReview(f.db, {
    commandId: 'record-review',
    sessionId: 'session-main',
    submissionId: f.submissionId,
    claimId: begun.claimId,
    expectedRevision: 2,
    expectedClaimRevision: begun.claimRevision,
    verdict: 'approved',
    summary: '审核通过',
    findings: [],
    checks: ['tests passed'],
  });
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed));
  return { begun, reviewed };
}

test('main session claims, reviews, fast-forwards, pushes, receipts, and replays idempotently', async (t) => {
  const f = await fixture(t);
  const { begun, reviewed } = await approve(f);
  const request = {
    commandId: 'merge-approved',
    sessionId: 'session-main',
    submissionId: f.submissionId,
    claimId: begun.claimId,
    expectedRevision: 2,
    expectedSubmissionRevision: reviewed.submissionRevision,
    expectedClaimRevision: reviewed.claimRevision,
    summary: '审核通过并接入主项目',
  };
  const merged = await mergeApprovedSubmission(f.db, request);
  assert.equal(merged.ok, true, JSON.stringify(merged));
  assert.equal(merged.localIntegrated, true);
  assert.equal(merged.pushed, true);
  assert.equal(git(f.mainPath, ['rev-parse', 'HEAD']), f.sourceCommit);
  assert.equal(git(f.remotePath, ['rev-parse', 'refs/heads/main']), f.sourceCommit);
  assert.equal(readSubmission(f.db, f.submissionId).status, 'integrated');
  assert.equal(readDevelopmentSpace(f.db, f.spaceId).status, 'cleanup_ready');
  assert.deepEqual(await mergeApprovedSubmission(f.db, request), merged);
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM integration_receipts').get().count, 1);
});

test('main push failure preserves local integration and the same command resumes only push', async (t) => {
  const f = await fixture(t);
  const { begun, reviewed } = await approve(f);
  const request = {
    commandId: 'merge-push-retry', sessionId: 'session-main', submissionId: f.submissionId,
    claimId: begun.claimId, expectedRevision: 2,
    expectedSubmissionRevision: reviewed.submissionRevision,
    expectedClaimRevision: reviewed.claimRevision,
    summary: '接入并重试推送',
  };
  let pushes = 0;
  const first = await mergeApprovedSubmission(f.db, request, {
    pushIntegratedMain: async () => {
      pushes += 1;
      throw new Error('offline');
    },
  });
  assert.equal(first.ok, false);
  assert.equal(first.code, 'INTEGRATION_PUSH_FAILED');
  assert.equal(first.localIntegrated, true);
  assert.equal(git(f.mainPath, ['rev-parse', 'HEAD']), f.sourceCommit);

  const second = await mergeApprovedSubmission(f.db, request, {
    pushIntegratedMain: async (...args) => {
      pushes += 1;
      return pushIntegratedMain(...args);
    },
  });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(pushes, 2);
  assert.equal(readIntegrationAttempt(f.db, request.commandId).state, 'completed');
});

test('crash after fast-forward is recovered without another merge or duplicate receipt', async (t) => {
  const f = await fixture(t);
  const { begun, reviewed } = await approve(f);
  const request = {
    commandId: 'merge-crash-recovery', sessionId: 'session-main', submissionId: f.submissionId,
    claimId: begun.claimId, expectedRevision: 2,
    expectedSubmissionRevision: reviewed.submissionRevision,
    expectedClaimRevision: reviewed.claimRevision,
    summary: '崩溃恢复合并',
  };
  await assert.rejects(
    mergeApprovedSubmission(f.db, request, {
      faultInjector: async (point) => {
        if (point === 'after_fast_forward_before_persist') {
          throw Object.assign(new Error('simulated crash'), { simulateCrash: true });
        }
      },
    }),
    /simulated crash/,
  );
  assert.equal(readIntegrationAttempt(f.db, request.commandId).state, 'prepared');
  assert.equal(git(f.mainPath, ['rev-parse', 'HEAD']), f.sourceCommit);
  const recovered = await mergeApprovedSubmission(f.db, request);
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM integration_receipts').get().count, 1);
});
