import { createHash, randomUUID } from 'node:crypto';
import {
  beginCommand,
  canonicalJson,
  parseCommandResponse,
  readCommand,
} from './command-journal.mjs';
import { withImmediateTransaction } from './database.mjs';

export const DEFAULT_CLAIM_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_LOCK_TTL_MS = 60 * 1000;

export const VALID_SUBMISSION_STATUSES = new Set([
  'pending',
  'claimed',
  'approved',
  'integrated',
  'rejected',
  'cancelled',
  'failed',
  'conflict',
  'changes_requested',
  'stale',
  'merging',
  'merged',
  'withdrawn',
  'push_failed',
  'blocked',
  'unknown',
]);

export const VALID_CLAIM_STATUSES = new Set([
  'active',
  'released',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
]);

export const VALID_REVIEW_VERDICTS = new Set([
  'approved',
  'changes_requested',
  'rejected',
]);

export const VALID_RECEIPT_OUTCOMES = new Set([
  'integrated',
  'rejected',
  'conflict',
  'failed',
  'cancelled',
]);

function now() {
  return new Date().toISOString();
}

function nowMillis(options = {}) {
  const source = options.clock ?? options.now;
  const value = typeof source === 'function' ? source() : source;
  if (value === undefined) return Date.now();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value)) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function iso(value) {
  return new Date(value).toISOString();
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function failCommand(db, commandId, response) {
  db.prepare(`
    UPDATE commands SET state = 'failed', response_json = ?, updated_at = ?
    WHERE id = ? AND state = 'received'
  `).run(canonicalJson(response), now(), commandId);
  return response;
}

function commitCommand(db, commandId, response, timestamp) {
  db.prepare(`
    UPDATE commands SET state = 'committed', response_json = ?, updated_at = ?
    WHERE id = ? AND state = 'received'
  `).run(canonicalJson(response), timestamp, commandId);
  return response;
}

export function submissionIdFor(projectId, sourceCommit, targetHead) {
  return `sub_${createHash('sha256').update(`${projectId}\0${sourceCommit}\0${targetHead}`).digest('hex').slice(0, 24)}`;
}

export function claimIdFor(submissionId, claimant, timestamp) {
  return `claim_${createHash('sha256').update(`${submissionId}\0${claimant}\0${timestamp}`).digest('hex').slice(0, 24)}`;
}

export function receiptIdFor(submissionId, outcome, timestamp) {
  return `receipt_${createHash('sha256').update(`${submissionId}\0${outcome}\0${timestamp}`).digest('hex').slice(0, 24)}`;
}

export function lockIdFor(repositoryIdentity, holder, timestamp) {
  return `lock_${createHash('sha256').update(`${repositoryIdentity}\0${holder}\0${timestamp}`).digest('hex').slice(0, 24)}`;
}

function mapSubmission(row, activeClaimRow, latestReceiptRow) {
  if (!row) return null;
  return {
    id: row.id,
    submissionId: row.id,
    projectId: row.project_id,
    projectName: row.project_name ?? null,
    spaceId: row.space_id ?? null,
    spaceName: row.space_name ?? null,
    sourceWorktreeId: row.source_worktree_id,
    sourceCanonicalPath: row.source_canonical_path ?? null,
    targetWorktreeId: row.target_worktree_id,
    targetCanonicalPath: row.target_canonical_path ?? null,
    sourceBranch: row.source_branch,
    sourceCommit: row.source_commit,
    targetBranch: row.target_branch,
    targetHead: row.target_head,
    status: row.status,
    statusReason: row.status_reason,
    revision: row.revision,
    title: row.title,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at ?? null,
    delivery: JSON.parse(row.delivery_json ?? '{}'),
    deliveryVersion: row.delivery_version ?? 1,
    activeClaim: activeClaimRow ? mapClaim(activeClaimRow) : null,
    latestReceipt: latestReceiptRow ? mapReceipt(latestReceiptRow) : null,
  };
}

function mapClaim(row) {
  if (!row) return null;
  let reviewPayload = {};
  try {
    reviewPayload = row.review_payload_json ? JSON.parse(row.review_payload_json) : {};
  } catch {
    reviewPayload = {};
  }
  // `expires_at` is retained by schema 19 for historical rows.  Integration
  // claims no longer expire, so active claims (including legacy active rows
  // whose old timestamp has elapsed) must never expose or enforce a deadline.
  // New rows store 0 as the explicit no-expiry sentinel.
  const expiresAt = row.status === 'active'
    ? null
    : (Number(row.expires_at) > 0 ? row.expires_at : null);
  return {
    id: row.id,
    claimId: row.id,
    submissionId: row.submission_id,
    claimant: row.claimant,
    sourceCommit: row.source_commit,
    targetHead: row.target_head,
    targetWorktreeId: row.target_worktree_id,
    status: row.status,
    statusReason: row.status_reason,
    reviewVerdict: row.review_verdict ?? null,
    reviewSummary: row.review_summary ?? '',
    reviewPayload,
    reviewPayloadJson: row.review_payload_json ?? '{}',
    reviewedAt: row.reviewed_at ?? null,
    revision: row.revision,
    expiresAt,
    expiresAtIso: expiresAt === null ? null : iso(expiresAt),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    releasedAt: row.released_at ?? null,
  };
}

function normalizeClaimResponse(response) {
  if (!response || response.ok !== true) return response;
  const claim = response.claim;
  if (!claim || claim.status !== 'active') return response;
  // A committed command may predate the no-expiry representation and contain
  // a numeric expiresAt in response_json.  Normalize only the public replay;
  // the journal remains untouched so its historical digest stays valid.
  return {
    ...response,
    expiresAt: null,
    expiresAtIso: null,
    claim: { ...claim, expiresAt: null, expiresAtIso: null },
  };
}

function mapReceipt(row) {
  if (!row) return null;
  let payload = {};
  try {
    payload = row.payload_json ? JSON.parse(row.payload_json) : {};
  } catch {
    payload = {};
  }
  return {
    id: row.id,
    receiptId: row.id,
    submissionId: row.submission_id,
    claimId: row.claim_id ?? null,
    projectId: row.project_id,
    spaceId: row.space_id ?? null,
    sourceCommit: row.source_commit,
    targetHead: row.target_head,
    integratedCommit: row.integrated_commit ?? null,
    outcome: row.outcome,
    summary: row.summary,
    payload,
    payloadJson: row.payload_json,
    createdAt: row.created_at,
  };
}

function mapLock(row) {
  if (!row) return null;
  return {
    repositoryIdentity: row.repository_identity,
    lockId: row.lock_id,
    holder: row.holder,
    operation: row.operation,
    expiresAt: row.expires_at,
    expiresAtIso: iso(row.expires_at),
    acquiredAt: row.acquired_at,
    updatedAt: row.updated_at,
    commandId: row.command_id ?? null,
  };
}

/* ---------------- Submissions ---------------- */

export function createSubmission(db, request = {}, options = {}) {
  const {
    commandId,
    projectId,
    spaceId = null,
    sourceWorktreeId = request.source_worktree_id,
    targetWorktreeId = request.target_worktree_id,
    sourceBranch = request.source_branch,
    sourceCommit = request.source_commit,
    targetBranch = request.target_branch,
    targetHead = request.target_head,
    title = '',
    description = '',
  } = request;

  if (!isNonEmptyString(projectId)) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'projectId is required.' };
  }
  if (!isNonEmptyString(sourceWorktreeId)) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'sourceWorktreeId is required.' };
  }
  if (!isNonEmptyString(targetWorktreeId)) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'targetWorktreeId is required.' };
  }
  if (!isNonEmptyString(sourceBranch)) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'sourceBranch is required.' };
  }
  if (!isNonEmptyString(sourceCommit)) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'sourceCommit is required.' };
  }
  if (!isNonEmptyString(targetBranch)) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'targetBranch is required.' };
  }
  if (!isNonEmptyString(targetHead)) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'targetHead is required.' };
  }

  const timestamp = iso(nowMillis(options));
  const submissionId = request.submissionId ?? request.id ?? submissionIdFor(projectId, sourceCommit, targetHead);

  const frozenRequest = {
    commandId,
    submissionId,
    projectId,
    spaceId,
    sourceWorktreeId,
    targetWorktreeId,
    sourceBranch,
    sourceCommit,
    targetBranch,
    targetHead,
    title,
    description,
  };

  if (commandId) {
    const begun = beginCommand(db, {
      commandId,
      kind: 'submission.create',
      request: frozenRequest,
    });
    if (begun.command.state === 'committed' || begun.command.state === 'failed') {
      return parseCommandResponse(begun.command);
    }
  }

  return withImmediateTransaction(db, () => {
    if (commandId) {
      const command = readCommand(db, commandId);
      if (command.state === 'committed' || command.state === 'failed') {
        return parseCommandResponse(command);
      }
    }

    const project = db.prepare('SELECT id, name, stage, worktree_id, repository_identity FROM projects WHERE id = ?').get(projectId);
    if (!project) {
      const response = { ok: false, code: 'PROJECT_NOT_FOUND', projectId };
      if (commandId) failCommand(db, commandId, response);
      return response;
    }

    const sourceWorktree = db.prepare('SELECT * FROM worktrees WHERE id = ?').get(sourceWorktreeId);
    if (!sourceWorktree) {
      const response = { ok: false, code: 'WORKTREE_NOT_FOUND', worktreeId: sourceWorktreeId, sourceWorktreeId };
      if (commandId) failCommand(db, commandId, response);
      return response;
    }

    if (sourceWorktree.repository_identity !== project.repository_identity
      && !db.prepare('SELECT id FROM delivery_sources WHERE project_id = ? AND worktree_id = ?').get(projectId, sourceWorktreeId)) {
      const response = {
        ok: false,
        code: 'REPOSITORY_IDENTITY_MISMATCH',
        projectId,
        worktreeId: sourceWorktreeId,
        projectRepositoryIdentity: project.repository_identity,
        worktreeRepositoryIdentity: sourceWorktree.repository_identity,
      };
      if (commandId) failCommand(db, commandId, response);
      return response;
    }

    const targetWorktree = db.prepare('SELECT * FROM worktrees WHERE id = ?').get(targetWorktreeId);
    if (!targetWorktree) {
      const response = { ok: false, code: 'WORKTREE_NOT_FOUND', worktreeId: targetWorktreeId, targetWorktreeId };
      if (commandId) failCommand(db, commandId, response);
      return response;
    }

    if (targetWorktreeId !== project.worktree_id) {
      const response = {
        ok: false,
        code: 'TARGET_WORKTREE_MISMATCH',
        projectId,
        targetWorktreeId,
        projectWorktreeId: project.worktree_id,
      };
      if (commandId) failCommand(db, commandId, response);
      return response;
    }

    if (targetWorktree.repository_identity !== project.repository_identity) {
      const response = {
        ok: false,
        code: 'REPOSITORY_IDENTITY_MISMATCH',
        projectId,
        worktreeId: targetWorktreeId,
        projectRepositoryIdentity: project.repository_identity,
        worktreeRepositoryIdentity: targetWorktree.repository_identity,
      };
      if (commandId) failCommand(db, commandId, response);
      return response;
    }

    if (spaceId) {
      const space = db.prepare('SELECT id, project_id, worktree_id FROM development_spaces WHERE id = ?').get(spaceId);
      if (!space) {
        const response = { ok: false, code: 'SPACE_NOT_FOUND', spaceId };
        if (commandId) failCommand(db, commandId, response);
        return response;
      }
      if (space.project_id !== projectId) {
        const response = { ok: false, code: 'SPACE_PROJECT_MISMATCH', spaceId, projectId };
        if (commandId) failCommand(db, commandId, response);
        return response;
      }
      if (space.worktree_id !== sourceWorktreeId) {
        const response = {
          ok: false,
          code: 'SPACE_WORKTREE_MISMATCH',
          spaceId,
          sourceWorktreeId,
          expectedWorktreeId: space.worktree_id,
        };
        if (commandId) failCommand(db, commandId, response);
        return response;
      }
    }

    const existing = db.prepare('SELECT * FROM submissions WHERE id = ?').get(submissionId);
    if (existing) {
      const same = existing.project_id === projectId
        && existing.source_commit === sourceCommit
        && existing.target_head === targetHead
        && existing.source_branch === sourceBranch
        && existing.target_branch === targetBranch
        && existing.source_worktree_id === sourceWorktreeId
        && existing.target_worktree_id === targetWorktreeId;
      if (same) {
        const mapped = mapSubmission(existing);
        const response = {
          ok: true,
          submissionId,
          submission: mapped,
          ...mapped,
          alreadyExists: true,
        };
        if (commandId) commitCommand(db, commandId, response, timestamp);
        return response;
      }
      const response = { ok: false, code: 'SUBMISSION_ID_CONFLICT', submissionId };
      if (commandId) failCommand(db, commandId, response);
      return response;
    }

    db.prepare(`
      INSERT INTO submissions (
        id, project_id, space_id, source_worktree_id, target_worktree_id,
        source_branch, source_commit, target_branch, target_head,
        status, status_reason, revision, title, description,
        created_at, updated_at, closed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'created', 0, ?, ?, ?, ?, NULL)
    `).run(
      submissionId,
      projectId,
      spaceId,
      sourceWorktreeId,
      targetWorktreeId,
      sourceBranch,
      sourceCommit,
      targetBranch,
      targetHead,
      title,
      description,
      timestamp,
      timestamp,
    );

    const created = readSubmission(db, submissionId);
    const response = {
      ok: true,
      submissionId,
      submission: created,
      ...created,
    };
    if (commandId) commitCommand(db, commandId, response, timestamp);
    return response;
  });
}

export function readSubmission(db, submissionId) {
  if (!isNonEmptyString(submissionId)) return null;
  const row = db.prepare(`
    SELECT submissions.*,
           projects.name AS project_name,
           development_spaces.name AS space_name,
           src_wt.canonical_path AS source_canonical_path,
           tgt_wt.canonical_path AS target_canonical_path
    FROM submissions
    JOIN projects ON projects.id = submissions.project_id
    JOIN worktrees src_wt ON src_wt.id = submissions.source_worktree_id
    JOIN worktrees tgt_wt ON tgt_wt.id = submissions.target_worktree_id
    LEFT JOIN development_spaces ON development_spaces.id = submissions.space_id
    WHERE submissions.id = ?
  `).get(submissionId);
  if (!row) return null;

  const activeClaim = db.prepare(`
    SELECT * FROM integration_claims
    WHERE submission_id = ? AND status = 'active'
    ORDER BY created_at DESC LIMIT 1
  `).get(submissionId) ?? null;

  const latestReceipt = db.prepare(`
    SELECT * FROM integration_receipts
    WHERE submission_id = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(submissionId) ?? null;

  return mapSubmission(row, activeClaim, latestReceipt);
}

export function listSubmissions(db, options = {}) {
  const { projectId, spaceId, status } = options;
  let sql = `
    SELECT submissions.*,
           projects.name AS project_name,
           development_spaces.name AS space_name,
           src_wt.canonical_path AS source_canonical_path,
           tgt_wt.canonical_path AS target_canonical_path
    FROM submissions
    JOIN projects ON projects.id = submissions.project_id
    JOIN worktrees src_wt ON src_wt.id = submissions.source_worktree_id
    JOIN worktrees tgt_wt ON tgt_wt.id = submissions.target_worktree_id
    LEFT JOIN development_spaces ON development_spaces.id = submissions.space_id
    WHERE 1 = 1
  `;
  const params = [];
  if (isNonEmptyString(projectId)) {
    sql += ' AND submissions.project_id = ?';
    params.push(projectId);
  }
  if (isNonEmptyString(spaceId)) {
    sql += ' AND submissions.space_id = ?';
    params.push(spaceId);
  }
  if (isNonEmptyString(status)) {
    sql += ' AND submissions.status = ?';
    params.push(status);
  }
  sql += ' ORDER BY submissions.created_at DESC, submissions.id DESC';

  const rows = db.prepare(sql).all(...params);
  return rows.map((row) => {
    const activeClaim = db.prepare(`
      SELECT * FROM integration_claims
      WHERE submission_id = ? AND status = 'active'
      ORDER BY created_at DESC LIMIT 1
    `).get(row.id) ?? null;
    const latestReceipt = db.prepare(`
      SELECT * FROM integration_receipts
      WHERE submission_id = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(row.id) ?? null;
    return mapSubmission(row, activeClaim, latestReceipt);
  });
}

export function updateSubmissionStatus(db, request = {}, options = {}) {
  const {
    commandId,
    submissionId,
    expectedRevision,
    status,
    statusReason = '',
  } = request;

  if (!isNonEmptyString(submissionId)) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'submissionId is required.' };
  }
  if (typeof expectedRevision !== 'number' || expectedRevision < 0) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'expectedRevision is required and must be a non-negative integer.' };
  }
  if (!isNonEmptyString(status) || !VALID_SUBMISSION_STATUSES.has(status)) {
    return { ok: false, code: 'INVALID_STATUS', message: `Invalid status: ${status}` };
  }

  const timestamp = iso(nowMillis(options));
  const frozenRequest = {
    commandId,
    submissionId,
    expectedRevision,
    status,
    statusReason,
  };

  if (commandId) {
    const begun = beginCommand(db, {
      commandId,
      kind: 'submission.update_status',
      request: frozenRequest,
    });
    if (begun.command.state === 'committed' || begun.command.state === 'failed') {
      return parseCommandResponse(begun.command);
    }
  }

  return withImmediateTransaction(db, () => {
    if (commandId) {
      const command = readCommand(db, commandId);
      if (command.state === 'committed' || command.state === 'failed') {
        return parseCommandResponse(command);
      }
    }

    const current = db.prepare('SELECT * FROM submissions WHERE id = ?').get(submissionId);
    if (!current) {
      const response = { ok: false, code: 'SUBMISSION_NOT_FOUND', submissionId };
      if (commandId) failCommand(db, commandId, response);
      return response;
    }

    if (current.revision !== expectedRevision) {
      const response = {
        ok: false,
        code: 'REVISION_CONFLICT',
        submissionId,
        currentRevision: current.revision,
        expectedRevision,
      };
      if (commandId) failCommand(db, commandId, response);
      return response;
    }

    const nextRevision = current.revision + 1;
    const isTerminal = status === 'integrated' || status === 'rejected' || status === 'cancelled' || status === 'failed' || status === 'merged' || status === 'withdrawn';
    const closedAt = isTerminal ? (current.closed_at ?? timestamp) : null;

    db.prepare(`
      UPDATE submissions
      SET status = ?, status_reason = ?, revision = ?, updated_at = ?, closed_at = ?
      WHERE id = ? AND revision = ?
    `).run(status, statusReason, nextRevision, timestamp, closedAt, submissionId, expectedRevision);

    const updated = readSubmission(db, submissionId);
    const response = {
      ok: true,
      submissionId,
      status,
      statusReason,
      revision: nextRevision,
      updatedAt: timestamp,
      closedAt,
      submission: updated,
    };
    if (commandId) commitCommand(db, commandId, response, timestamp);
    return response;
  });
}

/* ---------------- Integration Claims ---------------- */

export function claimSubmission(db, request = {}, options = {}) {
  const {
    commandId,
    submissionId,
    claimant,
    ttlMs = DEFAULT_CLAIM_TTL_MS,
    statusReason = 'review_started',
    expectedSubmissionRevision,
    sessionId,
    expectedSessionRevision,
  } = request;

  if (!isNonEmptyString(submissionId)) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'submissionId is required.' };
  }
  if (!isNonEmptyString(claimant)) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'claimant is required.' };
  }
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'ttlMs must be positive.' };
  }

  const nowMs = nowMillis(options);
  const timestamp = iso(nowMs);

  // The first implementation included a timestamp-derived claim id in the
  // journal request.  Replaying the same command after even one millisecond
  // therefore looked like a different payload.  New command-backed claims
  // derive their id from the stable command id.  If a pre-existing journal
  // row is being replayed, retain its historical claim id so its digest still
  // matches; this is compatibility only and never reclaims/overwrites a row.
  let journalRequest = null;
  if (commandId) {
    const existingCommand = readCommand(db, commandId);
    if (existingCommand?.kind === 'integration.claim' && existingCommand.request_json) {
      try { journalRequest = JSON.parse(existingCommand.request_json); } catch { journalRequest = null; }
    }
  }
  const effectiveTtlMs = request.ttlMs === undefined && Number.isFinite(journalRequest?.ttlMs)
    ? journalRequest.ttlMs
    : ttlMs;
  if (!Number.isFinite(effectiveTtlMs) || effectiveTtlMs <= 0) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'ttlMs must be positive.' };
  }
  const claimId = request.claimId
    ?? request.id
    ?? journalRequest?.claimId
    ?? (commandId
      ? claimIdFor(submissionId, claimant, commandId)
      : claimIdFor(submissionId, claimant, timestamp));

  // Alpha.29 claim journal rows do not contain the high-level main-session
  // binding. Keep their digest replayable, while all new begin requests bind
  // the session revision so a reused command id cannot project a new receipt.
  const supportsSessionBinding = !journalRequest
    || (journalRequest.sessionId !== undefined && journalRequest.expectedSessionRevision !== undefined);

  const frozenRequest = {
    commandId,
    claimId,
    submissionId,
    claimant,
    ttlMs: effectiveTtlMs,
    statusReason,
    ...(expectedSubmissionRevision !== undefined ? { expectedSubmissionRevision } : {}),
    ...(supportsSessionBinding && sessionId !== undefined ? { sessionId } : {}),
    ...(supportsSessionBinding && expectedSessionRevision !== undefined ? { expectedSessionRevision } : {}),
  };

  if (commandId) {
    const begun = beginCommand(db, {
      commandId,
      kind: 'integration.claim',
      request: frozenRequest,
    });
    if (begun.command.state === 'committed' || begun.command.state === 'failed') {
      return normalizeClaimResponse(parseCommandResponse(begun.command));
    }
  }

  return withImmediateTransaction(db, () => {
    if (commandId) {
      const command = readCommand(db, commandId);
      if (command.state === 'committed' || command.state === 'failed') {
        return normalizeClaimResponse(parseCommandResponse(command));
      }
    }

    const submission = db.prepare('SELECT * FROM submissions WHERE id = ?').get(submissionId);
    if (!submission) {
      const response = { ok: false, code: 'SUBMISSION_NOT_FOUND', submissionId };
      if (commandId) failCommand(db, commandId, response);
      return response;
    }

    if (submission.status === 'integrated' || submission.status === 'rejected' || submission.status === 'cancelled' || submission.status === 'merged' || submission.status === 'withdrawn') {
      const response = {
        ok: false,
        code: 'SUBMISSION_CLOSED',
        submissionId,
        status: submission.status,
      };
      if (commandId) failCommand(db, commandId, response);
      return response;
    }

    if (expectedSubmissionRevision !== undefined && submission.revision !== expectedSubmissionRevision) {
      const response = {
        ok: false,
        code: 'SUBMISSION_REVISION_CONFLICT',
        submissionId,
        currentRevision: submission.revision,
        currentSubmissionRevision: submission.revision,
        expectedRevision: expectedSubmissionRevision,
        expectedSubmissionRevision,
      };
      if (commandId) failCommand(db, commandId, response);
      return response;
    }

    // Check for existing active claim on this submission
    const existingActiveClaim = db.prepare(`
      SELECT * FROM integration_claims
      WHERE submission_id = ? AND status = 'active'
    `).get(submissionId);

    if (existingActiveClaim) {
      // Active integration claims are deliberately indefinite.  In
      // particular, do not turn a legacy row with a past expires_at into
      // timed_out: only an explicit release/terminal transition can close it.
      if (existingActiveClaim.claimant === claimant && (existingActiveClaim.id === claimId || commandId)) {
        const mapped = mapClaim(existingActiveClaim);
        const response = {
          ok: true,
          claimId: existingActiveClaim.id,
          claim: mapped,
          ...mapped,
          alreadyExists: true,
        };
        if (commandId) commitCommand(db, commandId, response, timestamp);
        return response;
      }
      const response = {
        ok: false,
        code: 'SUBMISSION_ALREADY_CLAIMED',
        submissionId,
        activeClaimId: existingActiveClaim.id,
        claimant: existingActiveClaim.claimant,
        expiresAt: null,
        expiresAtIso: null,
      };
      if (commandId) failCommand(db, commandId, response);
      return response;
    }

    db.prepare(`
      INSERT INTO integration_claims (
        id, submission_id, claimant,
        source_commit, target_head, target_worktree_id,
        status, status_reason,
        review_verdict, review_summary, review_payload_json, reviewed_at,
        revision, expires_at, created_at, updated_at, released_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, NULL, '', '{}', NULL, 0, ?, ?, ?, NULL)
    `).run(
      claimId,
      submissionId,
      claimant,
      submission.source_commit,
      submission.target_head,
      submission.target_worktree_id,
      statusReason,
      // Schema 19 keeps expires_at NOT NULL for old databases; zero is the
      // explicit no-expiry value for every new integration claim.
      0,
      timestamp,
      timestamp,
    );

    db.prepare(`
      UPDATE submissions
      SET status = 'claimed', revision = revision + 1, updated_at = ?
      WHERE id = ?
    `).run(timestamp, submissionId);

    const created = readIntegrationClaim(db, claimId);
    const response = {
      ok: true,
      claimId,
      claim: created,
      ...created,
    };
    if (commandId) commitCommand(db, commandId, response, timestamp);
    return response;
  });
}

export function releaseIntegrationClaim(db, request = {}, options = {}) {
  const {
    commandId,
    claimId,
    claimant,
    status = 'released',
    statusReason = 'claim_released',
  } = request;

  if (!isNonEmptyString(claimId)) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'claimId is required.' };
  }
  if (!VALID_CLAIM_STATUSES.has(status)) {
    return { ok: false, code: 'INVALID_STATUS', message: `Invalid claim status: ${status}` };
  }

  const timestamp = iso(nowMillis(options));
  const frozenRequest = {
    commandId,
    claimId,
    claimant,
    status,
    statusReason,
  };

  if (commandId) {
    const begun = beginCommand(db, {
      commandId,
      kind: 'integration.release_claim',
      request: frozenRequest,
    });
    if (begun.command.state === 'committed' || begun.command.state === 'failed') {
      return parseCommandResponse(begun.command);
    }
  }

  return withImmediateTransaction(db, () => {
    if (commandId) {
      const command = readCommand(db, commandId);
      if (command.state === 'committed' || command.state === 'failed') {
        return parseCommandResponse(command);
      }
    }

    const current = db.prepare('SELECT * FROM integration_claims WHERE id = ?').get(claimId);
    if (!current) {
      const response = { ok: false, code: 'CLAIM_NOT_FOUND', claimId };
      if (commandId) failCommand(db, commandId, response);
      return response;
    }

    if (current.status !== 'active') {
      const mapped = mapClaim(current);
      const response = {
        ok: true,
        claimId,
        status: current.status,
        alreadyReleased: true,
        claim: mapped,
      };
      if (commandId) commitCommand(db, commandId, response, timestamp);
      return response;
    }

    if (claimant !== undefined && current.claimant !== claimant) {
      const response = {
        ok: false,
        code: 'CLAIMANT_MISMATCH',
        claimId,
        currentClaimant: current.claimant,
        expectedClaimant: claimant,
      };
      if (commandId) failCommand(db, commandId, response);
      return response;
    }

    db.prepare(`
      UPDATE integration_claims
      SET status = ?, status_reason = ?, revision = revision + 1, updated_at = ?, released_at = ?
      WHERE id = ? AND status = 'active'
    `).run(status, statusReason, timestamp, timestamp, claimId);

    // If submission is still marked claimed, return it to pending if released
    const submission = db.prepare('SELECT * FROM submissions WHERE id = ?').get(current.submission_id);
    if (submission && submission.status === 'claimed' && status === 'released') {
      db.prepare(`
        UPDATE submissions
        SET status = 'pending', revision = revision + 1, updated_at = ?
        WHERE id = ?
      `).run(timestamp, submission.id);
    }

    const updated = readIntegrationClaim(db, claimId);
    const response = {
      ok: true,
      claimId,
      status,
      statusReason,
      releasedAt: timestamp,
      claim: updated,
    };
    if (commandId) commitCommand(db, commandId, response, timestamp);
    return response;
  });
}

export function recordIntegrationReview(db, request = {}, options = {}) {
  const {
    commandId,
    claimId,
    sessionId,
    submissionId,
    expectedSessionRevision,
    expectedClaimRevision = request.expected_claim_revision ?? request.expectedRevision,
    verdict,
    summary = request.statusReason ?? request.status_reason ?? '',
    payload = {},
    payloadJson = request.payload_json ?? canonicalJson(payload),
    sourceCommit = request.source_commit,
    targetHead = request.target_head,
    targetWorktreeId = request.target_worktree_id,
  } = request;

  if (!isNonEmptyString(claimId)) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'claimId is required.' };
  }
  if (typeof expectedClaimRevision !== 'number' || expectedClaimRevision < 0) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'expectedClaimRevision is required and must be a non-negative integer.' };
  }
  if (!isNonEmptyString(verdict) || !VALID_REVIEW_VERDICTS.has(verdict)) {
    return { ok: false, code: 'INVALID_VERDICT', message: `Invalid review verdict: ${verdict}` };
  }

  const timestamp = iso(nowMillis(options));
  const frozenRequest = {
    commandId,
    claimId,
    expectedClaimRevision,
    verdict,
    summary,
    payload: JSON.parse(payloadJson),
    ...(sourceCommit !== undefined ? { sourceCommit } : {}),
    ...(targetHead !== undefined ? { targetHead } : {}),
    ...(targetWorktreeId !== undefined ? { targetWorktreeId } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(submissionId !== undefined ? { submissionId } : {}),
    ...(expectedSessionRevision !== undefined ? { expectedSessionRevision } : {}),
  };

  if (commandId) {
    const begun = beginCommand(db, {
      commandId,
      kind: 'integration.review',
      request: frozenRequest,
    });
    if (begun.command.state === 'committed' || begun.command.state === 'failed') {
      return parseCommandResponse(begun.command);
    }
  }

  return withImmediateTransaction(db, () => {
    if (commandId) {
      const command = readCommand(db, commandId);
      if (command.state === 'committed' || command.state === 'failed') {
        return parseCommandResponse(command);
      }
    }

    const claim = db.prepare('SELECT * FROM integration_claims WHERE id = ?').get(claimId);
    if (!claim) {
      const response = { ok: false, code: 'CLAIM_NOT_FOUND', claimId };
      if (commandId) failCommand(db, commandId, response);
      return response;
    }

    if (claim.status !== 'active') {
      const response = { ok: false, code: 'CLAIM_NOT_ACTIVE', claimId, status: claim.status };
      if (commandId) failCommand(db, commandId, response);
      return response;
    }

    if (claim.revision !== expectedClaimRevision) {
      const response = {
        ok: false,
        code: 'REVISION_CONFLICT',
        claimId,
        currentRevision: claim.revision,
        currentClaimRevision: claim.revision,
        expectedRevision: expectedClaimRevision,
        expectedClaimRevision,
      };
      if (commandId) failCommand(db, commandId, response);
      return response;
    }

    if (sourceCommit !== undefined && claim.source_commit !== sourceCommit) {
      const response = {
        ok: false,
        code: 'SOURCE_COMMIT_MISMATCH',
        claimId,
        currentSourceCommit: claim.source_commit,
        expectedSourceCommit: sourceCommit,
      };
      if (commandId) failCommand(db, commandId, response);
      return response;
    }

    if (targetHead !== undefined && claim.target_head !== targetHead) {
      const response = {
        ok: false,
        code: 'TARGET_HEAD_MISMATCH',
        claimId,
        currentTargetHead: claim.target_head,
        expectedTargetHead: targetHead,
      };
      if (commandId) failCommand(db, commandId, response);
      return response;
    }

    if (targetWorktreeId !== undefined && claim.target_worktree_id !== targetWorktreeId) {
      const response = {
        ok: false,
        code: 'TARGET_WORKTREE_MISMATCH',
        claimId,
        currentTargetWorktreeId: claim.target_worktree_id,
        expectedTargetWorktreeId: targetWorktreeId,
      };
      if (commandId) failCommand(db, commandId, response);
      return response;
    }

    const submission = db.prepare('SELECT * FROM submissions WHERE id = ?').get(claim.submission_id);
    if (!submission) {
      const response = { ok: false, code: 'SUBMISSION_NOT_FOUND', submissionId: claim.submission_id };
      if (commandId) failCommand(db, commandId, response);
      return response;
    }

    // A delivery version may be replaced or withdrawn while an older review
    // is still doing its external checks.  Re-read the binding inside this
    // transaction so a late verdict cannot mutate a stale/closed submission,
    // even when a generic status update did not release its claim.
    if (['integrated', 'rejected', 'cancelled', 'failed', 'merged', 'withdrawn'].includes(submission.status)) {
      const response = {
        ok: false,
        code: 'SUBMISSION_CLOSED',
        submissionId: submission.id,
        status: submission.status,
      };
      if (commandId) failCommand(db, commandId, response);
      return response;
    }
    if (submission.status === 'stale') {
      const response = {
        ok: false,
        code: 'SUBMISSION_NOT_REVIEWABLE',
        submissionId: submission.id,
        status: submission.status,
      };
      if (commandId) failCommand(db, commandId, response);
      return response;
    }
    if (submission.source_commit !== claim.source_commit) {
      const response = {
        ok: false,
        code: 'SOURCE_COMMIT_MISMATCH',
        submissionId: submission.id,
        claimId,
        currentSourceCommit: submission.source_commit,
        claimSourceCommit: claim.source_commit,
      };
      if (commandId) failCommand(db, commandId, response);
      return response;
    }
    if (submission.target_head !== claim.target_head) {
      const response = {
        ok: false,
        code: 'TARGET_HEAD_MISMATCH',
        submissionId: submission.id,
        claimId,
        currentTargetHead: submission.target_head,
        claimTargetHead: claim.target_head,
      };
      if (commandId) failCommand(db, commandId, response);
      return response;
    }
    if (submission.target_worktree_id !== claim.target_worktree_id) {
      const response = {
        ok: false,
        code: 'TARGET_WORKTREE_MISMATCH',
        submissionId: submission.id,
        claimId,
        currentTargetWorktreeId: submission.target_worktree_id,
        claimTargetWorktreeId: claim.target_worktree_id,
      };
      if (commandId) failCommand(db, commandId, response);
      return response;
    }

    const nextClaimRevision = claim.revision + 1;
    const reviewSummary = summary || `review_${verdict}`;

    db.prepare(`
      UPDATE integration_claims
      SET review_verdict = ?, review_summary = ?, review_payload_json = ?, reviewed_at = ?,
          revision = ?, updated_at = ?
      WHERE id = ? AND revision = ?
    `).run(
      verdict,
      reviewSummary,
      payloadJson,
      timestamp,
      nextClaimRevision,
      timestamp,
      claimId,
      expectedClaimRevision,
    );

    const submissionStatus = verdict;
    const closedAt = verdict === 'rejected' ? (submission.closed_at ?? timestamp) : null;

    db.prepare(`
      UPDATE submissions
      SET status = ?, status_reason = ?, revision = revision + 1, updated_at = ?, closed_at = ?
      WHERE id = ?
    `).run(
      submissionStatus,
      reviewSummary,
      timestamp,
      closedAt,
      submission.id,
    );

    const updatedClaim = readIntegrationClaim(db, claimId);
    const updatedSubmission = readSubmission(db, submission.id);

    const response = {
      ok: true,
      claimId,
      submissionId: submission.id,
      verdict,
      summary: reviewSummary,
      revision: nextClaimRevision,
      claim: updatedClaim,
      submission: updatedSubmission,
      ...updatedClaim,
    };
    if (commandId) commitCommand(db, commandId, response, timestamp);
    return response;
  });
}

export function readIntegrationClaim(db, claimId) {
  if (!isNonEmptyString(claimId)) return null;
  const row = db.prepare('SELECT * FROM integration_claims WHERE id = ?').get(claimId);
  return mapClaim(row);
}

export function listIntegrationClaims(db, options = {}) {
  const { submissionId, status } = options;
  let sql = 'SELECT * FROM integration_claims WHERE 1 = 1';
  const params = [];
  if (isNonEmptyString(submissionId)) {
    sql += ' AND submission_id = ?';
    params.push(submissionId);
  }
  if (isNonEmptyString(status)) {
    sql += ' AND status = ?';
    params.push(status);
  }
  sql += ' ORDER BY created_at DESC, id DESC';
  const rows = db.prepare(sql).all(...params);
  return rows.map((row) => mapClaim(row));
}

/* ---------------- Integration Receipts (Append-Only) ---------------- */

export function recordIntegrationReceipt(db, request = {}, options = {}) {
  const {
    commandId,
    submissionId,
    claimId = null,
    outcome,
    summary,
    payload = {},
    payloadJson = canonicalJson(payload),
    integratedCommit = null,
  } = request;

  if (!isNonEmptyString(submissionId)) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'submissionId is required.' };
  }
  if (!isNonEmptyString(outcome) || !VALID_RECEIPT_OUTCOMES.has(outcome)) {
    return { ok: false, code: 'INVALID_OUTCOME', message: `Invalid receipt outcome: ${outcome}` };
  }
  if (!isNonEmptyString(summary)) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'summary is required.' };
  }

  const timestamp = iso(nowMillis(options));
  // A timestamp-derived receipt id inside the journal request made every
  // replay of the same command look like new content.  Command-backed
  // receipts therefore derive their id from the stable command id, and a
  // replayed journal row keeps its historical receipt id so its digest still
  // matches; this is compatibility only and never rewrites a stored receipt.
  let journalRequest = null;
  if (commandId) {
    const existingCommand = readCommand(db, commandId);
    if (existingCommand?.kind === 'integration.receipt' && existingCommand.request_json) {
      try { journalRequest = JSON.parse(existingCommand.request_json); } catch { journalRequest = null; }
    }
  }
  const receiptId = request.receiptId
    ?? request.id
    ?? journalRequest?.receiptId
    ?? (commandId
      ? receiptIdFor(submissionId, outcome, commandId)
      : receiptIdFor(submissionId, outcome, timestamp));

  const frozenRequest = {
    commandId,
    receiptId,
    submissionId,
    claimId,
    outcome,
    summary,
    payload: JSON.parse(payloadJson),
    integratedCommit,
  };

  if (commandId) {
    const begun = beginCommand(db, {
      commandId,
      kind: 'integration.receipt',
      request: frozenRequest,
    });
    if (begun.command.state === 'committed' || begun.command.state === 'failed') {
      return parseCommandResponse(begun.command);
    }
  }

  return withImmediateTransaction(db, () => {
    if (commandId) {
      const command = readCommand(db, commandId);
      if (command.state === 'committed' || command.state === 'failed') {
        return parseCommandResponse(command);
      }
    }

    const submission = db.prepare('SELECT * FROM submissions WHERE id = ?').get(submissionId);
    if (!submission) {
      const response = { ok: false, code: 'SUBMISSION_NOT_FOUND', submissionId };
      if (commandId) failCommand(db, commandId, response);
      return response;
    }

    if (claimId) {
      const claim = db.prepare('SELECT * FROM integration_claims WHERE id = ?').get(claimId);
      if (!claim) {
        const response = { ok: false, code: 'CLAIM_NOT_FOUND', claimId };
        if (commandId) failCommand(db, commandId, response);
        return response;
      }
      if (claim.submission_id !== submissionId) {
        const response = { ok: false, code: 'CLAIM_SUBMISSION_MISMATCH', claimId, submissionId };
        if (commandId) failCommand(db, commandId, response);
        return response;
      }
      if (claim.status === 'active') {
        const claimTerminalStatus = outcome === 'integrated' ? 'completed' : 'failed';
        db.prepare(`
          UPDATE integration_claims
          SET status = ?, status_reason = ?, revision = revision + 1, updated_at = ?, released_at = ?
          WHERE id = ? AND status = 'active'
        `).run(claimTerminalStatus, `receipt_${outcome}`, timestamp, timestamp, claimId);
      }
    }

    // Insert into integration_receipts using immutable submission attributes
    db.prepare(`
      INSERT INTO integration_receipts (
        id, submission_id, claim_id, project_id, space_id,
        source_commit, target_head, integrated_commit,
        outcome, summary, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receiptId,
      submission.id,
      claimId,
      submission.project_id,
      submission.space_id,
      submission.source_commit,
      submission.target_head,
      integratedCommit,
      outcome,
      summary,
      payloadJson,
      timestamp,
    );

    // Update submission status and revision
    db.prepare(`
      UPDATE submissions
      SET status = ?, status_reason = ?, revision = revision + 1, updated_at = ?, closed_at = ?
      WHERE id = ?
    `).run(outcome, summary, timestamp, timestamp, submission.id);

    const created = readIntegrationReceipt(db, receiptId);
    const response = {
      ok: true,
      receiptId,
      receipt: created,
      ...created,
    };
    if (commandId) commitCommand(db, commandId, response, timestamp);
    return response;
  });
}

export function readIntegrationReceipt(db, receiptId) {
  if (!isNonEmptyString(receiptId)) return null;
  const row = db.prepare('SELECT * FROM integration_receipts WHERE id = ?').get(receiptId);
  return mapReceipt(row);
}

export function listIntegrationReceipts(db, options = {}) {
  const { submissionId, projectId } = options;
  let sql = 'SELECT * FROM integration_receipts WHERE 1 = 1';
  const params = [];
  if (isNonEmptyString(submissionId)) {
    sql += ' AND submission_id = ?';
    params.push(submissionId);
  }
  if (isNonEmptyString(projectId)) {
    sql += ' AND project_id = ?';
    params.push(projectId);
  }
  sql += ' ORDER BY created_at DESC, id DESC';
  const rows = db.prepare(sql).all(...params);
  return rows.map((row) => mapReceipt(row));
}

/* ---------------- Repository Locks ---------------- */

export function acquireRepositoryLock(db, request = {}, options = {}) {
  const {
    commandId,
    repositoryIdentity,
    holder,
    operation,
    ttlMs = DEFAULT_LOCK_TTL_MS,
  } = request;

  if (!isNonEmptyString(repositoryIdentity)) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'repositoryIdentity is required.' };
  }
  if (!isNonEmptyString(holder)) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'holder is required.' };
  }
  if (!isNonEmptyString(operation)) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'operation is required.' };
  }
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'ttlMs must be positive.' };
  }

  const nowMs = nowMillis(options);
  const timestamp = iso(nowMs);
  const expiresAt = nowMs + ttlMs;
  const lockId = request.lockId ?? request.id ?? lockIdFor(repositoryIdentity, holder, timestamp);

  const frozenRequest = {
    commandId,
    lockId,
    repositoryIdentity,
    holder,
    operation,
    ttlMs,
  };

  if (commandId) {
    const begun = beginCommand(db, {
      commandId,
      kind: 'repository.lock.acquire',
      request: frozenRequest,
    });
    if (begun.command.state === 'committed' || begun.command.state === 'failed') {
      return parseCommandResponse(begun.command);
    }
  }

  return withImmediateTransaction(db, () => {
    if (commandId) {
      const command = readCommand(db, commandId);
      if (command.state === 'committed' || command.state === 'failed') {
        return parseCommandResponse(command);
      }
    }

    const current = db.prepare('SELECT * FROM repository_locks WHERE repository_identity = ?').get(repositoryIdentity);
    if (current) {
      if (current.expires_at <= nowMs) {
        // Safe takeover of expired lock
        db.prepare(`
          UPDATE repository_locks
          SET lock_id = ?, holder = ?, operation = ?, expires_at = ?, acquired_at = ?, updated_at = ?, command_id = ?
          WHERE repository_identity = ?
        `).run(lockId, holder, operation, expiresAt, timestamp, timestamp, commandId ?? null, repositoryIdentity);

        const response = {
          ok: true,
          acquired: true,
          tookOverExpired: true,
          lockId,
          repositoryIdentity,
          holder,
          operation,
          expiresAt,
          expiresAtIso: iso(expiresAt),
          acquiredAt: timestamp,
        };
        if (commandId) commitCommand(db, commandId, response, timestamp);
        return response;
      }

      // Lock is still active
      if (current.holder === holder && (current.lock_id === lockId || current.operation === operation)) {
        // Renew/extend
        db.prepare(`
          UPDATE repository_locks
          SET expires_at = ?, updated_at = ?
          WHERE repository_identity = ?
        `).run(expiresAt, timestamp, repositoryIdentity);

        const response = {
          ok: true,
          acquired: true,
          renewed: true,
          lockId: current.lock_id,
          repositoryIdentity,
          holder,
          operation,
          expiresAt,
          expiresAtIso: iso(expiresAt),
          acquiredAt: current.acquired_at,
        };
        if (commandId) commitCommand(db, commandId, response, timestamp);
        return response;
      }

      const response = {
        ok: false,
        code: 'REPOSITORY_LOCKED',
        repositoryIdentity,
        holder: current.holder,
        operation: current.operation,
        expiresAt: current.expires_at,
        expiresAtIso: iso(current.expires_at),
      };
      if (commandId) failCommand(db, commandId, response);
      return response;
    }

    db.prepare(`
      INSERT INTO repository_locks (
        repository_identity, lock_id, holder, operation, expires_at, acquired_at, updated_at, command_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      repositoryIdentity,
      lockId,
      holder,
      operation,
      expiresAt,
      timestamp,
      timestamp,
      commandId ?? null,
    );

    const response = {
      ok: true,
      acquired: true,
      lockId,
      repositoryIdentity,
      holder,
      operation,
      expiresAt,
      expiresAtIso: iso(expiresAt),
      acquiredAt: timestamp,
    };
    if (commandId) commitCommand(db, commandId, response, timestamp);
    return response;
  });
}

export function releaseRepositoryLock(db, request = {}, options = {}) {
  const {
    commandId,
    repositoryIdentity,
    holder,
    lockId,
  } = request;

  if (!isNonEmptyString(repositoryIdentity)) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'repositoryIdentity is required.' };
  }
  if (!isNonEmptyString(holder)) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'holder is required.' };
  }
  if (!isNonEmptyString(lockId)) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'lockId is required.' };
  }

  const timestamp = iso(nowMillis(options));
  const frozenRequest = {
    commandId,
    repositoryIdentity,
    holder,
    lockId,
  };

  if (commandId) {
    const begun = beginCommand(db, {
      commandId,
      kind: 'repository.lock.release',
      request: frozenRequest,
    });
    if (begun.command.state === 'committed' || begun.command.state === 'failed') {
      return parseCommandResponse(begun.command);
    }
  }

  return withImmediateTransaction(db, () => {
    if (commandId) {
      const command = readCommand(db, commandId);
      if (command.state === 'committed' || command.state === 'failed') {
        return parseCommandResponse(command);
      }
    }

    const current = db.prepare('SELECT * FROM repository_locks WHERE repository_identity = ?').get(repositoryIdentity);
    if (!current) {
      const response = {
        ok: true,
        released: false,
        alreadyReleased: true,
        repositoryIdentity,
        lockId,
      };
      if (commandId) commitCommand(db, commandId, response, timestamp);
      return response;
    }

    if (current.holder !== holder) {
      const response = {
        ok: false,
        code: 'LOCK_HOLDER_MISMATCH',
        repositoryIdentity,
        currentHolder: current.holder,
        expectedHolder: holder,
      };
      if (commandId) failCommand(db, commandId, response);
      return response;
    }

    if (current.lock_id !== lockId) {
      const response = {
        ok: false,
        code: 'LOCK_ID_MISMATCH',
        repositoryIdentity,
        currentLockId: current.lock_id,
        expectedLockId: lockId,
      };
      if (commandId) failCommand(db, commandId, response);
      return response;
    }

    db.prepare('DELETE FROM repository_locks WHERE repository_identity = ?').run(repositoryIdentity);

    const response = {
      ok: true,
      released: true,
      repositoryIdentity,
      lockId: current.lock_id,
    };
    if (commandId) commitCommand(db, commandId, response, timestamp);
    return response;
  });
}

export function readRepositoryLock(db, repositoryIdentity, options = {}) {
  if (!isNonEmptyString(repositoryIdentity)) return null;
  const current = db.prepare('SELECT * FROM repository_locks WHERE repository_identity = ?').get(repositoryIdentity);
  if (!current) return null;
  const nowMs = nowMillis(options);
  const isExpired = current.expires_at <= nowMs;
  return {
    ...mapLock(current),
    isExpired,
  };
}
