import { randomBytes } from 'node:crypto';
import { beginCommand, canonicalJson, parseCommandResponse } from './command-journal.mjs';
import { withImmediateTransaction } from './database.mjs';
import { readSessionContext } from './assignments.mjs';
import { acquireRepositoryLock, releaseRepositoryLock, readSubmission } from './integrations.mjs';
import { assertDeliveryCwd, deliveryError, deliveryId, observeDeliverySource, readDeliverySource } from './delivery-sources.mjs';
import { inspectDelivery, readDeliveryLocation, chooseRemote, saveDelivery, pushDelivery, verifyDeliveryRemote } from '../git/delivery-ops.mjs';
import { discardDeliveryCache } from './delivery-cache.mjs';

const now = () => new Date().toISOString();
const inFlight = new WeakMap();
function once(db, request, operation) {
  let active = inFlight.get(db);
  if (!active) { active = new Map(); inFlight.set(db, active); }
  const digest = canonicalJson(request);
  const previous = active.get(request.commandId);
  if (previous) return previous.digest === digest ? previous.promise
    : Promise.resolve({ ok: false, code: 'COMMAND_CONFLICT', retryable: false });
  const promise = Promise.resolve().then(operation).finally(() => active.delete(request.commandId));
  active.set(request.commandId, { digest, promise });
  return promise;
}
function finishCommand(db, commandId, result) {
  db.prepare("UPDATE commands SET state = ?, response_json = ?, updated_at = ? WHERE id = ? AND state = 'received'")
    .run(result.ok ? 'committed' : 'failed', canonicalJson(result), now(), commandId);
  return result;
}

function checkLease(db, source, sessionId, revision, { readOnly = false } = {}) {
  const lease = db.prepare('SELECT * FROM write_leases WHERE worktree_id = ?').get(source.worktree_id);
  if (sessionId) {
    const context = readSessionContext(db, sessionId);
    if (!context.ok || context.worktreeId !== source.worktree_id || context.projectId !== source.project_id
      || context.status !== 'active' || context.run?.lifecycle !== 'active' || context.revision !== revision
      || (lease && lease.run_id !== sessionId)) throw deliveryError('DELIVERY_SESSION_MISMATCH');
  } else if (lease && !readOnly) throw deliveryError('DELIVERY_WRITE_LEASE_CONFLICT');
}

function checkRemotes(source, inspection) {
  if (inspection.sourceRemote.identity !== source.source_remote_identity
    || inspection.targetRemote.identity !== source.target_remote_identity) throw deliveryError('DELIVERY_REMOTE_CHANGED');
}

export function prepareDelivery(db, request, options = {}) {
  return once(db, request, () => prepareDeliveryOnce(db, request, options));
}
async function prepareDeliveryOnce(db, request, options = {}) {
  const { commandId, sourceId, sessionId, expectedRevision, files } = request;
  const begun = beginCommand(db, { commandId, kind: 'delivery.preflight', request });
  if (['committed', 'failed'].includes(begun.command.state)) return parseCommandResponse(begun.command);
  for (const expired of db.prepare(`SELECT inspection_json FROM delivery_preflights p
    LEFT JOIN delivery_attempts a ON a.preflight_id = p.id
    WHERE p.expires_at < ? AND (a.state IS NULL OR a.state = 'completed')`).all(Date.now())) discardDeliveryCache(JSON.parse(expired.inspection_json));
  let inspection = null;
  let retained = false;
  try {
    const { source, project } = await (options.observeSource ?? observeDeliverySource)(db, sourceId);
    const location = await (options.readLocation ?? readDeliveryLocation)(source.canonical_path);
    if (!location.branch || location.branch === 'main') throw deliveryError('DELIVERY_SOURCE_IS_MAIN');
    if (files === undefined && location.changes.length) {
      return finishCommand(db, commandId, { ok: true, ready: false, code: 'DELIVERY_SCOPE_REQUIRED',
        projectName: project.name, changes: location.changes, sourceBranch: location.branch,
        nextAction: '请按本次任务选择要保存的文件，再用新的请求号检查；[] 表示仅送审已提交成果。' });
    }
    inspection = await (options.inspect ?? inspectDelivery)({ sourcePath: source.canonical_path,
      targetPath: project.canonical_path, targetBranch: 'main', files: files ?? [] });
    checkRemotes(source, inspection);
    const readOnly = !inspection.files.length && !location.changes.length && inspection.published;
    checkLease(db, source, sessionId, expectedRevision, { readOnly });
    const duplicate = db.prepare(`SELECT * FROM submissions WHERE project_id = ? AND source_branch = ?
      AND source_commit = ? AND target_head = ? AND status NOT IN ('stale','withdrawn','cancelled')
      ORDER BY created_at DESC LIMIT 1`).get(source.project_id, inspection.branch, inspection.head, inspection.targetHead);
    if (!inspection.files.length && duplicate &&
      (JSON.parse(duplicate.delivery_json).sourceRemoteIdentity === inspection.sourceRemote.identity
        || duplicate.source_worktree_id === source.worktree_id)) {
      return finishCommand(db, commandId, { ok: true, ready: false, code: 'DELIVERY_ALREADY_SUBMITTED',
        submissionId: duplicate.id, revision: duplicate.revision, sourceCommit: duplicate.source_commit,
        targetHead: duplicate.target_head, projectName: project.name, alreadyExists: true });
    }
    if (inspection.relation === 'already_integrated') {
      return finishCommand(db, commandId, { ok: true, ready: false, code: 'DELIVERY_ALREADY_INTEGRATED',
        projectName: project.name, sourceCommit: inspection.head, targetHead: inspection.targetHead });
    }
    const preflightId = randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + 15 * 60_000;
    db.prepare(`INSERT INTO delivery_preflights
      (id,command_id,source_id,session_id,session_revision,inspection_json,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(preflightId, commandId, sourceId, sessionId ?? null, expectedRevision ?? null,
        canonicalJson({ ...inspection, readOnly }), now(), expiresAt);
    retained = true;
    return finishCommand(db, commandId, { ok: true, ready: true, preflightId, expiresAt,
      projectName: project.name, sourceBranch: inspection.branch, sourceCommit: inspection.head,
      targetHead: inspection.targetHead, files: inspection.files, changes: location.changes,
      relation: inspection.relation, conflicts: inspection.conflicts, fastForward: inspection.fastForward,
      requiresConflictConfirmation: inspection.relation === 'conflict',
      nextAction: inspection.relation === 'conflict' ? '存在合并冲突；只有用户确认后才保存为需处理的待办。' : '预检通过，可以保存并送交主项目审核。' });
  } catch (error) {
    const completed = db.prepare('SELECT * FROM commands WHERE id = ?').get(commandId);
    if (completed?.state === 'committed') return parseCommandResponse(completed);
    return finishCommand(db, commandId, {
      ok: false,
      code: typeof error.code === 'string' ? error.code : 'DELIVERY_CHECK_FAILED',
      ...(error.details !== undefined ? { details: error.details } : {}),
      localSaved: false,
      pushed: false,
    });
  } finally {
    if (!retained && inspection) discardDeliveryCache(inspection);
  }
}

function recordDelivery(db, source, project, inspection, sourceCommit, request) {
  return withImmediateTransaction(db, () => {
    const complete = (submission, alreadyExists) => {
      db.prepare("UPDATE delivery_attempts SET state = 'completed', submission_id = ?, updated_at = ? WHERE command_id = ?")
        .run(submission.submissionId, now(), request.commandId);
      return finishCommand(db, request.commandId, { ok: true, submissionId: submission.submissionId,
        sourceCommit: submission.sourceCommit, targetHead: submission.targetHead, revision: submission.revision,
        deliveryVersion: submission.deliveryVersion, status: submission.status, alreadyExists,
        localSaved: true, pushed: true, projectName: project.name, nextAction: '请在主项目待审核列表复制审核指令。' });
    };
    const lineKey = deliveryId('delivery_line', `${project.id}\0${inspection.sourceRemote.identity}\0${inspection.branch}\0${inspection.targetBranch}`);
    const rows = db.prepare(`SELECT * FROM submissions WHERE delivery_line_key = ? ORDER BY delivery_version DESC`).all(lineKey);
    const identical = rows.find((row) => row.source_commit === sourceCommit && row.target_head === inspection.targetHead
      && !['stale', 'cancelled', 'withdrawn'].includes(row.status));
    if (identical) return complete(readSubmission(db, identical.id), true);
    if (rows.some((row) => row.status === 'merging' || db.prepare("SELECT command_id FROM integration_attempts WHERE submission_id = ? AND state IN ('prepared','local_integrated','pushed')").get(row.id))) throw deliveryError('DELIVERY_INTEGRATION_BUSY');
    const version = (rows[0]?.delivery_version ?? 0) + 1;
    const submissionId = deliveryId('submission', `${lineKey}\0${sourceCommit}\0${inspection.targetHead}\0${version}`);
    const space = db.prepare("SELECT id FROM development_spaces WHERE project_id = ? AND worktree_id = ? AND status != 'archived'").get(project.id, source.worktree_id);
    db.prepare(`INSERT INTO submissions (id,project_id,space_id,source_worktree_id,target_worktree_id,
      source_branch,source_commit,target_branch,target_head,status,status_reason,revision,title,description,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,'pending','delivery_checked',0,?,?,?,?)`)
      .run(submissionId, project.id, space?.id ?? null, source.worktree_id, project.worktree_id,
        inspection.branch, sourceCommit, inspection.targetBranch, inspection.targetHead, request.summary, request.summary, now(), now());
    if (space) db.prepare("UPDATE development_spaces SET status = 'awaiting_review', status_reason = 'delivery_submitted', revision = revision + 1, updated_at = ? WHERE id = ?").run(now(), space.id);
    for (const previous of rows.filter((row) => !['integrated', 'merged', 'rejected', 'cancelled', 'withdrawn', 'stale'].includes(row.status))) {
      db.prepare("UPDATE submissions SET status = 'stale', status_reason = 'new_delivery_version', revision = revision + 1, updated_at = ? WHERE id = ?")
        .run(now(), previous.id);
      db.prepare("UPDATE integration_claims SET status = 'released', status_reason = 'new_delivery_version', revision = revision + 1, updated_at = ?, released_at = ? WHERE submission_id = ? AND status = 'active'")
        .run(now(), now(), previous.id);
    }
    const delivery = { sourceRemoteIdentity: inspection.sourceRemote.identity, sourceRemoteUrl: inspection.sourceRemote.url,
      targetRemoteIdentity: inspection.targetRemote.identity, targetRemoteUrl: inspection.targetRemote.url,
      sourceId: source.id, relation: inspection.relation,
      fastForward: inspection.fastForward, conflicts: inspection.conflicts, files: inspection.files,
      pullRequestUrl: request.pullRequestUrl ?? null, pullRequestVerified: false, attribution: 'unattributed' };
    db.prepare(`UPDATE submissions SET delivery_json = ?, delivery_line_key = ?, delivery_version = ?,
      status = ?, status_reason = ? WHERE id = ?`).run(canonicalJson(delivery), lineKey, version,
      inspection.relation === 'conflict' ? 'conflict' : 'pending',
      inspection.relation === 'conflict' ? 'delivery_merge_conflict' : 'delivery_checked', submissionId);
    return complete(readSubmission(db, submissionId), false);
  });
}

export function submitDelivery(db, request, options = {}) {
  return once(db, request, () => submitDeliveryOnce(db, request, options));
}
async function submitDeliveryOnce(db, request, options = {}) {
  const { commandId, preflightId, mcpWorkingDirectory } = request;
  const prepared = db.prepare('SELECT * FROM delivery_preflights WHERE id = ?').get(preflightId);
  if (!prepared) return { ok: false, code: 'DELIVERY_PREFLIGHT_REQUIRED', localSaved: false, pushed: false };
  const source = readDeliverySource(db, prepared.source_id);
  try { assertDeliveryCwd(source, mcpWorkingDirectory); } catch (error) { return { ok: false, code: error.code }; }
  const begun = beginCommand(db, { commandId, kind: 'delivery.submit', request });
  if (['committed', 'failed'].includes(begun.command.state)) return parseCommandResponse(begun.command);
  let attempt = db.prepare('SELECT * FROM delivery_attempts WHERE command_id = ?').get(commandId);
  const inspection = JSON.parse(prepared.inspection_json);
  const locks = [];
  const holder = `delivery:${commandId}:${randomBytes(8).toString('hex')}`;
  let localSaveEvidence = null;
  const assertLocks = () => {
    for (const lock of locks) {
      const row = db.prepare('SELECT * FROM repository_locks WHERE repository_identity = ?').get(lock.repositoryIdentity);
      if (!row || row.lock_id !== lock.lockId || row.holder !== holder || row.expires_at <= Date.now()) throw deliveryError('REPOSITORY_LOCKED');
    }
  };
  function update(values) {
    const fields = Object.keys(values);
    db.prepare(`UPDATE delivery_attempts SET ${fields.map((key) => `${key} = ?`).join(', ')}, updated_at = ? WHERE command_id = ?`)
      .run(...Object.values(values), now(), commandId);
    attempt = db.prepare('SELECT * FROM delivery_attempts WHERE command_id = ?').get(commandId);
  }
  try {
    const { project } = await (options.observeSource ?? observeDeliverySource)(db, source.id);
    for (const identity of [...new Set([source.repository_identity, project.repository_identity])].sort()) {
      const lock = acquireRepositoryLock(db, { repositoryIdentity: identity, holder, operation: 'delivery_submit', ttlMs: 10 * 60_000 });
      if (!lock.ok) throw deliveryError('REPOSITORY_LOCKED');
      locks.push({ repositoryIdentity: identity, lockId: lock.lockId });
    }
    if (!attempt) {
      if (prepared.expires_at < Date.now()) throw deliveryError('DELIVERY_PREFLIGHT_EXPIRED');
      if (inspection.relation === 'conflict' && !request.allowConflicts) throw deliveryError('DELIVERY_CONFLICT_CONFIRMATION_REQUIRED');
      const used = db.prepare('SELECT command_id FROM delivery_attempts WHERE preflight_id = ?').get(preflightId);
      if (used) throw deliveryError('DELIVERY_PREFLIGHT_USED');
      db.prepare("INSERT INTO delivery_attempts (command_id,preflight_id,state,updated_at) VALUES (?,?,'prepared',?)")
        .run(commandId, preflightId, now());
      attempt = db.prepare('SELECT * FROM delivery_attempts WHERE command_id = ?').get(commandId);
    }
    if (attempt.state === 'attention') throw deliveryError(attempt.last_error_code ?? 'DELIVERY_CHECK_FAILED');
    const location = await (options.readLocation ?? readDeliveryLocation)(source.canonical_path);
    const targetLocation = await (options.readLocation ?? readDeliveryLocation)(project.canonical_path);
    const targetRemote = chooseRemote(targetLocation.remotes, 'target');
    const sourceRemote = chooseRemote(location.remotes, 'source');
    if (targetRemote.identity !== inspection.targetRemote.identity || targetRemote.url !== inspection.targetRemote.url
      || sourceRemote.identity !== inspection.sourceRemote.identity || sourceRemote.url !== inspection.sourceRemote.url) {
      throw deliveryError('DELIVERY_REMOTE_CHANGED');
    }
    checkRemotes(source, inspection);
    checkLease(db, source, prepared.session_id, prepared.session_revision, { readOnly: inspection.readOnly && !location.changes.length });
    if (attempt.state === 'prepared') {
      // Recheck target/source remote refs before making a local commit. saveDelivery
      // also fences current bytes and handles an already-created matching commit.
      if (location.head === inspection.head) {
        if (prepared.expires_at < Date.now()) throw deliveryError('DELIVERY_PREFLIGHT_EXPIRED');
        const refreshed = await (options.inspect ?? inspectDelivery)({ sourcePath: source.canonical_path,
          targetPath: project.canonical_path, files: inspection.files, targetBranch: inspection.targetBranch });
        discardDeliveryCache(refreshed);
        if (refreshed.fingerprint !== inspection.fingerprint || refreshed.candidateTree !== inspection.candidateTree
          || refreshed.branch !== inspection.branch || refreshed.targetHead !== inspection.targetHead
          || refreshed.sourceRemote.identity !== inspection.sourceRemote.identity || refreshed.targetRemote.identity !== inspection.targetRemote.identity) {
          throw deliveryError('DELIVERY_PREFLIGHT_STALE');
        }
      }
      assertLocks();
      const saved = await (options.save ?? saveDelivery)({ sourcePath: source.canonical_path, inspection, commandId, summary: request.summary,
        beforeWrite: () => { assertLocks(); checkLease(db, source, prepared.session_id, prepared.session_revision, { readOnly: inspection.readOnly }); },
        afterRefUpdate: () => options.faultInjector?.('after_delivery_ref_update') });
      localSaveEvidence = saved;
      await options.faultInjector?.('after_delivery_commit');
      update({ state: 'local_saved', source_commit: saved.sourceCommit });
    }
    if (attempt.state === 'local_saved') {
      assertLocks();
      await (options.observeSource ?? observeDeliverySource)(db, source.id);
      checkLease(db, source, prepared.session_id, prepared.session_revision, { readOnly: inspection.readOnly && !location.changes.length });
      if (!inspection.readOnly) await (options.push ?? pushDelivery)({ sourcePath: source.canonical_path, inspection, sourceCommit: attempt.source_commit,
        beforeWrite: () => { assertLocks(); checkLease(db, source, prepared.session_id, prepared.session_revision); } });
      await options.faultInjector?.('after_delivery_push');
      update({ state: 'pushed' });
    }
    await (options.verify ?? verifyDeliveryRemote)({ sourcePath: source.canonical_path, inspection, sourceCommit: attempt.source_commit });
    assertLocks();
    await (options.observeSource ?? observeDeliverySource)(db, source.id);
    const result = recordDelivery(db, source, project, inspection, attempt.source_commit, request);
    discardDeliveryCache(inspection);
    await options.faultInjector?.('after_delivery_receipt');
    return result;
  } catch (error) {
    const completed = db.prepare('SELECT * FROM commands WHERE id = ?').get(commandId);
    if (completed?.state === 'committed') return parseCommandResponse(completed);
    if ((error.localSaved || localSaveEvidence) && attempt?.state === 'prepared') update({ state: localSaveEvidence ? 'local_saved' : 'prepared', source_commit: error.sourceCommit ?? localSaveEvidence?.sourceCommit ?? attempt.source_commit });
    const code = typeof error.code === 'string' ? error.code : 'DELIVERY_CHECK_FAILED';
    const requiresNewPreflight = ['DELIVERY_PREFLIGHT_EXPIRED','DELIVERY_PREFLIGHT_STALE','HEAD_MOVED','SOURCE_CONTENT_CHANGED',
      'REMOTE_TARGET_CHANGED','REMOTE_SOURCE_MISMATCH','REMOTE_IDENTITY_CHANGED','BRANCH_MISMATCH','DELIVERY_REMOTE_CHANGED',
      'DELIVERY_CACHE_INVALID','DELIVERY_INDEX_CHANGED','SOURCE_COMMIT_MISMATCH'].includes(code);
    const result = { ok: false, code,
      ...(error.details !== undefined ? { details: error.details } : {}),
      localSaved: Boolean(attempt?.source_commit), pushed: ['pushed','completed'].includes(attempt?.state),
      sourceCommit: attempt?.source_commit ?? null, retryable: !requiresNewPreflight && (Boolean(attempt) || code === 'REPOSITORY_LOCKED'),
      requiresNewPreflight, submissionId: attempt?.submission_id ?? null };
    if (attempt) update({ last_error_code: result.code });
    else if (result.code !== 'REPOSITORY_LOCKED') finishCommand(db, commandId, result);
    return result;
  } finally {
    for (const lock of locks) releaseRepositoryLock(db, { ...lock, holder });
  }
}
