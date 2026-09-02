import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import {
  beginCommand,
  canonicalJson,
  parseCommandResponse,
  readCommand,
} from './command-journal.mjs';
import { withImmediateTransaction } from './database.mjs';
import { readSessionContext } from './assignments.mjs';

/**
 * Conversation relay is intentionally separate from terminal handoff.  A
 * relay records enough context for another AI conversation to continue, but
 * leaves the assignment, Run and write lease active until that conversation
 * explicitly resumes it.
 */

export const DEFAULT_RELAY_TTL_MS = 30 * 60 * 1000;
export const MAX_RELAY_TTL_MS = 24 * 60 * 60 * 1000;

const TERMINAL_COMMAND_STATES = new Set(['committed', 'failed']);
const MAX_TEXT_LENGTH = 20_000;
const MAX_LIST_ITEMS = 100;
const MAX_ITEM_LENGTH = 4_000;
const SENSITIVE_KEY = /(?:token|secret|password|authorization|api[_-]?key|private[_-]?key)/i;
const SENSITIVE_VALUE = /(?:bearer\s+|(?:access[_ -]?)?token\s*[:=]|api[_ -]?key\s*[:=]|password\s*[:=]|secret\s*[:=])\S+/i;

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

function timestamp(options = {}) {
  return new Date(nowMillis(options)).toISOString();
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function invalid(message = 'Invalid relay request.') {
  return { ok: false, code: 'INVALID_REQUEST', message };
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function codeMatches(storedHash, code) {
  if (!isNonEmptyString(storedHash) || !isNonEmptyString(code)) return false;
  const expected = Buffer.from(storedHash, 'hex');
  const actual = Buffer.from(digest(code), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function relayIdFor(sessionId, clientRequestId) {
  return `relay_${createHash('sha256')
    .update(`${sessionId}\0${clientRequestId}`)
    .digest('hex')
    .slice(0, 32)}`;
}

function commandIdFor(prefix, relayId, clientRequestId) {
  return `${prefix}.${relayId}.${clientRequestId}`;
}

function terminalResult(command) {
  return command && TERMINAL_COMMAND_STATES.has(command.state)
    ? parseCommandResponse(command)
    : null;
}

function failCommand(db, commandId, response, at = new Date().toISOString()) {
  db.prepare(`
    UPDATE commands
    SET state = 'failed', response_json = ?, updated_at = ?
    WHERE id = ? AND state = 'received'
  `).run(canonicalJson(response), at, commandId);
  return response;
}

function commitCommand(db, commandId, response, at, runId = null) {
  db.prepare(`
    UPDATE commands
    SET state = 'committed', response_json = ?, run_id = COALESCE(?, run_id), updated_at = ?
    WHERE id = ? AND state = 'received'
  `).run(canonicalJson(response), runId, at, commandId);
  return response;
}

function inspectValue(value, key = '') {
  if (SENSITIVE_KEY.test(key)) return 'sensitive fields are not accepted in relay data';
  if (typeof value === 'string') {
    if (value.length > MAX_ITEM_LENGTH) return 'relay item is too long';
    if (SENSITIVE_VALUE.test(value)) return 'tokens and credentials are not accepted in relay data';
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const error = inspectValue(item, key);
      if (error) return error;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(value)) {
      const error = inspectValue(childValue, childKey);
      if (error) return error;
    }
  }
  return null;
}

function normalizeText(value, name, { required = false } = {}) {
  const text = value ?? '';
  if (
    typeof text !== 'string'
    || text.length > MAX_TEXT_LENGTH
    || (required && !isNonEmptyString(text))
  ) {
    throw new TypeError(
      `${name} must be a ${required ? 'non-empty ' : ''}string of at most ${MAX_TEXT_LENGTH} characters.`,
    );
  }
  const error = inspectValue(text, name);
  if (error) throw new TypeError(error);
  return text;
}

function normalizeList(value, name, { stringsOnly = false } = {}) {
  const list = value ?? [];
  if (!Array.isArray(list) || list.length > MAX_LIST_ITEMS) {
    throw new TypeError(`${name} must be an array with at most ${MAX_LIST_ITEMS} items.`);
  }
  for (const item of list) {
    if (stringsOnly && typeof item !== 'string') {
      throw new TypeError(`${name} items must be reference text.`);
    }
    if (
      typeof item !== 'string'
      && (!item || typeof item !== 'object' || Array.isArray(item))
    ) {
      throw new TypeError(`${name} items must be strings or plain objects.`);
    }
    if (typeof item === 'string' && item.length > MAX_ITEM_LENGTH) {
      throw new TypeError(`${name} item is too long.`);
    }
  }
  const error = inspectValue(list, name);
  if (error) throw new TypeError(error);
  return list;
}

function normalizedFields(request) {
  const fields = {
    nextSessionFocus: request.nextSessionFocus ?? request.next_session_focus,
    summary: request.summary,
    currentState: request.currentState ?? request.current_state,
    completedItems: request.completedItems ?? request.completed_items,
    pendingItems: request.pendingItems ?? request.pending_items,
    decisions: request.decisions,
    artifactRefs: request.artifactRefs ?? request.artifact_refs,
    risks: request.risks,
    suggestedSkills: request.suggestedSkills ?? request.suggested_skills,
  };
  return {
    nextSessionFocus: normalizeText(fields.nextSessionFocus, 'nextSessionFocus', { required: true }),
    summary: normalizeText(fields.summary, 'summary', { required: true }),
    currentState: normalizeText(fields.currentState, 'currentState', { required: true }),
    completedItems: normalizeList(fields.completedItems, 'completedItems'),
    pendingItems: normalizeList(fields.pendingItems, 'pendingItems'),
    decisions: normalizeList(fields.decisions, 'decisions'),
    artifactRefs: normalizeList(fields.artifactRefs, 'artifactRefs', { stringsOnly: true }),
    risks: normalizeList(fields.risks, 'risks'),
    suggestedSkills: normalizeList(fields.suggestedSkills, 'suggestedSkills'),
  };
}

function parseJson(encoded, fallback) {
  try {
    return JSON.parse(encoded);
  } catch {
    return fallback;
  }
}

function mapRelay(row) {
  if (!row) return null;
  return {
    ok: true,
    id: row.id,
    relayId: row.id,
    sequence: row.sequence,
    assignmentId: row.assignment_id,
    projectId: row.project_id,
    worktreeId: row.worktree_id,
    sessionId: row.session_id,
    runId: row.run_id,
    clientRequestId: row.client_request_id,
    expectedRevision: row.expected_revision,
    revision: row.revision,
    nextSessionFocus: row.next_session_focus,
    summary: row.summary,
    currentState: row.current_state,
    completedItems: parseJson(row.completed_items, []),
    pendingItems: parseJson(row.pending_items, []),
    decisions: parseJson(row.decisions, []),
    artifactRefs: parseJson(row.artifact_refs, []),
    risks: parseJson(row.risks, []),
    suggestedSkills: parseJson(row.suggested_skills, []),
    // Safe diagnostic value; the one-time continueCode itself is never
    // returned by read APIs or persisted anywhere.
    codeHash: row.code_hash,
    state: row.state,
    status: row.state,
    expiresAt: row.expires_at,
    expiresAtIso: new Date(row.expires_at).toISOString(),
    createdAt: row.created_at,
    acceptedAt: row.accepted_at,
    acceptedClientRequestId: row.accepted_client_request_id,
    acceptedRevision: row.accepted_revision,
  };
}

function sameRelayRequest(row, fields, expectedRevision) {
  return row.expected_revision === expectedRevision
    && row.next_session_focus === fields.nextSessionFocus
    && row.summary === fields.summary
    && row.current_state === fields.currentState
    && row.completed_items === canonicalJson(fields.completedItems)
    && row.pending_items === canonicalJson(fields.pendingItems)
    && row.decisions === canonicalJson(fields.decisions)
    && row.artifact_refs === canonicalJson(fields.artifactRefs)
    && row.risks === canonicalJson(fields.risks)
    && row.suggested_skills === canonicalJson(fields.suggestedSkills);
}

function relayRow(db, relayId) {
  return db.prepare('SELECT * FROM relays WHERE id = ?').get(relayId) ?? null;
}

function relayRowByCodeHash(db, codeHash) {
  return db.prepare('SELECT * FROM relays WHERE code_hash = ?').get(codeHash) ?? null;
}

function continueMessage(code = null) {
  if (!code) {
    return '接力记录已保存；当前会话仍保持 active。请在新的 AI 会话中调用 ugk_work_resume，并使用此前收到的一次性 continueCode；不要重新 init。';
  }
  return [
    '请在与原会话相同的项目目录中使用 `$cockpit-relay` 恢复 UGK Cockpit 接力。',
    '',
    `continueCode: "${code}"`,
    '',
    '不要重新 init，也不要清理、覆盖或重置已有改动。',
    '恢复成功后告诉我 `sessionId` 和 `revision`，然后等待我的下一步安排。',
    '如果 `$cockpit-relay` 不可用，请改用 UGK Cockpit MCP 的 `ugk_work_resume`；不要传路径或本地 token。',
  ].join('\n');
}

function preparedResponse(row, continueCode = null) {
  const relay = mapRelay(row);
  return {
    ok: true,
    relayPrepared: true,
    status: 'awaiting_resume',
    continueCode,
    continueMessage: continueMessage(continueCode),
    sessionId: row.session_id,
    revision: row.revision,
    relayId: row.id,
    assignmentId: row.assignment_id,
    projectId: row.project_id,
    worktreeId: row.worktree_id,
    expiresAt: row.expires_at,
    expiresAtIso: new Date(row.expires_at).toISOString(),
    nextSessionFocus: relay.nextSessionFocus,
    summary: relay.summary,
    currentState: relay.currentState,
    completedItems: relay.completedItems,
    pendingItems: relay.pendingItems,
    decisions: relay.decisions,
    artifactRefs: relay.artifactRefs,
    risks: relay.risks,
    suggestedSkills: relay.suggestedSkills,
    relay,
    relayContext: relay,
  };
}

function preparedReplayResponse(command, continueCode) {
  const response = parseCommandResponse(command);
  if (!response?.ok || response.relayPrepared !== true) return null;
  return {
    ...response,
    continueCode,
    continueMessage: continueMessage(continueCode),
  };
}

function acceptedResponse(row, context, acceptedRevision) {
  const relay = mapRelay(row);
  return {
    ok: true,
    relayAccepted: true,
    status: 'active',
    sessionId: row.session_id,
    revision: acceptedRevision,
    relayId: row.id,
    assignmentId: row.assignment_id,
    projectId: row.project_id,
    worktreeId: row.worktree_id,
    relay,
    relayContext: relay,
    nextSessionFocus: relay.nextSessionFocus,
    summary: relay.summary,
    currentState: relay.currentState,
    completedItems: relay.completedItems,
    pendingItems: relay.pendingItems,
    decisions: relay.decisions,
    artifactRefs: relay.artifactRefs,
    risks: relay.risks,
    suggestedSkills: relay.suggestedSkills,
    context: context ?? null,
  };
}

function parseExpiresAt(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value)) return Date.parse(value);
  return Number(value);
}

function relayBindingMatches(request, row) {
  if (request.projectId !== undefined && request.projectId !== row.project_id) return false;
  if (request.worktreeId !== undefined && request.worktreeId !== row.worktree_id) return false;
  if (request.canonicalPath !== undefined && request.canonicalPath !== row.canonical_path) return false;
  // The HTTP adapter resolves a working directory to the registered binding
  // before calling this module.  Keep an exact-path fallback for direct core
  // callers as well; a caller must never be able to resume an unrelated
  // project by presenting only a valid code.
  const workingDirectory = request.workingDirectory ?? request.mcpWorkingDirectory;
  if (
    workingDirectory !== undefined
    && request.canonicalPath === undefined
    && workingDirectory !== row.canonical_path
  ) return false;
  if (request.repositoryIdentity !== undefined && request.repositoryIdentity !== row.repository_identity) return false;
  if (request.worktreeIdentity !== undefined && request.worktreeIdentity !== row.identity_fingerprint) return false;
  return true;
}

function liveSession(db, sessionId) {
  const context = readSessionContext(db, sessionId);
  if (!context?.ok) return context ?? { ok: false, code: 'SESSION_NOT_FOUND', sessionId };
  if (!context.run || context.run.lifecycle !== 'active') {
    return { ok: false, code: 'SESSION_NOT_ACTIVE', sessionId };
  }
  if (!['accepted', 'active'].includes(context.status)) {
    return { ok: false, code: 'ASSIGNMENT_NOT_ACTIVE', sessionId, status: context.status };
  }
  const lease = db.prepare('SELECT * FROM write_leases WHERE run_id = ?').get(sessionId);
  if (!lease || lease.generation !== context.run.leaseGeneration) {
    return { ok: false, code: 'STALE_WRITE_LEASE', sessionId };
  }
  return context;
}

function revisionConflict(context, sessionId) {
  return {
    ok: false,
    code: 'RELAY_REVISION_CONFLICT',
    sessionId,
    assignmentId: context?.assignmentId ?? null,
    revision: context?.revision ?? null,
    runRevision: context?.run?.revision ?? null,
  };
}

function requestedExpiry(request, options) {
  const issuedAt = nowMillis(options);
  const expiresAt = request.expiresAt === undefined
    ? issuedAt + Number(request.ttlMs ?? options.ttlMs ?? DEFAULT_RELAY_TTL_MS)
    : parseExpiresAt(request.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
    return { ok: false, code: 'RELAY_EXPIRED' };
  }
  if (expiresAt - issuedAt > MAX_RELAY_TTL_MS) {
    return { ok: false, code: 'RELAY_TTL_TOO_LONG', maxTtlMs: MAX_RELAY_TTL_MS };
  }
  return { ok: true, issuedAt, expiresAt };
}

/**
 * Persist a short-lived conversation relay and advance the active session's
 * revision.  The returned continueCode is never persisted; HTTP callers may
 * deterministically derive it so an idempotent retry can rebuild the original
 * prepared response from the command journal and relay row.
 */
export function createRelay(db, request = {}, options = {}) {
  const sessionId = request.sessionId;
  const clientRequestId = request.clientRequestId ?? request.clientRequest;
  const expectedRevision = Number(request.expectedRevision);
  if (!isNonEmptyString(sessionId) || !isNonEmptyString(clientRequestId)) {
    return invalid('sessionId and clientRequestId are required.');
  }
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    return invalid('expectedRevision must be a positive integer.');
  }
  let fields;
  try {
    fields = normalizedFields(request);
  } catch (error) {
    return invalid(error.message);
  }
  const relayId = request.relayId ?? request.id ?? relayIdFor(sessionId, clientRequestId);
  if (!isNonEmptyString(relayId)) return invalid('relayId must be non-empty.');
  const continueCode = request.continueCode ?? randomBytes(32).toString('base64url');
  if (!isNonEmptyString(continueCode)) return invalid('continueCode must be non-empty.');
  const codeHash = digest(continueCode);
  const commandId = request.commandId
    ?? commandIdFor('relay.create', relayId, clientRequestId);
  const intent = {
    relayId,
    sessionId,
    clientRequestId,
    expectedRevision,
    continueCodeHash: codeHash,
    ...fields,
  };

  const expiry = requestedExpiry(request, options);
  if (!expiry.ok) return expiry;

  // beginCommand must run before replaying a terminal result: it freezes the
  // complete logical request and rejects a reused id with different content.
  // For a true retry, rebuild the original prepared response even after the
  // relay has since been accepted or expired; only the code digest is stored.
  const begun = beginCommand(db, {
    commandId,
    kind: 'relay.create',
    request: intent,
    runId: sessionId,
  });
  const replay = terminalResult(begun.command);
  if (replay) {
    const persisted = relayRow(db, relayId);
    if (replay.ok && replay.relayPrepared && persisted
      && sameRelayRequest(persisted, fields, expectedRevision)
      && codeMatches(persisted.code_hash, continueCode)) {
      return preparedReplayResponse(begun.command, continueCode)
        ?? preparedResponse(persisted, continueCode);
    }
    return replay;
  }

  const at = new Date(expiry.issuedAt).toISOString();
  const operation = () => {
    const command = readCommand(db, commandId);
    const commandReplay = terminalResult(command);
    if (commandReplay) {
      const persisted = relayRow(db, relayId);
      if (commandReplay.ok && commandReplay.relayPrepared && persisted
        && sameRelayRequest(persisted, fields, expectedRevision)
        && codeMatches(persisted.code_hash, continueCode)) {
        return preparedReplayResponse(command, continueCode)
          ?? preparedResponse(persisted, continueCode);
      }
      return commandReplay;
    }

    const existing = db.prepare(`
      SELECT * FROM relays
      WHERE session_id = ? AND client_request_id = ?
    `).get(sessionId, clientRequestId);
    if (existing) {
      if (!sameRelayRequest(existing, fields, expectedRevision)) {
        return failCommand(db, commandId, {
          ok: false,
          code: 'RELAY_REQUEST_CONFLICT',
          sessionId,
          clientRequestId,
        }, at);
      }
      if (!codeMatches(existing.code_hash, continueCode)) {
        return failCommand(db, commandId, {
          ok: false,
          code: 'RELAY_REQUEST_CONFLICT',
          sessionId,
          clientRequestId,
        }, at);
      }
      if (existing.state === 'active' && existing.expires_at <= expiry.issuedAt) {
        db.prepare(`
          UPDATE relays SET state = 'expired'
          WHERE id = ? AND state = 'active'
        `).run(existing.id);
        existing.state = 'expired';
      }
      if (existing.state !== 'active') {
        const safe = preparedResponse(existing);
        commitCommand(db, commandId, safe, at, sessionId);
        return {
          ...safe,
          continueCode,
          continueMessage: continueMessage(continueCode),
        };
      }
      const safe = preparedResponse(existing);
      commitCommand(db, commandId, safe, at, sessionId);
      return {
        ...safe,
        continueCode,
        continueMessage: continueMessage(continueCode),
      };
    }

    const live = liveSession(db, sessionId);
    if (!live.ok) return failCommand(db, commandId, live, at);
    if (
      live.assignmentId !== undefined
      && live.revision !== expectedRevision
      || (live.run && live.run.revision !== expectedRevision)
    ) {
      return failCommand(db, commandId, revisionConflict(live, sessionId), at);
    }

    // Expired relays are terminal history, not a live barrier.  Mark stale
    // rows before checking for another waiting relay so a fresh create can
    // proceed without requiring a separate cleanup job.
    db.prepare(`
      UPDATE relays SET state = 'expired'
      WHERE session_id = ? AND state = 'active' AND expires_at <= ?
    `).run(sessionId, expiry.issuedAt);

    const waiting = db.prepare(`
      SELECT id FROM relays
      WHERE session_id = ? AND state = 'active' AND expires_at > ?
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(sessionId, expiry.issuedAt);
    if (waiting) {
      return failCommand(db, commandId, {
        ok: false,
        code: 'RELAY_ALREADY_WAITING',
        relayId: waiting.id,
        sessionId,
      }, at);
    }

    const nextRevision = expectedRevision + 1;
    const runUpdated = db.prepare(`
      UPDATE runs
      SET revision = revision + 1, last_heartbeat_at = ?
      WHERE id = ? AND lifecycle = 'active' AND revision = ?
    `).run(at, sessionId, expectedRevision);
    if (runUpdated.changes !== 1) {
      return failCommand(db, commandId, revisionConflict(live, sessionId), at);
    }
    options.faultInjector?.('relay.after_run_cas');
    const assignmentUpdated = db.prepare(`
      UPDATE assignments
      SET status = 'active', revision = revision + 1, last_heartbeat_at = ?, updated_at = ?
      WHERE id = ? AND session_id = ? AND status IN ('accepted', 'active') AND revision = ?
    `).run(at, at, live.assignmentId, sessionId, expectedRevision);
    if (assignmentUpdated.changes !== 1) throw new Error('Assignment relay CAS failed.');
    options.faultInjector?.('relay.after_assignment_cas');

    const sequence = db.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
      FROM relays WHERE session_id = ?
    `).get(sessionId).next_sequence;
    db.prepare(`
      INSERT INTO relays (
        id, sequence, assignment_id, project_id, worktree_id,
        session_id, run_id, client_request_id, expected_revision, revision,
        next_session_focus, summary, current_state,
        completed_items, pending_items, decisions,
        artifact_refs, risks, suggested_skills,
        code_hash, state, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(
      relayId,
      sequence,
      live.assignmentId,
      live.projectId,
      live.worktreeId,
      sessionId,
      live.run?.id ?? null,
      clientRequestId,
      expectedRevision,
      nextRevision,
      fields.nextSessionFocus,
      fields.summary,
      fields.currentState,
      canonicalJson(fields.completedItems),
      canonicalJson(fields.pendingItems),
      canonicalJson(fields.decisions),
      canonicalJson(fields.artifactRefs),
      canonicalJson(fields.risks),
      canonicalJson(fields.suggestedSkills),
      codeHash,
      expiry.expiresAt,
      at,
    );
    options.faultInjector?.('relay.after_insert');
    const row = relayRow(db, relayId);
    // Never commit the one-time secret to commands.response_json.
    const safe = preparedResponse(row);
    commitCommand(db, commandId, safe, at, sessionId);
    options.faultInjector?.('relay.after_command_commit_before_transaction_commit');
    return {
      ...safe,
      continueCode,
      continueMessage: continueMessage(continueCode),
    };
  };

  return withImmediateTransaction(db, operation);
}

/**
 * Consume a relay code in the same bound project/worktree and advance the
 * same active session.  A successful code can be replayed only with the same
 * clientRequestId; a different request is rejected as a one-time-code replay.
 */
export function resumeRelay(db, request = {}, options = {}) {
  const continueCode = request.continueCode ?? request.code;
  const clientRequestId = request.clientRequestId ?? request.clientRequest;
  if (!isNonEmptyString(continueCode) || !isNonEmptyString(clientRequestId)) {
    return invalid('continueCode and clientRequestId are required.');
  }
  const codeHash = digest(continueCode);
  const located = relayRowByCodeHash(db, codeHash);
  if (!located) return { ok: false, code: 'RELAY_CODE_INVALID' };
  if (!codeMatches(located.code_hash, continueCode)) return { ok: false, code: 'RELAY_CODE_INVALID' };

  const commandId = request.commandId
    ?? commandIdFor('relay.resume', located.id, clientRequestId);
  const intent = {
    relayId: located.id,
    clientRequestId,
    continueCodeHash: codeHash,
    ...(request.projectId !== undefined ? { projectId: request.projectId } : {}),
    ...(request.worktreeId !== undefined ? { worktreeId: request.worktreeId } : {}),
  };
  const begun = beginCommand(db, {
    commandId,
    kind: 'relay.resume',
    request: intent,
    runId: located.session_id,
  });
  const replay = terminalResult(begun.command);
  if (replay) return replay;

  const at = timestamp(options);
  return withImmediateTransaction(db, () => {
    const command = readCommand(db, commandId);
    const commandReplay = terminalResult(command);
    if (commandReplay) return commandReplay;
    const row = relayRow(db, located.id);
    if (!row || !codeMatches(row.code_hash, continueCode)) {
      return failCommand(db, commandId, { ok: false, code: 'RELAY_CODE_INVALID' }, at);
    }

    if (row.state === 'expired') {
      return failCommand(db, commandId, {
        ok: false,
        code: 'RELAY_EXPIRED',
        relayId: row.id,
        sessionId: row.session_id,
      }, at);
    }
    if (row.expires_at <= nowMillis(options)) {
      db.prepare(`
        UPDATE relays SET state = 'expired'
        WHERE id = ? AND state = 'active'
      `).run(row.id);
      return failCommand(db, commandId, {
        ok: false,
        code: 'RELAY_EXPIRED',
        relayId: row.id,
        sessionId: row.session_id,
      }, at);
    }

    const live = liveSession(db, row.session_id);
    if (!live.ok) return failCommand(db, commandId, live, at);
    const bindingRow = {
      ...row,
      canonical_path: live.canonicalPath,
      repository_identity: live.repositoryIdentity,
      identity_fingerprint: live.worktreeIdentity,
    };
    if (!relayBindingMatches(request, bindingRow)) {
      return failCommand(db, commandId, {
        ok: false,
        code: 'RELAY_BINDING_MISMATCH',
        relayId: row.id,
        sessionId: row.session_id,
      }, at);
    }

    if (row.state === 'accepted') {
      if (row.accepted_client_request_id === clientRequestId) {
        const response = acceptedResponse(row, live, row.accepted_revision);
        return commitCommand(db, commandId, response, at, row.session_id);
      }
      return failCommand(db, commandId, {
        ok: false,
        code: 'RELAY_ALREADY_ACCEPTED',
        relayId: row.id,
        sessionId: row.session_id,
      }, at);
    }
    if (
      live.revision !== row.revision
      || (live.run && live.run.revision !== row.revision)
    ) {
      return failCommand(db, commandId, revisionConflict(live, row.session_id), at);
    }

    const nextRevision = row.revision + 1;
    const runUpdated = db.prepare(`
      UPDATE runs
      SET revision = revision + 1, last_heartbeat_at = ?
      WHERE id = ? AND lifecycle = 'active' AND revision = ?
    `).run(at, row.session_id, row.revision);
    if (runUpdated.changes !== 1) {
      return failCommand(db, commandId, revisionConflict(live, row.session_id), at);
    }
    options.faultInjector?.('resume.after_run_cas');
    const assignmentUpdated = db.prepare(`
      UPDATE assignments
      SET status = 'active', revision = revision + 1, last_heartbeat_at = ?, updated_at = ?
      WHERE id = ? AND session_id = ? AND status IN ('accepted', 'active') AND revision = ?
    `).run(at, at, row.assignment_id, row.session_id, row.revision);
    if (assignmentUpdated.changes !== 1) throw new Error('Assignment resume CAS failed.');
    options.faultInjector?.('resume.after_assignment_cas');

    const marked = db.prepare(`
      UPDATE relays
      SET state = 'accepted', accepted_at = ?,
          accepted_client_request_id = ?, accepted_revision = ?
      WHERE id = ? AND state = 'active' AND revision = ?
    `).run(at, clientRequestId, nextRevision, row.id, row.revision);
    if (marked.changes !== 1) throw new Error('Relay accept CAS failed.');
    options.faultInjector?.('resume.after_relay_cas');

    const accepted = relayRow(db, row.id);
    const context = readSessionContext(db, row.session_id);
    const response = acceptedResponse(
      accepted,
      context?.ok ? context : null,
      nextRevision,
    );
    const committed = commitCommand(db, commandId, response, at, row.session_id);
    options.faultInjector?.('resume.after_command_commit_before_transaction_commit');
    return committed;
  });
}

export function readRelay(db, relayId) {
  if (!isNonEmptyString(relayId)) return null;
  return mapRelay(relayRow(db, relayId));
}

export function readLatestActiveRelay(db, sessionId) {
  if (!isNonEmptyString(sessionId)) return null;
  return mapRelay(db.prepare(`
    SELECT * FROM relays
    WHERE session_id = ? AND state = 'active' AND expires_at > ?
    ORDER BY created_at DESC, sequence DESC, id DESC
    LIMIT 1
  `).get(sessionId, Date.now()) ?? null);
}

export function readLatestRelay(db, projectId) {
  if (!isNonEmptyString(projectId)) return null;
  return mapRelay(db.prepare(`
    SELECT * FROM relays
    WHERE project_id = ?
    ORDER BY created_at DESC, sequence DESC, id DESC
    LIMIT 1
  `).get(projectId) ?? null);
}

export function listRelays(db, { projectId, sessionId, state } = {}) {
  const predicates = [];
  const values = [];
  if (projectId !== undefined) {
    predicates.push('project_id = ?');
    values.push(projectId);
  }
  if (sessionId !== undefined) {
    predicates.push('session_id = ?');
    values.push(sessionId);
  }
  if (state !== undefined) {
    predicates.push(state === 'active' ? 'state = ? AND expires_at > ?' : 'state = ?');
    values.push(state);
    if (state === 'active') values.push(Date.now());
  }
  const where = predicates.length ? `WHERE ${predicates.join(' AND ')}` : '';
  return db.prepare(`
    SELECT * FROM relays ${where}
    ORDER BY created_at ASC, sequence ASC, id ASC
  `).all(...values).map(mapRelay);
}

export const prepareRelay = createRelay;
export const acceptRelay = resumeRelay;
