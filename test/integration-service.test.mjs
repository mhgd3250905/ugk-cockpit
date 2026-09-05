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
import { claimSubmission, readIntegrationClaim, readSubmission } from '../src/core/integrations.mjs';
import { registerProject, worktreeIdFor } from '../src/core/projects.mjs';
import { startWriteRun } from '../src/core/runs.mjs';
import { createDevelopmentSpace, readDevelopmentSpace } from '../src/core/spaces.mjs';
import { submitDevelopmentSpace } from '../src/core/submission-service.mjs';
import { probeGitWorktree } from '../src/git/probe.mjs';
import { pushIntegratedMain } from '../src/git/integration-ops.mjs';
import { appendProgressEvent } from '../src/core/assignments.mjs';
import { createRelay, resumeRelay } from '../src/core/relays.mjs';

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
      ) VALUES (?, ?, ?, 'Codex', ?, '{"mode":"write"}', 'active', 1, ?, ?, ?)
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
    const progress = appendProgressEvent(db, {
      sessionId, clientRequestId: `activate-${sessionId}`, expectedRevision: 1,
      status: 'active', summary: goal,
    });
    assert.equal(progress.ok, true, JSON.stringify(progress));
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
  const reviewReplay = await recordSessionIntegrationReview(f.db, {
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
  }, {
    // A committed review replay must not probe or submit a second verdict.
    probe: async () => { throw new Error('review replay unexpectedly probed'); },
  });
  assert.deepEqual(reviewReplay, reviewed);
  assert.equal(readSubmission(f.db, f.submissionId).activeClaim.revision, 1);
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

test('review replay binds session and submission fields to the command id', async (t) => {
  const f = await fixture(t);
  const { begun } = await approve(f);
  const base = {
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
  };
  await assert.rejects(
    recordSessionIntegrationReview(f.db, { ...base, submissionId: 'different-submission' }),
    (error) => error.code === 'COMMAND_CONFLICT',
  );
  await assert.rejects(
    recordSessionIntegrationReview(f.db, { ...base, expectedRevision: 3 }),
    (error) => error.code === 'COMMAND_CONFLICT',
  );
  assert.equal(readSubmission(f.db, f.submissionId).activeClaim.revision, 1);
});

test('legacy active claim journal replay remains valid without exposing its old deadline', async (t) => {
  const f = await fixture(t);
  const commandId = 'legacy-begin-review';
  const legacyClaim = claimSubmission(f.db, {
    commandId,
    submissionId: f.submissionId,
    claimant: 'session:session-main',
    expectedSubmissionRevision: 0,
  }, { clock: () => Date.parse('2026-09-02T01:00:00.000Z') });
  assert.equal(legacyClaim.ok, true, JSON.stringify(legacyClaim));

  // Emulate an alpha.29 journal/row: the claim remains active although its
  // historical timestamp is already in the past, and response_json still
  // contains the old numeric expiry fields.
  const oldDeadline = Date.parse('2026-09-02T01:05:00.000Z');
  f.db.prepare('UPDATE integration_claims SET expires_at = ? WHERE id = ?')
    .run(oldDeadline, legacyClaim.claimId);
  const command = f.db.prepare('SELECT response_json FROM commands WHERE id = ?').get(commandId);
  const oldResponse = JSON.parse(command.response_json);
  oldResponse.expiresAt = oldDeadline;
  oldResponse.expiresAtIso = new Date(oldDeadline).toISOString();
  oldResponse.claim.expiresAt = oldDeadline;
  oldResponse.claim.expiresAtIso = new Date(oldDeadline).toISOString();
  f.db.prepare('UPDATE commands SET response_json = ? WHERE id = ?')
    .run(JSON.stringify(oldResponse), commandId);

  const replay = await beginIntegrationReview(f.db, {
    commandId,
    sessionId: 'session-main',
    submissionId: f.submissionId,
    expectedRevision: 2,
    expectedSubmissionRevision: 0,
  }, { clock: () => Date.parse('2026-09-05T01:00:00.000Z') });
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.equal(replay.expiresAt, null);
  assert.equal(readIntegrationClaim(f.db, legacyClaim.claimId).status, 'active');
  assert.equal(readIntegrationClaim(f.db, legacyClaim.claimId).expiresAt, null);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM integration_claims').get().count, 1);
});

test('begin command binds the main-session revision as well as the submission revision', async (t) => {
  const f = await fixture(t);
  const request = {
    commandId: 'begin-session-revision-binding',
    sessionId: 'session-main',
    submissionId: f.submissionId,
    expectedRevision: 2,
    expectedSubmissionRevision: 0,
  };
  const begun = await beginIntegrationReview(f.db, request);
  assert.equal(begun.ok, true, JSON.stringify(begun));

  // The fixture intentionally seeds the main assignment at revision 2 while
  // its minimal run starts at revision 1. Advance both records to model a
  // later session update without introducing another workflow dependency.
  f.db.prepare('UPDATE assignments SET revision = 3 WHERE session_id = ?').run('session-main');
  f.db.prepare('UPDATE runs SET revision = 3 WHERE id = ?').run('session-main');

  await assert.rejects(
    beginIntegrationReview(f.db, { ...request, expectedRevision: 3 }),
    (error) => error.code === 'COMMAND_CONFLICT',
  );
  assert.equal(readSubmission(f.db, f.submissionId).activeClaim.claimant, 'session:session-main');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM integration_claims').get().count, 1);
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

test('crash after fast-forward recovers after real progress advances the revision without duplicate receipt', async (t) => {
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
  const progress = appendProgressEvent(f.db, {
    sessionId: 'session-main', clientRequestId: 'progress-after-interruption', expectedRevision: 2,
    status: 'active', summary: '合并中断，准备恢复已保存的操作',
  });
  assert.equal(progress.ok, true, JSON.stringify(progress));
  assert.equal(progress.revision, 3);
  const recovered = await mergeApprovedSubmission(f.db, request);
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM integration_receipts').get().count, 1);
});

for (const ownershipChange of ['lease', 'relay']) test(`an interrupted merge cannot resume after ${ownershipChange} ownership changes`, async (t) => {
  const f = await fixture(t);
  const { begun, reviewed } = await approve(f);
  const request = {
    commandId: 'merge-owner-changed', sessionId: 'session-main', submissionId: f.submissionId,
    claimId: begun.claimId, expectedRevision: 2,
    expectedSubmissionRevision: reviewed.submissionRevision,
    expectedClaimRevision: reviewed.claimRevision, summary: '验证恢复归属',
  };
  await assert.rejects(mergeApprovedSubmission(f.db, request, {
    faultInjector(point) {
      if (point === 'after_fast_forward_before_persist') {
        throw Object.assign(new Error('interrupted'), { simulateCrash: true });
      }
    },
  }), /interrupted/);
  if (ownershipChange === 'lease') {
    f.db.prepare('UPDATE write_leases SET generation = generation + 1 WHERE run_id = ?').run('session-main');
  } else {
    const relay = createRelay(f.db, {
      sessionId: 'session-main', clientRequestId: 'transfer-interrupted-merge', expectedRevision: 2,
      nextSessionFocus: '检查未完成的合并', summary: '保留部分合并状态', currentState: '等待接手',
      completedItems: [], pendingItems: ['处理合并'], decisions: [], artifactRefs: [], risks: [], suggestedSkills: [],
    });
    assert.equal(relay.ok, true, JSON.stringify(relay));
    const resumed = resumeRelay(f.db, { continueCode: relay.continueCode, clientRequestId: 'new-conversation' });
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
  }
  const recovered = await mergeApprovedSubmission(f.db, request, {
    pushIntegratedMain() { assert.fail('Lost owner must not push'); },
  });
  assert.equal(recovered.code, 'INTEGRATION_BINDING_MISMATCH');
  assert.equal(f.db.prepare('SELECT state FROM commands WHERE id = ?').get(request.commandId).state, 'received');
  assert.equal(readIntegrationAttempt(f.db, request.commandId).state, 'prepared');
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM integration_receipts').get().count, 0);
});

test('prepared merge re-entry revalidates a submission that was rejected in the meantime', async (t) => {
  const f = await fixture(t);
  const { begun, reviewed } = await approve(f);
  const request = {
    commandId: 'merge-stale-prepared', sessionId: 'session-main', submissionId: f.submissionId,
    claimId: begun.claimId, expectedRevision: 2,
    expectedSubmissionRevision: reviewed.submissionRevision,
    expectedClaimRevision: reviewed.claimRevision,
    summary: '中断后重试合并',
  };
  await assert.rejects(
    mergeApprovedSubmission(f.db, request, {
      faultInjector: async (point) => {
        if (point === 'after_integration_attempt_prepared') {
          throw Object.assign(new Error('simulated crash'), { simulateCrash: true });
        }
      },
    }),
    /simulated crash/,
  );
  assert.equal(readIntegrationAttempt(f.db, request.commandId).state, 'prepared');
  const remoteMainBefore = git(f.remotePath, ['rev-parse', 'refs/heads/main']);

  // 中断窗口内，同一会话用新的请求号把提交改判 rejected。
  const rejected = await recordSessionIntegrationReview(f.db, {
    commandId: 'record-review-rejected',
    sessionId: 'session-main',
    submissionId: f.submissionId,
    claimId: begun.claimId,
    expectedRevision: 2,
    expectedClaimRevision: reviewed.claimRevision,
    verdict: 'rejected',
    summary: '发现回归，改判拒绝',
    findings: ['regression'],
    checks: [],
  });
  assert.equal(rejected.ok, true, JSON.stringify(rejected));
  assert.equal(readSubmission(f.db, f.submissionId).status, 'rejected');

  const retried = await mergeApprovedSubmission(f.db, request, {
    // 若重入仍然跳过状态复查，这些替身会真实执行合并与推送。
    fastForwardMain: async () => { throw new Error('merge must not run for a rejected submission'); },
    pushIntegratedMain: async () => { throw new Error('push must not run for a rejected submission'); },
  });
  assert.equal(retried.ok, false);
  assert.equal(retried.code, 'INTEGRATION_REVISION_CONFLICT');
  assert.equal(retried.status, 'rejected');
  assert.equal(readIntegrationAttempt(f.db, request.commandId).state, 'prepared');
  assert.equal(git(f.remotePath, ['rev-parse', 'refs/heads/main']), remoteMainBefore);
  assert.equal(readSubmission(f.db, f.submissionId).status, 'rejected');
});
