import {
  beginCommand,
  canonicalJson,
  parseCommandResponse,
} from './command-journal.mjs';
import { readSessionContext } from './assignments.mjs';
import { verifyReviewDelivery, importReviewedDelivery } from './delivery-review.mjs';
import { discardDeliveryCache } from './delivery-cache.mjs';
import {
  acquireRepositoryLock,
  claimSubmission,
  readIntegrationClaim,
  readSubmission,
  recordIntegrationReceipt,
  recordIntegrationReview,
  releaseRepositoryLock,
} from './integrations.mjs';
import {
  readDevelopmentSpace,
  updateDevelopmentSpaceStatus,
} from './spaces.mjs';
import { probeGitWorktree } from '../git/probe.mjs';
import {
  choosePushRemote,
  isCommitDescendant,
  listGitRemotes,
} from '../git/submit-ops.mjs';
import {
  fastForwardMain,
  pushIntegratedMain,
} from '../git/integration-ops.mjs';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function timestamp(options = {}) {
  const value = typeof options.clock === 'function' ? options.clock() : Date.now();
  return new Date(value).toISOString();
}

function samePath(left, right) {
  if (!left || !right) return false;
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function failCommand(db, commandId, response, options = {}) {
  db.prepare(`
    UPDATE commands SET state = 'failed', response_json = ?, updated_at = ?
    WHERE id = ? AND state = 'received'
  `).run(canonicalJson(response), timestamp(options), commandId);
  return response;
}

function commitCommand(db, commandId, response, options = {}) {
  db.prepare(`
    UPDATE commands SET state = 'committed', response_json = ?, updated_at = ?
    WHERE id = ? AND state = 'received'
  `).run(canonicalJson(response), timestamp(options), commandId);
  return response;
}

function readMainBinding(db, sessionId, expectedRevision) {
  const context = readSessionContext(db, sessionId);
  if (!context.ok) return context;
  if (context.status !== 'active' || context.run?.lifecycle !== 'active') {
    return { ok: false, code: 'SESSION_NOT_ACTIVE', sessionId };
  }
  if (context.revision !== expectedRevision) {
    return {
      ok: false,
      code: 'REVISION_CONFLICT',
      sessionId,
      expectedRevision,
      currentRevision: context.revision,
    };
  }
  const project = db.prepare(`
    SELECT projects.id, projects.worktree_id, projects.repository_identity,
           worktrees.canonical_path, worktrees.identity_fingerprint
    FROM projects
    JOIN worktrees ON worktrees.id = projects.worktree_id
    WHERE projects.id = ?
  `).get(context.projectId);
  if (!project || context.worktreeId !== project.worktree_id) {
    return { ok: false, code: 'MAIN_SESSION_REQUIRED', sessionId };
  }
  return { ok: true, context, project };
}

function validateMainObservation(observation, project) {
  return observation
    && observation.coherence === 'coherent'
    && samePath(observation.canonicalPath, project.canonical_path)
    && observation.repositoryIdentity === project.repository_identity
    && observation.worktreeIdentity === project.identity_fingerprint;
}

async function probeMain(project, options = {}) {
  const observation = await (options.probe ?? probeGitWorktree)(project.canonical_path);
  if (!validateMainObservation(observation, project)) {
    const error = new Error('The main code location no longer matches its platform record.');
    error.code = 'MAIN_WORKTREE_CHANGED';
    throw error;
  }
  return observation;
}

function validateTextList(value, limit = 20) {
  return Array.isArray(value)
    && value.length <= limit
    && value.every((item) => typeof item === 'string' && item.trim() && item.length <= 500);
}

export async function beginIntegrationReview(db, request = {}, options = {}) {
  const { commandId, sessionId, submissionId, expectedRevision, expectedSubmissionRevision } = request;
  if (![commandId, sessionId, submissionId].every(isNonEmptyString)
    || !Number.isInteger(expectedRevision) || expectedRevision < 1
    || !Number.isInteger(expectedSubmissionRevision) || expectedSubmissionRevision < 0) {
    return { ok: false, code: 'INVALID_REQUEST' };
  }
  const binding = readMainBinding(db, sessionId, expectedRevision);
  if (!binding.ok) return binding;
  const submission = readSubmission(db, submissionId);
  if (!submission) return { ok: false, code: 'SUBMISSION_NOT_FOUND', submissionId };
  if (submission.projectId !== binding.context.projectId) {
    return { ok: false, code: 'SUBMISSION_PROJECT_MISMATCH' };
  }
  if (!['pending', 'claimed', 'conflict'].includes(submission.status)) {
    return { ok: false, code: 'SUBMISSION_NOT_REVIEWABLE', status: submission.status };
  }
  let main;
  try {
    main = await probeMain(binding.project, options);
  } catch (error) {
    return { ok: false, code: error.code ?? 'INTEGRATION_PROBE_FAILED' };
  }
  let deliveryReview = null;
  if (submission.delivery?.sourceId) {
    try { deliveryReview = await verifyReviewDelivery(submission, binding.project); }
    catch (error) { return { ok: false, code: error.code ?? 'DELIVERY_CHECK_FAILED' }; }
  }
  if (!deliveryReview && main.after.hasChanges) return { ok: false, code: 'MAIN_HAS_CHANGES' };
  if (!deliveryReview) {
  if (main.after.branch !== submission.targetBranch) return { ok: false, code: 'MAIN_BRANCH_CHANGED' };
  if (main.after.head !== submission.targetHead) {
    return { ok: false, code: 'TARGET_HEAD_STALE', currentHead: main.after.head };
  }
  const descendant = await (options.isCommitDescendant ?? isCommitDescendant)(
    binding.project.canonical_path,
    submission.targetHead,
    submission.sourceCommit,
  ).catch(() => false);
  if (!descendant) return { ok: false, code: 'SOURCE_NOT_FAST_FORWARD' };
  }

  const claimed = claimSubmission(db, {
    commandId,
    submissionId,
    claimant: `session:${sessionId}`,
    expectedSubmissionRevision,
  }, options);
  if (!claimed.ok) return claimed;
  const refreshed = readSubmission(db, submissionId);
  if (deliveryReview) {
    try {
      deliveryReview = await verifyReviewDelivery(refreshed, binding.project, { prepare: true });
      db.prepare('UPDATE submissions SET delivery_json = ? WHERE id = ?').run(
        JSON.stringify({ ...refreshed.delivery, reviewCache: deliveryReview.cache }), submissionId);
    } catch (error) { return { ok: false, code: error.code ?? 'DELIVERY_CHECK_FAILED', claimId: claimed.claimId }; }
  }
  return {
    ok: true,
    sessionId,
    revision: expectedRevision,
    submissionId,
    submissionRevision: refreshed.revision,
    claimId: claimed.claimId,
    claimRevision: claimed.revision,
    expiresAt: claimed.expiresAt,
    sourceCommit: submission.sourceCommit,
    targetHead: submission.targetHead,
    sourceBranch: submission.sourceBranch,
    targetBranch: submission.targetBranch,
    title: submission.title,
    description: submission.description,
    status: 'reviewing',
    ...(deliveryReview ? { reviewRepository: deliveryReview.repository,
      mergeConflict: submission.delivery.relation === 'conflict',
      conflicts: submission.delivery.conflicts,
      warning: '只在此独立代码副本审查固定版本；它不是安全沙箱，未经授权不要执行外部脚本或注入凭据。' } : {}),
  };
}

export async function recordSessionIntegrationReview(db, request = {}, options = {}) {
  const {
    commandId, sessionId, submissionId, claimId, expectedRevision,
    expectedClaimRevision, verdict,
  } = request;
  const summary = typeof request.summary === 'string' ? request.summary.trim() : '';
  const findings = request.findings ?? [];
  const checks = request.checks ?? [];
  if (![commandId, sessionId, submissionId, claimId].every(isNonEmptyString)
    || !Number.isInteger(expectedRevision) || expectedRevision < 1
    || !Number.isInteger(expectedClaimRevision) || expectedClaimRevision < 0
    || !['approved', 'changes_requested', 'rejected'].includes(verdict)
    || !summary || summary.length > 1000
    || !validateTextList(findings) || !validateTextList(checks)) {
    return { ok: false, code: 'INVALID_REQUEST' };
  }
  const binding = readMainBinding(db, sessionId, expectedRevision);
  if (!binding.ok) return binding;
  const submission = readSubmission(db, submissionId);
  const claim = readIntegrationClaim(db, claimId);
  if (!submission) return { ok: false, code: 'SUBMISSION_NOT_FOUND' };
  if (!claim) return { ok: false, code: 'CLAIM_NOT_FOUND' };
  if (submission.projectId !== binding.context.projectId || claim.submissionId !== submissionId) {
    return { ok: false, code: 'INTEGRATION_BINDING_MISMATCH' };
  }
  if (claim.claimant !== `session:${sessionId}`) return { ok: false, code: 'CLAIMANT_MISMATCH' };
  if (claim.status !== 'active') return { ok: false, code: 'CLAIM_NOT_ACTIVE' };
  if (claim.expiresAt <= Date.parse(timestamp(options))) return { ok: false, code: 'CLAIM_EXPIRED' };
  let main;
  try {
    main = await probeMain(binding.project, options);
  } catch (error) {
    return { ok: false, code: error.code ?? 'INTEGRATION_PROBE_FAILED' };
  }
  if (submission.delivery?.sourceId) {
    if (verdict === 'approved' && submission.delivery.relation === 'conflict') return { ok: false, code: 'DELIVERY_MERGE_CONFLICT' };
    try { await verifyReviewDelivery(submission, binding.project); }
    catch (error) { return { ok: false, code: error.code ?? 'DELIVERY_CHECK_FAILED' }; }
  } else {
    if (main.after.branch !== submission.targetBranch) return { ok: false, code: 'MAIN_BRANCH_CHANGED' };
    if (main.after.head !== submission.targetHead) return { ok: false, code: 'TARGET_HEAD_STALE' };
  }

  const result = recordIntegrationReview(db, {
    commandId,
    claimId,
    expectedClaimRevision,
    verdict,
    summary,
    sourceCommit: submission.sourceCommit,
    targetHead: submission.targetHead,
    targetWorktreeId: submission.targetWorktreeId,
    payload: { findings, checks, reviewedBySessionId: sessionId },
  }, options);
  if (!result.ok) return result;
  if (submission.delivery?.reviewCache) discardDeliveryCache(submission.delivery.reviewCache);
  return {
    ok: true,
    sessionId,
    revision: expectedRevision,
    submissionId,
    submissionRevision: result.submission.revision,
    claimId,
    claimRevision: result.revision,
    verdict,
    summary,
    findings,
    checks,
    status: verdict,
  };
}

function mapAttempt(row) {
  if (!row) return null;
  return {
    commandId: row.command_id,
    sessionId: row.session_id,
    sessionRevision: row.session_revision,
    projectId: row.project_id,
    spaceId: row.space_id,
    submissionId: row.submission_id,
    submissionRevision: row.submission_revision,
    claimId: row.claim_id,
    claimRevision: row.claim_revision,
    targetWorktreeId: row.target_worktree_id,
    targetBranch: row.target_branch,
    targetHead: row.target_head,
    sourceCommit: row.source_commit,
    remoteName: row.remote_name,
    summary: row.summary,
    state: row.state,
    integratedCommit: row.integrated_commit ?? null,
    externalIntegration: row.external_integration === 1,
    receiptId: row.receipt_id ?? null,
    lastErrorCode: row.last_error_code ?? null,
    lastErrorMessage: row.last_error_message ?? null,
  };
}

export function readIntegrationAttempt(db, commandId) {
  return mapAttempt(db.prepare('SELECT * FROM integration_attempts WHERE command_id = ?').get(commandId));
}

function updateAttempt(db, commandId, values, options = {}) {
  const fields = [];
  const params = [];
  for (const [key, value] of Object.entries(values)) {
    fields.push(`${key} = ?`);
    params.push(value);
  }
  fields.push('updated_at = ?');
  params.push(timestamp(options), commandId);
  db.prepare(`UPDATE integration_attempts SET ${fields.join(', ')} WHERE command_id = ?`).run(...params);
  return readIntegrationAttempt(db, commandId);
}

function retryableMergeError(db, attempt, code, message, options = {}) {
  updateAttempt(db, attempt.commandId, {
    last_error_code: code,
    last_error_message: message,
  }, options);
  return {
    ok: false,
    code,
    message,
    retryable: true,
    localIntegrated: ['local_integrated', 'pushed', 'completed'].includes(attempt.state),
    pushed: ['pushed', 'completed'].includes(attempt.state),
    integratedCommit: attempt.integratedCommit,
  };
}

export async function mergeApprovedSubmission(db, request = {}, options = {}) {
  const {
    commandId, sessionId, submissionId, claimId, expectedRevision,
    expectedSubmissionRevision, expectedClaimRevision,
  } = request;
  const summary = typeof request.summary === 'string' ? request.summary.trim() : '';
  if (![commandId, sessionId, submissionId, claimId].every(isNonEmptyString)
    || !Number.isInteger(expectedRevision) || expectedRevision < 1
    || !Number.isInteger(expectedSubmissionRevision) || expectedSubmissionRevision < 0
    || !Number.isInteger(expectedClaimRevision) || expectedClaimRevision < 0
    || !summary || summary.length > 1000) {
    return { ok: false, code: 'INVALID_REQUEST' };
  }
  const frozenRequest = {
    commandId, sessionId, submissionId, claimId, expectedRevision,
    expectedSubmissionRevision, expectedClaimRevision, summary,
  };
  const begun = beginCommand(db, { commandId, kind: 'integration.merge', request: frozenRequest });
  if (['committed', 'failed'].includes(begun.command.state)) return parseCommandResponse(begun.command);

  const binding = readMainBinding(db, sessionId, expectedRevision);
  if (!binding.ok) return failCommand(db, commandId, binding, options);
  let attempt = readIntegrationAttempt(db, commandId);
  if (!attempt) {
    const submission = readSubmission(db, submissionId);
    const claim = readIntegrationClaim(db, claimId);
    if (!submission) return failCommand(db, commandId, { ok: false, code: 'SUBMISSION_NOT_FOUND' }, options);
    if (!claim) return failCommand(db, commandId, { ok: false, code: 'CLAIM_NOT_FOUND' }, options);
    if (submission.projectId !== binding.context.projectId || claim.submissionId !== submissionId) {
      return failCommand(db, commandId, { ok: false, code: 'INTEGRATION_BINDING_MISMATCH' }, options);
    }
    if (submission.status !== 'approved' || claim.reviewVerdict !== 'approved') {
      return failCommand(db, commandId, { ok: false, code: 'REVIEW_APPROVAL_REQUIRED' }, options);
    }
    if (submission.revision !== expectedSubmissionRevision || claim.revision !== expectedClaimRevision) {
      return failCommand(db, commandId, { ok: false, code: 'INTEGRATION_REVISION_CONFLICT' }, options);
    }
    if (claim.claimant !== `session:${sessionId}` || claim.status !== 'active') {
      return failCommand(db, commandId, { ok: false, code: 'CLAIM_NOT_ACTIVE' }, options);
    }
    let remoteName;
    try {
      remoteName = choosePushRemote(await (options.listGitRemotes ?? listGitRemotes)(binding.project.canonical_path));
    } catch (error) {
      return failCommand(db, commandId, { ok: false, code: error.code, message: error.message }, options);
    }
    const createdAt = timestamp(options);
    db.prepare(`
      INSERT INTO integration_attempts (
        command_id, session_id, session_revision, project_id, space_id,
        submission_id, submission_revision, claim_id, claim_revision,
        target_worktree_id, target_branch, target_head, source_commit,
        remote_name, summary, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)
    `).run(
      commandId, sessionId, expectedRevision, submission.projectId, submission.spaceId,
      submissionId, expectedSubmissionRevision, claimId, expectedClaimRevision,
      submission.targetWorktreeId, submission.targetBranch, submission.targetHead,
      submission.sourceCommit, remoteName, summary, createdAt, createdAt,
    );
    attempt = readIntegrationAttempt(db, commandId);
    await options.faultInjector?.('after_integration_attempt_prepared', attempt);
  }

  const lockHolder = `integrate:${commandId}`;
  const lock = acquireRepositoryLock(db, {
    repositoryIdentity: binding.project.repository_identity,
    holder: lockHolder,
    operation: 'integrate_submission',
    ttlMs: options.lockTtlMs ?? 60_000,
  }, options);
  if (!lock.ok) return { ok: false, code: 'REPOSITORY_LOCKED', retryable: true };

  try {
    if (attempt.state === 'attention') {
      return { ok: false, code: attempt.lastErrorCode, humanActionRequired: true };
    }
    if (attempt.state === 'prepared') {
      const main = await probeMain(binding.project, options);
      if (main.after.hasChanges) return retryableMergeError(db, attempt, 'MAIN_HAS_CHANGES', 'Main has local changes.', options);
      const latestSubmission = readSubmission(db, submissionId);
      if (latestSubmission.delivery?.sourceId) {
        const latestClaim = readIntegrationClaim(db, claimId);
        if (latestSubmission.status !== 'approved' || latestSubmission.revision !== expectedSubmissionRevision
          || latestClaim?.status !== 'active' || latestClaim?.revision !== expectedClaimRevision) {
          return { ok: false, code: 'INTEGRATION_REVISION_CONFLICT' };
        }
        if (main.after.head !== attempt.targetHead && main.after.head !== attempt.sourceCommit) return { ok: false, code: 'TARGET_HEAD_STALE' };
        try { await importReviewedDelivery(latestSubmission, binding.project); }
        catch (error) { return { ok: false, code: error.code ?? 'DELIVERY_CHECK_FAILED' }; }
      }
      if (main.after.branch !== attempt.targetBranch) {
        updateAttempt(db, commandId, { state: 'attention', last_error_code: 'MAIN_BRANCH_CHANGED' }, options);
        return { ok: false, code: 'MAIN_BRANCH_CHANGED', humanActionRequired: true };
      }
      const ff = await (options.isCommitDescendant ?? isCommitDescendant)(
        binding.project.canonical_path, attempt.targetHead, attempt.sourceCommit,
      ).catch(() => false);
      if (!ff) {
        updateAttempt(db, commandId, { state: 'attention', last_error_code: 'SOURCE_NOT_FAST_FORWARD' }, options);
        return { ok: false, code: 'SOURCE_NOT_FAST_FORWARD', humanActionRequired: true };
      }
      let integratedCommit;
      let externalIntegration = false;
      if (main.after.head === attempt.targetHead) {
        await (options.fastForwardMain ?? fastForwardMain)(binding.project.canonical_path, attempt.sourceCommit);
        await options.faultInjector?.('after_fast_forward_before_persist', attempt);
        const after = await probeMain(binding.project, options);
        if (after.after.head !== attempt.sourceCommit || after.after.hasChanges) {
          throw Object.assign(new Error('Fast-forward result could not be verified.'), { code: 'MERGE_UNVERIFIED' });
        }
        integratedCommit = after.after.head;
      } else {
        const containsSource = await (options.isCommitDescendant ?? isCommitDescendant)(
          binding.project.canonical_path, attempt.sourceCommit, main.after.head,
        ).catch(() => false);
        if (!containsSource) {
          updateAttempt(db, commandId, { state: 'attention', last_error_code: 'TARGET_HEAD_STALE' }, options);
          return { ok: false, code: 'TARGET_HEAD_STALE', humanActionRequired: true };
        }
        integratedCommit = main.after.head;
        externalIntegration = main.after.head !== attempt.sourceCommit;
      }
      attempt = updateAttempt(db, commandId, {
        state: 'local_integrated',
        integrated_commit: integratedCommit,
        external_integration: externalIntegration ? 1 : 0,
        last_error_code: null,
        last_error_message: null,
      }, options);
    }

    if (attempt.state === 'local_integrated') {
      const main = await probeMain(binding.project, options);
      if (main.after.head !== attempt.integratedCommit || main.after.hasChanges) {
        updateAttempt(db, commandId, { state: 'attention', last_error_code: 'MAIN_CHANGED_AFTER_INTEGRATION' }, options);
        return { ok: false, code: 'MAIN_CHANGED_AFTER_INTEGRATION', humanActionRequired: true };
      }
      try {
        await (options.pushIntegratedMain ?? pushIntegratedMain)(binding.project.canonical_path, {
          remote: attempt.remoteName,
          branch: attempt.targetBranch,
        });
      } catch (error) {
        return retryableMergeError(db, attempt, 'INTEGRATION_PUSH_FAILED', error.message, options);
      }
      await options.faultInjector?.('after_integration_push_before_persist', attempt);
      attempt = updateAttempt(db, commandId, {
        state: 'pushed', last_error_code: null, last_error_message: null,
      }, options);
    }

    if (attempt.state === 'pushed') {
      const receipt = recordIntegrationReceipt(db, {
        commandId: `integration_receipt:${commandId}`,
        submissionId,
        claimId,
        outcome: 'integrated',
        summary,
        integratedCommit: attempt.integratedCommit,
        payload: {
          strategy: attempt.externalIntegration ? 'externally_observed' : 'fast_forward',
          remote: attempt.remoteName,
          pushed: true,
          mergedBySessionId: sessionId,
        },
      }, options);
      if (!receipt.ok) return retryableMergeError(db, attempt, receipt.code, 'Could not record integration receipt.', options);
      if (attempt.spaceId) {
        const space = readDevelopmentSpace(db, attempt.spaceId);
        if (space && space.status !== 'cleanup_ready') {
          const updated = updateDevelopmentSpaceStatus(db, {
            commandId: `space_cleanup_ready:${commandId}:${space.revision}`,
            spaceId: attempt.spaceId,
            expectedRevision: space.revision,
            status: 'cleanup_ready',
            statusReason: 'integration_completed',
          }, options);
          if (!updated.ok) return retryableMergeError(db, attempt, updated.code, 'Integration completed but space status was not updated.', options);
        }
      }
      attempt = updateAttempt(db, commandId, {
        state: 'completed', receipt_id: receipt.receiptId,
        last_error_code: null, last_error_message: null,
      }, options);
    }

    return commitCommand(db, commandId, {
      ok: true,
      sessionId,
      revision: expectedRevision,
      submissionId,
      claimId,
      receiptId: attempt.receiptId,
      integratedCommit: attempt.integratedCommit,
      localIntegrated: true,
      pushed: true,
      externalIntegration: attempt.externalIntegration,
      status: 'integrated',
      message: '审核通过的功能已安全合入主项目并推送。',
    }, options);
  } catch (error) {
    if (error?.simulateCrash) throw error;
    return retryableMergeError(db, readIntegrationAttempt(db, commandId), error.code ?? 'INTEGRATION_FAILED', error.message, options);
  } finally {
    releaseRepositoryLock(db, {
      repositoryIdentity: binding.project.repository_identity,
      holder: lockHolder,
      lockId: lock.lockId,
    }, options);
  }
}
