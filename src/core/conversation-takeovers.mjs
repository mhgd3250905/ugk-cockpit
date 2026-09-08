import { createHash } from 'node:crypto';
import {
  beginCommand,
  canonicalJson,
  parseCommandResponse,
  readCommand,
} from './command-journal.mjs';
import { withImmediateTransaction } from './database.mjs';
import { readSessionContext } from './assignments.mjs';
import { bindConversation, readConversationOwner } from './conversation-bindings.mjs';

const TERMINAL_COMMAND_STATES = new Set(['committed', 'failed']);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function commandIdFor(sessionId, clientRequestId) {
  return `conversation.takeover.${sessionId}.${clientRequestId}`;
}

function terminalResult(command) {
  return command && TERMINAL_COMMAND_STATES.has(command.state)
    ? parseCommandResponse(command)
    : null;
}

function failCommand(db, commandId, response, at) {
  db.prepare(`UPDATE commands
    SET state = 'failed', response_json = ?, updated_at = ?
    WHERE id = ? AND state = 'received'`)
    .run(canonicalJson(response), at, commandId);
  return response;
}

function commitCommand(db, commandId, response, at, sessionId) {
  db.prepare(`UPDATE commands
    SET state = 'committed', response_json = ?, run_id = ?, updated_at = ?
    WHERE id = ? AND state = 'received'`)
    .run(canonicalJson(response), sessionId, at, commandId);
  return response;
}

function takeoverEventId(sessionId, clientRequestId) {
  return `progress_${createHash('sha256')
    .update(`conversation-takeover\0${sessionId}\0${clientRequestId}`)
    .digest('hex')}`;
}

function validRequest(request) {
  return isNonEmptyString(request.sessionId)
    && isNonEmptyString(request.clientRequestId)
    && isNonEmptyString(request.conversationKey)
    && request.binding
    && ['host', 'connection'].includes(request.binding.bindingKind)
    && Number.isInteger(request.expectedRevision)
    && request.expectedRevision > 0;
}

function liveSession(db, sessionId, expectedRevision, now) {
  const context = readSessionContext(db, sessionId);
  if (!context.ok) return context;
  if (context.status !== 'active' || context.run?.lifecycle !== 'active') {
    return { ok: false, code: 'SESSION_NOT_ACTIVE', sessionId };
  }
  if (context.revision !== expectedRevision || context.run.revision !== expectedRevision) {
    return { ok: false, code: 'CONVERSATION_TAKEOVER_STALE', sessionId, revision: context.revision };
  }
  const waitingRelay = db.prepare(`SELECT id FROM relays
    WHERE session_id = ? AND state = 'active' AND expires_at > ?
    ORDER BY sequence DESC LIMIT 1`).get(sessionId, Date.parse(now));
  if (waitingRelay) {
    return { ok: false, code: 'RELAY_ALREADY_WAITING', sessionId, relayId: waitingRelay.id };
  }
  return { ok: true, context };
}

/**
 * Explicitly transfer an active session from an unavailable conversation to
 * the current one. The first call only produces a durable confirmation offer;
 * the second call must echo that offer after the user has confirmed.
 */
export function takeOverConversation(db, request = {}, options = {}) {
  if (!validRequest(request)) return { ok: false, code: 'INVALID_REQUEST' };
  const confirming = request.confirmationRequestId !== undefined;
  if (confirming && (!isNonEmptyString(request.confirmationRequestId)
    || request.confirmationRequestId === request.clientRequestId)) {
    return { ok: false, code: 'INVALID_REQUEST' };
  }

  const at = new Date(options.now ?? Date.now()).toISOString();
  const commandId = commandIdFor(request.sessionId, request.clientRequestId);
  const intent = {
    sessionId: request.sessionId,
    clientRequestId: request.clientRequestId,
    expectedRevision: request.expectedRevision,
    conversationKey: request.conversationKey,
    bindingKind: request.binding.bindingKind,
    ownerHost: request.binding.host ?? null,
    ownerLocator: request.binding.locator ?? null,
    ...(confirming ? { confirmationRequestId: request.confirmationRequestId } : {}),
  };
  const begun = beginCommand(db, {
    commandId,
    kind: 'conversation.takeover',
    request: intent,
    runId: request.sessionId,
  });
  const replay = terminalResult(begun.command);
  if (replay) return replay;

  return withImmediateTransaction(db, () => {
    const command = readCommand(db, commandId);
    const commandReplay = terminalResult(command);
    if (commandReplay) return commandReplay;

    const live = liveSession(db, request.sessionId, request.expectedRevision, at);
    if (!live.ok) return failCommand(db, commandId, live, at);

    const owner = readConversationOwner(db, request.sessionId);
    if (!owner) {
      return failCommand(db, commandId, {
        ok: false,
        code: 'CONVERSATION_TAKEOVER_NOT_REQUIRED',
        sessionId: request.sessionId,
        revision: live.context.revision,
      }, at);
    }
    if (owner.conversationKey === request.conversationKey) {
      return failCommand(db, commandId, {
        ok: false,
        code: 'CONVERSATION_TAKEOVER_NOT_REQUIRED',
        sessionId: request.sessionId,
        revision: live.context.revision,
      }, at);
    }

    if (!confirming) {
      return commitCommand(db, commandId, {
        ok: true,
        takeoverAccepted: false,
        status: 'confirmation_required',
        requiresUserConfirmation: true,
        confirmationRequestId: request.clientRequestId,
        expectedRevision: live.context.revision,
        sessionId: request.sessionId,
        message: '这个项目仍由另一条 AI 工作会话持有。是否确认在当前聊天接手？原聊天之后的写入会被拒绝，代码不会被清理或覆盖。',
      }, at, request.sessionId);
    }

    const offer = readCommand(db, commandIdFor(request.sessionId, request.confirmationRequestId));
    const offered = offer?.state === 'committed' ? parseCommandResponse(offer) : null;
    const offerIntent = offer ? JSON.parse(offer.request_json) : null;
    if (!offered?.requiresUserConfirmation
      || offerIntent?.conversationKey !== request.conversationKey
      || offered.expectedRevision !== request.expectedRevision
      || offerIntent?.expectedRevision !== request.expectedRevision) {
      return failCommand(db, commandId, {
        ok: false,
        code: 'CONVERSATION_TAKEOVER_STALE',
        sessionId: request.sessionId,
        revision: live.context.revision,
      }, at);
    }

    const updatedRun = db.prepare(`UPDATE runs
      SET revision = revision + 1, last_heartbeat_at = ?
      WHERE id = ? AND lifecycle = 'active' AND revision = ?`)
      .run(at, request.sessionId, request.expectedRevision);
    if (updatedRun.changes !== 1) throw new Error('Conversation takeover run CAS failed.');
    options.faultInjector?.('takeover.after_run_cas');
    const updatedAssignment = db.prepare(`UPDATE assignments
      SET status = 'active', revision = revision + 1, last_heartbeat_at = ?, updated_at = ?
      WHERE id = ? AND session_id = ? AND revision = ?`)
      .run(at, at, live.context.assignmentId, request.sessionId, request.expectedRevision);
    if (updatedAssignment.changes !== 1) throw new Error('Conversation takeover assignment CAS failed.');
    options.faultInjector?.('takeover.after_assignment_cas');

    const nextRevision = request.expectedRevision + 1;
    db.prepare(`INSERT INTO progress_events (
      id, assignment_id, session_id, client_request_id, expected_revision, revision,
      status, summary, details_json, note, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'working', ?, ?, ?, ?)`)
      .run(
        takeoverEventId(request.sessionId, request.clientRequestId),
        live.context.assignmentId,
        request.sessionId,
        request.clientRequestId,
        request.expectedRevision,
        nextRevision,
        '用户确认：由新的 AI 聊天接手当前工作会话。',
        JSON.stringify(['原聊天的后续写入将被拒绝；代码和已有本地改动保持不变。']),
        '用户确认：由新的 AI 聊天接手当前工作会话。',
        at,
      );
    options.faultInjector?.('takeover.after_event_insert');
    bindConversation(db, request.conversationKey, {
      sessionId: request.sessionId,
      worktreeId: live.context.worktreeId,
      relayId: null,
      relaySequence: null,
      acceptedRevision: nextRevision,
    }, { transfer: true, owner: request.binding });
    options.faultInjector?.('takeover.after_binding_transfer');

    const committed = commitCommand(db, commandId, {
      ok: true,
      takeoverAccepted: true,
      status: 'active',
      sessionId: request.sessionId,
      assignmentId: live.context.assignmentId,
      worktreeId: live.context.worktreeId,
      expectedRevision: request.expectedRevision,
      revision: nextRevision,
      binding: {
        sessionId: request.sessionId,
        worktreeId: live.context.worktreeId,
        relayId: null,
        relaySequence: null,
        acceptedRevision: nextRevision,
      },
      message: '已按你的确认把当前工作会话交给这个聊天继续；原聊天的后续写入会被拒绝。',
    }, at, request.sessionId);
    options.faultInjector?.('takeover.after_command_commit_before_transaction_commit');
    return committed;
  });
}
