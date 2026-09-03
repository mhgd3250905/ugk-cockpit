import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  openCockpitDatabase,
  SUPPORTED_SCHEMA_VERSION,
} from '../src/core/database.mjs';
import {
  createDevelopmentSpace,
} from '../src/core/spaces.mjs';
import {
  acquireRepositoryLock,
  claimSubmission,
  createSubmission,
  listIntegrationClaims,
  listIntegrationReceipts,
  listSubmissions,
  readIntegrationClaim,
  readIntegrationReceipt,
  readRepositoryLock,
  readSubmission,
  recordIntegrationReceipt,
  recordIntegrationReview,
  releaseIntegrationClaim,
  releaseRepositoryLock,
  submissionIdFor,
  updateSubmissionStatus,
  VALID_CLAIM_STATUSES,
  VALID_RECEIPT_OUTCOMES,
  VALID_REVIEW_VERDICTS,
  VALID_SUBMISSION_STATUSES,
} from '../src/core/integrations.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-integrations-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openCockpitDatabase(path.join(root, 'cockpit.db'));
  const at = '2026-09-02T00:00:00.000Z';

  // Seed primary project worktree & project
  db.prepare(`
    INSERT INTO worktrees (
      id, canonical_path, repository_identity, identity_fingerprint, created_at
    ) VALUES
      ('wt-main', 'E:\\repos\\integ-app', 'repo-integ-app', 'fp-main', ?),
      ('wt-space-1', 'E:\\repos\\integ-app--feat1', 'repo-integ-app', 'fp-feat1', ?)
  `).run(at, at);

  db.prepare(`
    INSERT INTO projects (
      id, name, stage, worktree_id, status, status_reason,
      last_observed_at, created_at, updated_at, repository_identity, authorized_root
    ) VALUES ('proj-integ', 'Integration App', 'development',
      'wt-main', 'ready', 'ready_to_start', ?, ?, ?, 'repo-integ-app', 'E:\\repos\\integ-app')
  `).run(at, at, at);

  createDevelopmentSpace(db, {
    projectId: 'proj-integ',
    name: 'feat-1',
    branch: 'feature/feat-1',
    baseCommit: 'commit-base-001',
    worktreeId: 'wt-space-1',
    spaceId: 'space-feat-1',
  });

  return db;
}

test('submissions fix source/target SHA and support revision CAS', (t) => {
  const db = fixture(t);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SUPPORTED_SCHEMA_VERSION);

  const sub = createSubmission(db, {
    projectId: 'proj-integ',
    spaceId: 'space-feat-1',
    sourceWorktreeId: 'wt-space-1',
    targetWorktreeId: 'wt-main',
    sourceBranch: 'feature/feat-1',
    sourceCommit: 'commit-src-100',
    targetBranch: 'main',
    targetHead: 'commit-tgt-200',
    title: 'Add feat-1 capability',
    description: 'Detailed description of changes',
  }, { clock: () => Date.parse('2026-09-02T01:00:00.000Z') });

  assert.equal(sub.ok, true, JSON.stringify(sub));
  assert.equal(sub.projectId, 'proj-integ');
  assert.equal(sub.spaceId, 'space-feat-1');
  assert.equal(sub.sourceWorktreeId, 'wt-space-1');
  assert.equal(sub.targetWorktreeId, 'wt-main');
  assert.equal(sub.sourceCommit, 'commit-src-100');
  assert.equal(sub.targetHead, 'commit-tgt-200');
  assert.equal(sub.status, 'pending');
  assert.equal(sub.revision, 0);

  // Read back
  const readBack = readSubmission(db, sub.submissionId);
  assert.equal(readBack?.sourceCommit, 'commit-src-100');
  assert.equal(readBack?.targetHead, 'commit-tgt-200');
  assert.equal(readBack?.sourceWorktreeId, 'wt-space-1');
  assert.equal(readBack?.targetWorktreeId, 'wt-main');
  assert.equal(readBack?.spaceName, 'feat-1');
  assert.equal(readBack?.projectName, 'Integration App');

  // CAS update: stale revision fails
  const staleCas = updateSubmissionStatus(db, {
    submissionId: sub.submissionId,
    expectedRevision: 5,
    status: 'approved',
  });
  assert.equal(staleCas.ok, false);
  assert.equal(staleCas.code, 'REVISION_CONFLICT');
  assert.equal(staleCas.currentRevision, 0);

  // CAS update: valid revision succeeds
  const validCas = updateSubmissionStatus(db, {
    submissionId: sub.submissionId,
    expectedRevision: 0,
    status: 'approved',
    statusReason: 'passed_preflight',
  }, { clock: () => Date.parse('2026-09-02T02:00:00.000Z') });
  assert.equal(validCas.ok, true);
  assert.equal(validCas.revision, 1);
  assert.equal(validCas.status, 'approved');

  db.close();
});

test('integration claims are indefinite, preserve legacy active rows, and enforce exclusivity', (t) => {
  const db = fixture(t);

  const sub = createSubmission(db, {
    projectId: 'proj-integ',
    spaceId: 'space-feat-1',
    sourceWorktreeId: 'wt-space-1',
    targetWorktreeId: 'wt-main',
    sourceBranch: 'feature/feat-1',
    sourceCommit: 'commit-src-100',
    targetBranch: 'main',
    targetHead: 'commit-tgt-200',
  }, { clock: () => Date.parse('2026-09-02T01:00:00.000Z') });

  // First claim by agent-reviewer-1
  const claim1 = claimSubmission(db, {
    submissionId: sub.submissionId,
    claimant: 'agent-reviewer-1',
    ttlMs: 60 * 1000,
  }, { clock: () => Date.parse('2026-09-02T01:00:00.000Z') });

  assert.equal(claim1.ok, true);
  assert.equal(claim1.claimant, 'agent-reviewer-1');
  assert.equal(claim1.status, 'active');
  assert.equal(claim1.sourceCommit, 'commit-src-100');
  assert.equal(claim1.targetHead, 'commit-tgt-200');
  assert.equal(claim1.targetWorktreeId, 'wt-main');
  assert.equal(claim1.expiresAt, null);
  assert.equal(claim1.expiresAtIso, null);
  assert.equal(db.prepare('SELECT expires_at FROM integration_claims WHERE id = ?').get(claim1.claimId).expires_at, 0);

  // Submission status updated to 'claimed'
  const subAfterClaim = readSubmission(db, sub.submissionId);
  assert.equal(subAfterClaim.status, 'claimed');
  assert.equal(subAfterClaim.activeClaim?.id, claim1.claimId);

  // Second active claim before expiry is rejected
  const claim2 = claimSubmission(db, {
    submissionId: sub.submissionId,
    claimant: 'agent-reviewer-2',
    ttlMs: 60 * 1000,
  }, { clock: () => Date.parse('2026-09-02T01:00:30.000Z') });

  assert.equal(claim2.ok, false);
  assert.equal(claim2.code, 'SUBMISSION_ALREADY_CLAIMED');
  assert.equal(claim2.activeClaimId, claim1.claimId);
  assert.equal(claim2.claimant, 'agent-reviewer-1');

  // Direct database insertion of second active claim also fails due to partial index
  assert.throws(
    () => db.prepare(`
      INSERT INTO integration_claims (
        id, submission_id, claimant, source_commit, target_head, target_worktree_id,
        status, status_reason, review_verdict, review_summary, review_payload_json, reviewed_at,
        revision, expires_at, created_at, updated_at, released_at
      ) VALUES ('claim-db-conflict', ?, 'agent-raw', 'commit-src-100', 'commit-tgt-200', 'wt-main', 'active', '', NULL, '', '{}', NULL, 0, 1900000000000, '2026-09-02T00:00:00.000Z', '2026-09-02T00:00:00.000Z', NULL)
    `).run(sub.submissionId),
    /UNIQUE constraint failed/i,
  );

  // A legacy active row with a historical deadline remains active forever;
  // elapsed wall-clock time must not grant another claimant access.
  db.prepare('UPDATE integration_claims SET expires_at = ? WHERE id = ?')
    .run(Date.parse('2026-09-02T01:01:00.000Z'), claim1.claimId);
  const claim3 = claimSubmission(db, {
    submissionId: sub.submissionId,
    claimant: 'agent-reviewer-2',
    ttlMs: 60 * 1000,
  }, { clock: () => Date.parse('2026-09-02T01:02:00.000Z') });

  assert.equal(claim3.ok, false);
  assert.equal(claim3.code, 'SUBMISSION_ALREADY_CLAIMED');
  assert.equal(claim3.activeClaimId, claim1.claimId);
  assert.equal(claim3.expiresAt, null);
  assert.equal(claim3.expiresAtIso, null);

  // Only an explicit release closes the old claim and permits a new one.
  const releasedFirst = releaseIntegrationClaim(db, {
    claimId: claim1.claimId,
    claimant: 'agent-reviewer-1',
  }, { clock: () => Date.parse('2026-09-02T01:02:10.000Z') });
  assert.equal(releasedFirst.ok, true);
  const oldClaim = readIntegrationClaim(db, claim1.claimId);
  assert.equal(oldClaim.status, 'released');

  const claim4 = claimSubmission(db, {
    submissionId: sub.submissionId,
    claimant: 'agent-reviewer-2',
    ttlMs: 60 * 1000,
  }, { clock: () => Date.parse('2026-09-02T01:02:20.000Z') });
  assert.equal(claim4.ok, true);
  assert.equal(claim4.claimant, 'agent-reviewer-2');
  assert.equal(claim4.status, 'active');
  assert.equal(claim4.expiresAt, null);
  assert.equal(db.prepare('SELECT expires_at FROM integration_claims WHERE id = ?').get(claim4.claimId).expires_at, 0);

  const released = releaseIntegrationClaim(db, {
    claimId: claim4.claimId,
    claimant: 'agent-reviewer-2',
  }, { clock: () => Date.parse('2026-09-02T01:02:30.000Z') });
  assert.equal(released.ok, true);
  assert.equal(released.status, 'released');

  const subAfterRelease = readSubmission(db, sub.submissionId);
  assert.equal(subAfterRelease.status, 'pending');

  db.close();
});

test('integration claim commands replay stably across time and reject a changed payload', (t) => {
  const db = fixture(t);
  const sub = createSubmission(db, {
    projectId: 'proj-integ',
    spaceId: 'space-feat-1',
    sourceWorktreeId: 'wt-space-1',
    targetWorktreeId: 'wt-main',
    sourceBranch: 'feature/feat-1',
    sourceCommit: 'commit-src-replay',
    targetBranch: 'main',
    targetHead: 'commit-tgt-replay',
  });

  const request = {
    commandId: 'integration-claim-replay',
    submissionId: sub.submissionId,
    claimant: 'session:main-replay',
    expectedSubmissionRevision: 0,
  };
  const first = claimSubmission(db, request, {
    clock: () => Date.parse('2026-09-02T01:00:00.000Z'),
  });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.expiresAt, null);
  const replay = claimSubmission(db, request, {
    clock: () => Date.parse('2026-09-05T01:00:00.000Z'),
  });
  assert.deepEqual(replay, first);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM integration_claims').get().count, 1);

  assert.throws(
    () => claimSubmission(db, { ...request, claimant: 'session:other' }, {
      clock: () => Date.parse('2026-09-05T01:00:01.000Z'),
    }),
    (error) => error.code === 'COMMAND_CONFLICT',
  );

  // Failed commands are also immutable replay records, not a fresh attempt
  // whose result can change merely because time has elapsed.
  const failedRequest = {
    commandId: 'integration-claim-failed-replay',
    submissionId: sub.submissionId,
    claimant: 'session:other',
    expectedSubmissionRevision: 0,
  };
  const failed = claimSubmission(db, failedRequest, {
    clock: () => Date.parse('2026-09-02T01:00:01.000Z'),
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'SUBMISSION_REVISION_CONFLICT');
  const failedReplay = claimSubmission(db, failedRequest, {
    clock: () => Date.parse('2026-09-05T01:00:01.000Z'),
  });
  assert.deepEqual(failedReplay, failed);

  db.close();
});

test('integration receipts are append-only and record final outcomes', (t) => {
  const db = fixture(t);

  const sub = createSubmission(db, {
    projectId: 'proj-integ',
    spaceId: 'space-feat-1',
    sourceWorktreeId: 'wt-space-1',
    targetWorktreeId: 'wt-main',
    sourceBranch: 'feature/feat-1',
    sourceCommit: 'commit-src-100',
    targetBranch: 'main',
    targetHead: 'commit-tgt-200',
  }, { clock: () => Date.parse('2026-09-02T01:00:00.000Z') });

  const claim = claimSubmission(db, {
    submissionId: sub.submissionId,
    claimant: 'agent-merger',
  }, { clock: () => Date.parse('2026-09-02T01:01:00.000Z') });
  assert.equal(claim.ok, true);

  // Record integration receipt
  const receipt = recordIntegrationReceipt(db, {
    submissionId: sub.submissionId,
    claimId: claim.claimId,
    outcome: 'integrated',
    summary: 'Clean fast-forward integration into main',
    integratedCommit: 'commit-merged-300',
    payload: { strategy: 'merge', testsPassed: 42 },
  }, { clock: () => Date.parse('2026-09-02T01:05:00.000Z') });

  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  assert.equal(receipt.sourceCommit, 'commit-src-100');
  assert.equal(receipt.targetHead, 'commit-tgt-200');
  assert.equal(receipt.integratedCommit, 'commit-merged-300');
  assert.equal(receipt.outcome, 'integrated');
  assert.equal(receipt.payload.testsPassed, 42);

  // Submission is closed with outcome 'integrated'
  const finalSub = readSubmission(db, sub.submissionId);
  assert.equal(finalSub.status, 'integrated');
  assert.equal(finalSub.closedAt, '2026-09-02T01:05:00.000Z');
  assert.equal(finalSub.latestReceipt?.receiptId, receipt.receiptId);

  // Integration claim is completed
  const finalClaim = readIntegrationClaim(db, claim.claimId);
  assert.equal(finalClaim.status, 'completed');

  // Verify append-only: UPDATE and DELETE fail
  assert.throws(
    () => db.prepare('UPDATE integration_receipts SET summary = ? WHERE id = ?')
      .run('Illegal change', receipt.receiptId),
    /integration_receipts are append-only/i,
  );
  assert.throws(
    () => db.prepare('DELETE FROM integration_receipts WHERE id = ?')
      .run(receipt.receiptId),
    /integration_receipts are append-only/i,
  );

  db.close();
});

test('repository locks enforce mutual exclusion per repository_identity, safe release, and expired takeover', (t) => {
  const db = fixture(t);

  // Holder 1 acquires lock
  const lock1 = acquireRepositoryLock(db, {
    repositoryIdentity: 'repo-integ-app',
    holder: 'agent-worker-1',
    operation: 'merge_submission',
    ttlMs: 30 * 1000,
  }, { clock: () => Date.parse('2026-09-02T01:00:00.000Z') });

  assert.equal(lock1.ok, true);
  assert.equal(lock1.acquired, true);
  assert.equal(lock1.holder, 'agent-worker-1');
  assert.equal(lock1.expiresAt, Date.parse('2026-09-02T01:00:30.000Z'));

  // Holder 2 attempts to acquire lock while active -> REPOSITORY_LOCKED
  const lock2 = acquireRepositoryLock(db, {
    repositoryIdentity: 'repo-integ-app',
    holder: 'agent-worker-2',
    operation: 'rebase_submission',
    ttlMs: 30 * 1000,
  }, { clock: () => Date.parse('2026-09-02T01:00:10.000Z') });

  assert.equal(lock2.ok, false);
  assert.equal(lock2.code, 'REPOSITORY_LOCKED');
  assert.equal(lock2.holder, 'agent-worker-1');

  // Holder 1 renews / extends lock
  const renewed = acquireRepositoryLock(db, {
    repositoryIdentity: 'repo-integ-app',
    holder: 'agent-worker-1',
    operation: 'merge_submission',
    ttlMs: 60 * 1000,
  }, { clock: () => Date.parse('2026-09-02T01:00:20.000Z') });

  assert.equal(renewed.ok, true);
  assert.equal(renewed.renewed, true);
  assert.equal(renewed.expiresAt, Date.parse('2026-09-02T01:01:20.000Z'));

  // Read lock state
  const currentLock = readRepositoryLock(db, 'repo-integ-app', {
    clock: () => Date.parse('2026-09-02T01:00:25.000Z'),
  });
  assert.equal(currentLock.holder, 'agent-worker-1');
  assert.equal(currentLock.isExpired, false);

  // Missing lockId must be rejected
  const missingLockIdRelease = releaseRepositoryLock(db, {
    repositoryIdentity: 'repo-integ-app',
    holder: 'agent-worker-1',
  });
  assert.equal(missingLockIdRelease.ok, false);
  assert.equal(missingLockIdRelease.code, 'INVALID_REQUEST');

  // Mismatched lockId must be rejected
  const wrongLockIdRelease = releaseRepositoryLock(db, {
    repositoryIdentity: 'repo-integ-app',
    holder: 'agent-worker-1',
    lockId: 'lock_wrong_123',
  });
  assert.equal(wrongLockIdRelease.ok, false);
  assert.equal(wrongLockIdRelease.code, 'LOCK_ID_MISMATCH');

  // Mismatched holder cannot release
  const badRelease = releaseRepositoryLock(db, {
    repositoryIdentity: 'repo-integ-app',
    holder: 'wrong-agent',
    lockId: lock1.lockId,
  });
  assert.equal(badRelease.ok, false);
  assert.equal(badRelease.code, 'LOCK_HOLDER_MISMATCH');

  // Legitimate holder releases with correct lockId
  const goodRelease = releaseRepositoryLock(db, {
    repositoryIdentity: 'repo-integ-app',
    holder: 'agent-worker-1',
    lockId: lock1.lockId,
  });
  assert.equal(goodRelease.ok, true);
  assert.equal(goodRelease.released, true);

  // Lock is now released
  const afterRelease = readRepositoryLock(db, 'repo-integ-app');
  assert.equal(afterRelease, null);

  // Expired takeover test:
  // Acquire lock with short ttl
  acquireRepositoryLock(db, {
    repositoryIdentity: 'repo-integ-app',
    holder: 'agent-short-lived',
    operation: 'quick_check',
    ttlMs: 10 * 1000,
  }, { clock: () => Date.parse('2026-09-02T02:00:00.000Z') });

  // At T+20s, lock has expired -> another agent acquires it and takes over
  const takeover = acquireRepositoryLock(db, {
    repositoryIdentity: 'repo-integ-app',
    holder: 'agent-takeover',
    operation: 'scheduled_sync',
    ttlMs: 30 * 1000,
  }, { clock: () => Date.parse('2026-09-02T02:00:20.000Z') });

  assert.equal(takeover.ok, true);
  assert.equal(takeover.tookOverExpired, true);
  assert.equal(takeover.holder, 'agent-takeover');

  db.close();
});

test('createSubmission validates target_worktree_id and repository identity bindings', (t) => {
  const db = fixture(t);

  // Register extra worktrees
  db.prepare(`
    INSERT INTO worktrees (
      id, canonical_path, repository_identity, identity_fingerprint, created_at
    ) VALUES
      ('wt-other-repo', 'E:\\repos\\other-repo', 'repo-other', 'fp-other', '2026-09-02T00:00:00.000Z'),
      ('wt-space-other', 'E:\\repos\\integ-app--feat2', 'repo-integ-app', 'fp-feat2', '2026-09-02T00:00:00.000Z')
  `).run();

  // 1. Missing targetWorktreeId
  const missingTarget = createSubmission(db, {
    projectId: 'proj-integ',
    spaceId: 'space-feat-1',
    sourceWorktreeId: 'wt-space-1',
    sourceBranch: 'feat-1',
    sourceCommit: 'c-1',
    targetBranch: 'main',
    targetHead: 'c-main',
  });
  assert.equal(missingTarget.ok, false);
  assert.equal(missingTarget.code, 'INVALID_REQUEST');

  // 2. Target worktree not matching project primary worktree
  const mismatchTarget = createSubmission(db, {
    projectId: 'proj-integ',
    spaceId: 'space-feat-1',
    sourceWorktreeId: 'wt-space-1',
    targetWorktreeId: 'wt-space-other',
    sourceBranch: 'feat-1',
    sourceCommit: 'c-1',
    targetBranch: 'main',
    targetHead: 'c-main',
  });
  assert.equal(mismatchTarget.ok, false);
  assert.equal(mismatchTarget.code, 'TARGET_WORKTREE_MISMATCH');

  // 3. Source worktree with different repository identity
  const foreignSource = createSubmission(db, {
    projectId: 'proj-integ',
    sourceWorktreeId: 'wt-other-repo',
    targetWorktreeId: 'wt-main',
    sourceBranch: 'feat-1',
    sourceCommit: 'c-1',
    targetBranch: 'main',
    targetHead: 'c-main',
  });
  assert.equal(foreignSource.ok, false);
  assert.equal(foreignSource.code, 'REPOSITORY_IDENTITY_MISMATCH');

  // 4. Space worktree mismatch (space-feat-1 was created with wt-space-1, but source is wt-space-other)
  const spaceMismatch = createSubmission(db, {
    projectId: 'proj-integ',
    spaceId: 'space-feat-1',
    sourceWorktreeId: 'wt-space-other',
    targetWorktreeId: 'wt-main',
    sourceBranch: 'feat-1',
    sourceCommit: 'c-1',
    targetBranch: 'main',
    targetHead: 'c-main',
  });
  assert.equal(spaceMismatch.ok, false);
  assert.equal(spaceMismatch.code, 'SPACE_WORKTREE_MISMATCH');

  db.close();
});

test('recordIntegrationReview records verdict with revision CAS and updates submission', (t) => {
  const db = fixture(t);

  const sub = createSubmission(db, {
    projectId: 'proj-integ',
    spaceId: 'space-feat-1',
    sourceWorktreeId: 'wt-space-1',
    targetWorktreeId: 'wt-main',
    sourceBranch: 'feature/feat-1',
    sourceCommit: 'commit-src-100',
    targetBranch: 'main',
    targetHead: 'commit-tgt-200',
  }, { clock: () => Date.parse('2026-09-02T01:00:00.000Z') });

  const claim = claimSubmission(db, {
    submissionId: sub.submissionId,
    claimant: 'agent-reviewer',
  }, { clock: () => Date.parse('2026-09-02T01:01:00.000Z') });

  assert.equal(claim.ok, true);
  assert.equal(claim.revision, 0);

  // 1. Invalid verdict
  const badVerdict = recordIntegrationReview(db, {
    claimId: claim.claimId,
    expectedClaimRevision: 0,
    verdict: 'not_a_verdict',
  });
  assert.equal(badVerdict.ok, false);
  assert.equal(badVerdict.code, 'INVALID_VERDICT');

  // 2. Mismatched sourceCommit
  const badSource = recordIntegrationReview(db, {
    claimId: claim.claimId,
    expectedClaimRevision: 0,
    verdict: 'approved',
    sourceCommit: 'wrong-commit-sha',
  });
  assert.equal(badSource.ok, false);
  assert.equal(badSource.code, 'SOURCE_COMMIT_MISMATCH');

  // 3. Stale revision
  const staleCas = recordIntegrationReview(db, {
    claimId: claim.claimId,
    expectedClaimRevision: 99,
    verdict: 'approved',
  });
  assert.equal(staleCas.ok, false);
  assert.equal(staleCas.code, 'REVISION_CONFLICT');

  // 4. Valid approved review
  const approvedReview = recordIntegrationReview(db, {
    claimId: claim.claimId,
    expectedClaimRevision: 0,
    verdict: 'approved',
    summary: 'Code review approved with all checks passing',
    payload: { score: 98, lgtm: true },
    sourceCommit: 'commit-src-100',
    targetHead: 'commit-tgt-200',
  }, { clock: () => Date.parse('2026-09-02T01:02:00.000Z') });

  assert.equal(approvedReview.ok, true);
  assert.equal(approvedReview.verdict, 'approved');
  assert.equal(approvedReview.revision, 1);
  assert.equal(approvedReview.claim.reviewVerdict, 'approved');
  assert.equal(approvedReview.claim.reviewSummary, 'Code review approved with all checks passing');
  assert.equal(approvedReview.claim.reviewPayload.score, 98);
  assert.equal(approvedReview.claim.reviewedAt, '2026-09-02T01:02:00.000Z');

  // Submission is now approved
  const subApproved = readSubmission(db, sub.submissionId);
  assert.equal(subApproved.status, 'approved');
  assert.equal(subApproved.statusReason, 'Code review approved with all checks passing');
  assert.equal(subApproved.revision, 2); // 0 (create) -> 1 (claim) -> 2 (review)

  // 5. Next review on same claim with revision 1: changes_requested
  const changesReview = recordIntegrationReview(db, {
    claimId: claim.claimId,
    expectedClaimRevision: 1,
    verdict: 'changes_requested',
    summary: 'Please fix edge cases in auth flow',
  }, { clock: () => Date.parse('2026-09-02T01:03:00.000Z') });

  assert.equal(changesReview.ok, true);
  assert.equal(changesReview.verdict, 'changes_requested');
  assert.equal(changesReview.revision, 2);

  const subChanges = readSubmission(db, sub.submissionId);
  assert.equal(subChanges.status, 'changes_requested');

  // 6. Next review on same claim with revision 2: rejected
  const rejectedReview = recordIntegrationReview(db, {
    claimId: claim.claimId,
    expectedClaimRevision: 2,
    verdict: 'rejected',
    summary: 'Architecture approach rejected',
  }, { clock: () => Date.parse('2026-09-02T01:04:00.000Z') });

  assert.equal(rejectedReview.ok, true);
  assert.equal(rejectedReview.verdict, 'rejected');
  assert.equal(rejectedReview.revision, 3);

  const subRejected = readSubmission(db, sub.submissionId);
  assert.equal(subRejected.status, 'rejected');
  assert.equal(subRejected.closedAt, '2026-09-02T01:04:00.000Z');

  db.close();
});

test('review transaction rejects late verdicts after stale status or fixed target changes', (t) => {
  const db = fixture(t);
  const create = (suffix) => createSubmission(db, {
    projectId: 'proj-integ',
    spaceId: 'space-feat-1',
    sourceWorktreeId: 'wt-space-1',
    targetWorktreeId: 'wt-main',
    sourceBranch: 'feature/feat-1',
    sourceCommit: `commit-src-${suffix}`,
    targetBranch: 'main',
    targetHead: `commit-tgt-${suffix}`,
  });

  const staleSubmission = create('stale');
  const staleClaim = claimSubmission(db, {
    submissionId: staleSubmission.submissionId,
    claimant: 'session:stale',
  });
  assert.equal(staleClaim.ok, true);
  const staleStatus = updateSubmissionStatus(db, {
    submissionId: staleSubmission.submissionId,
    expectedRevision: 1,
    status: 'stale',
    statusReason: 'new_delivery_version',
  });
  assert.equal(staleStatus.ok, true);
  const staleReview = recordIntegrationReview(db, {
    commandId: 'late-stale-review',
    claimId: staleClaim.claimId,
    expectedClaimRevision: 0,
    verdict: 'approved',
    summary: '晚到结论',
  });
  assert.equal(staleReview.ok, false);
  assert.equal(staleReview.code, 'SUBMISSION_NOT_REVIEWABLE');
  assert.equal(readIntegrationClaim(db, staleClaim.claimId).revision, 0);
  assert.equal(readSubmission(db, staleSubmission.submissionId).status, 'stale');

  const changedSubmission = create('changed');
  const changedClaim = claimSubmission(db, {
    submissionId: changedSubmission.submissionId,
    claimant: 'session:changed',
  });
  assert.equal(changedClaim.ok, true);
  db.prepare('UPDATE submissions SET target_head = ?, revision = revision + 1 WHERE id = ?')
    .run('commit-tgt-new', changedSubmission.submissionId);
  const changedReview = recordIntegrationReview(db, {
    commandId: 'late-target-review',
    claimId: changedClaim.claimId,
    expectedClaimRevision: 0,
    verdict: 'approved',
    summary: '旧目标结论',
  });
  assert.equal(changedReview.ok, false);
  assert.equal(changedReview.code, 'TARGET_HEAD_MISMATCH');
  assert.equal(readIntegrationClaim(db, changedClaim.claimId).revision, 0);
  assert.equal(readSubmission(db, changedSubmission.submissionId).status, 'claimed');

  db.close();
});

test('submissions support expanded status set', (t) => {
  const db = fixture(t);

  const sub = createSubmission(db, {
    projectId: 'proj-integ',
    spaceId: 'space-feat-1',
    sourceWorktreeId: 'wt-space-1',
    targetWorktreeId: 'wt-main',
    sourceBranch: 'feature/feat-1',
    sourceCommit: 'commit-src-100',
    targetBranch: 'main',
    targetHead: 'commit-tgt-200',
  });
  assert.equal(sub.ok, true);

  const statuses = [
    'changes_requested',
    'stale',
    'merging',
    'merged',
    'withdrawn',
    'push_failed',
    'blocked',
    'unknown',
  ];

  let rev = 0;
  for (const st of statuses) {
    const res = updateSubmissionStatus(db, {
      submissionId: sub.submissionId,
      expectedRevision: rev,
      status: st,
    });
    assert.equal(res.ok, true, `Failed for status ${st}`);
    assert.equal(res.status, st);
    rev += 1;
  }

  db.close();
});
