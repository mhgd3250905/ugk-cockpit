import { createHash } from 'node:crypto';
import {
  beginCommand,
  canonicalJson,
  parseCommandResponse,
  readCommand,
} from './command-journal.mjs';
import { withImmediateTransaction } from './database.mjs';
import { readSessionContext } from './assignments.mjs';

const TERMINAL_COMMAND_STATES = new Set(['committed', 'failed']);
const MAX_TEXT_LENGTH = 20_000;
const MAX_LIST_ITEMS = 100;
const MAX_ITEM_LENGTH = 4_000;
const SENSITIVE_KEY = /(?:token|secret|password|authorization|api[_-]?key|private[_-]?key)/i;
const SENSITIVE_VALUE = /(?:bearer\s+|(?:access[_ -]?)?token\s*[:=]|api[_ -]?key\s*[:=]|password\s*[:=]|secret\s*[:=])\S+/i;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function invalid(message) {
  return { ok: false, code: 'INVALID_REQUEST', message };
}

function nowMillis(options = {}) {
  const source = options.clock ?? options.now;
  const value = typeof source === 'function' ? source() : source;
  if (value === undefined) return Date.now();
  if (value instanceof Date) return value.getTime();
  const parsed = typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value)
    ? Date.parse(value)
    : Number(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function timestamp(options) {
  return new Date(nowMillis(options)).toISOString();
}

function commandIdFor(sessionId, clientRequestId) {
  return `handoff.create.${sessionId}.${clientRequestId}`;
}

function handoffIdFor(sessionId, clientRequestId) {
  return `handoff_${createHash('sha256')
    .update(`${sessionId}\0${clientRequestId}`)
    .digest('hex')
    .slice(0, 32)}`;
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

function commitCommand(db, commandId, response, at) {
  db.prepare(`
    UPDATE commands
    SET state = 'committed', response_json = ?, updated_at = ?
    WHERE id = ? AND state = 'received'
  `).run(canonicalJson(response), at, commandId);
  return response;
}

function inspectValue(value, key = '') {
  if (SENSITIVE_KEY.test(key)) return 'sensitive fields are not accepted in handoff data';
  if (typeof value === 'string') {
    if (value.length > MAX_ITEM_LENGTH) return 'handoff item is too long';
    if (SENSITIVE_VALUE.test(value)) return 'tokens and credentials are not accepted in handoff data';
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
  if (typeof text !== 'string' || text.length > MAX_TEXT_LENGTH || (required && !isNonEmptyString(text))) {
    throw new TypeError(`${name} must be a ${required ? 'non-empty ' : ''}string of at most ${MAX_TEXT_LENGTH} characters.`);
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
    if (typeof item !== 'string' && (!item || typeof item !== 'object' || Array.isArray(item))) {
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
    nextSessionFocus: normalizeText(fields.nextSessionFocus, 'nextSessionFocus'),
    summary: normalizeText(fields.summary, 'summary'),
    currentState: normalizeText(fields.currentState, 'currentState'),
    completedItems: normalizeList(fields.completedItems, 'completedItems'),
    pendingItems: normalizeList(fields.pendingItems, 'pendingItems'),
    decisions: normalizeList(fields.decisions, 'decisions'),
    artifactRefs: normalizeList(fields.artifactRefs, 'artifactRefs', { stringsOnly: true }),
    risks: normalizeList(fields.risks, 'risks'),
    suggestedSkills: normalizeList(fields.suggestedSkills, 'suggestedSkills'),
  };
}

function markdownText(value) {
  return String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('`', '\\`')
    .replaceAll('*', '\\*')
    .replaceAll('_', '\\_')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]')
    .replaceAll('#', '\\#')
    .replaceAll('|', '\\|')
    .replaceAll('\r', '')
    .replaceAll('\n', ' ');
}

function markdownValue(value) {
  return typeof value === 'string' ? markdownText(value) : markdownText(canonicalJson(value));
}

function markdownList(title, values) {
  const lines = [`## ${title}`];
  if (values.length === 0) return [...lines, '', '—'];
  return [...lines, '', ...values.map((value) => `- ${markdownValue(value)}`)];
}

/** Render only the canonical, whitelisted handoff fields. */
export function renderHandoffMarkdown(fields) {
  const lines = [
    '# Handoff',
    '',
    '## Next session focus',
    '',
    markdownText(fields.nextSessionFocus),
    '',
    '## Summary',
    '',
    markdownText(fields.summary),
    '',
    '## Current state',
    '',
    markdownText(fields.currentState),
    '',
    ...markdownList('Completed items', fields.completedItems),
    '',
    ...markdownList('Pending items', fields.pendingItems),
    '',
    ...markdownList('Decisions', fields.decisions),
    '',
    ...markdownList('Artifact references', fields.artifactRefs),
    '',
    ...markdownList('Risks', fields.risks),
    '',
    ...markdownList('Suggested skills', fields.suggestedSkills),
  ];
  return `${lines.join('\n')}\n`;
}

function parseJson(encoded, fallback) {
  try {
    return JSON.parse(encoded);
  } catch {
    return fallback;
  }
}

function mapHandoff(row) {
  if (!row) return null;
  return {
    ok: true,
    id: row.id,
    handoffId: row.id,
    sequence: row.sequence,
    sessionSequence: row.sequence,
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
    bodyMarkdown: row.body_markdown,
    createdAt: row.created_at,
  };
}

function readHandoffRow(db, id) {
  return db.prepare('SELECT * FROM handoffs WHERE id = ?').get(id) ?? null;
}

function sameHandoffRequest(row, fields, bodyMarkdown, expectedRevision) {
  return row.expected_revision === expectedRevision
    && row.next_session_focus === fields.nextSessionFocus
    && row.summary === fields.summary
    && row.current_state === fields.currentState
    && row.completed_items === canonicalJson(fields.completedItems)
    && row.pending_items === canonicalJson(fields.pendingItems)
    && row.decisions === canonicalJson(fields.decisions)
    && row.artifact_refs === canonicalJson(fields.artifactRefs)
    && row.risks === canonicalJson(fields.risks)
    && row.suggested_skills === canonicalJson(fields.suggestedSkills)
    && row.body_markdown === bodyMarkdown;
}

/**
 * Append one standard handoff manual.  This function only reads session/run
 * context and writes the new handoff row; finishing a Run or changing a lease
 * remains the HTTP adapter's responsibility.
 */
export function createHandoff(db, request = {}, options = {}) {
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
  const bodyMarkdown = renderHandoffMarkdown(fields);
  // Idempotency is checked before the live revision fence: a retry must
  // replay the already-persisted manual even if progress has advanced since
  // the first request.
  const existingRequest = db.prepare(`
    SELECT * FROM handoffs
    WHERE session_id = ? AND client_request_id = ?
  `).get(sessionId, clientRequestId);
  if (existingRequest) {
    return sameHandoffRequest(existingRequest, fields, bodyMarkdown, expectedRevision)
      ? mapHandoff(existingRequest)
      : {
        ok: false,
        code: 'HANDOFF_REQUEST_CONFLICT',
        sessionId,
        clientRequestId,
      };
  }
  const context = readSessionContext(db, sessionId);
  if (!context?.ok) return context ?? { ok: false, code: 'SESSION_NOT_FOUND', sessionId };
  if (context.status === 'pending') {
    return { ok: false, code: 'SESSION_NOT_ACCEPTED', sessionId, assignmentId: context.assignmentId };
  }
  if (context.revision !== expectedRevision
    || (context.run && context.run.revision !== expectedRevision)) {
    return {
      ok: false,
      code: 'HANDOFF_REVISION_CONFLICT',
      sessionId,
      assignmentId: context.assignmentId,
      revision: context.revision,
      runRevision: context.run?.revision ?? null,
    };
  }

  const handoffId = request.handoffId ?? request.id ?? handoffIdFor(sessionId, clientRequestId);
  const commandId = request.commandId ?? commandIdFor(sessionId, clientRequestId);
  const intent = {
    handoffId,
    sessionId,
    clientRequestId,
    assignmentId: context.assignmentId,
    projectId: context.projectId,
    worktreeId: context.worktreeId,
    runId: context.run?.id ?? null,
    expectedRevision,
    ...fields,
  };
  const begun = beginCommand(db, { commandId, kind: 'handoff.create', request: intent, runId: context.run?.id ?? null });
  const replay = terminalResult(begun.command);
  if (replay) return replay;

  const at = timestamp(options);
  return withImmediateTransaction(db, () => {
    const command = readCommand(db, commandId);
    const commandReplay = terminalResult(command);
    if (commandReplay) return commandReplay;

    const existing = db.prepare(`
      SELECT * FROM handoffs
      WHERE session_id = ? AND client_request_id = ?
    `).get(sessionId, clientRequestId);
    if (existing) {
      if (!sameHandoffRequest(existing, fields, bodyMarkdown, expectedRevision)) {
        return failCommand(db, commandId, {
          ok: false,
          code: 'HANDOFF_REQUEST_CONFLICT',
          sessionId,
          clientRequestId,
        }, at);
      }
      return mapHandoff(existing);
    }

    // Re-read the fenced session while holding the write transaction.  The
    // optimistic check above is only an early rejection; a progress request
    // may have advanced the assignment between that read and this insert.
    const liveContext = readSessionContext(db, sessionId);
    if (!liveContext?.ok) {
      return failCommand(db, commandId, liveContext ?? {
        ok: false,
        code: 'SESSION_NOT_FOUND',
        sessionId,
      }, at);
    }
    if (liveContext.status === 'pending') {
      return failCommand(db, commandId, {
        ok: false,
        code: 'SESSION_NOT_ACCEPTED',
        sessionId,
        assignmentId: liveContext.assignmentId,
      }, at);
    }
    if (liveContext.revision !== expectedRevision
      || (liveContext.run && liveContext.run.revision !== expectedRevision)) {
      return failCommand(db, commandId, {
        ok: false,
        code: 'HANDOFF_REVISION_CONFLICT',
        sessionId,
        assignmentId: liveContext.assignmentId,
        revision: liveContext.revision,
        runRevision: liveContext.run?.revision ?? null,
      }, at);
    }

    const sequence = db.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
      FROM handoffs WHERE session_id = ?
    `).get(sessionId).next_sequence;
    db.prepare(`
      INSERT INTO handoffs (
        id, sequence, assignment_id, project_id, worktree_id,
        session_id, run_id, client_request_id, expected_revision, revision,
        next_session_focus, summary, current_state,
        completed_items, pending_items, decisions,
        artifact_refs, risks, suggested_skills,
        body_markdown, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      handoffId,
      sequence,
      liveContext.assignmentId,
      liveContext.projectId,
      liveContext.worktreeId,
      sessionId,
      liveContext.run?.id ?? null,
      clientRequestId,
      expectedRevision,
      expectedRevision,
      fields.nextSessionFocus,
      fields.summary,
      fields.currentState,
      canonicalJson(fields.completedItems),
      canonicalJson(fields.pendingItems),
      canonicalJson(fields.decisions),
      canonicalJson(fields.artifactRefs),
      canonicalJson(fields.risks),
      canonicalJson(fields.suggestedSkills),
      bodyMarkdown,
      at,
    );
    const response = mapHandoff(readHandoffRow(db, handoffId));
    return commitCommand(db, commandId, response, at);
  });
}

export function readHandoff(db, id) {
  if (!isNonEmptyString(id)) return null;
  return mapHandoff(readHandoffRow(db, id));
}

export function readLatestHandoff(db, projectId) {
  if (!isNonEmptyString(projectId)) return null;
  const row = db.prepare(`
    SELECT * FROM handoffs
    WHERE project_id = ?
    ORDER BY created_at DESC, sequence DESC, id DESC
    LIMIT 1
  `).get(projectId) ?? null;
  return mapHandoff(row);
}
