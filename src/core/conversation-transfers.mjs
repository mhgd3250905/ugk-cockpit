import { createHash, createHmac, randomUUID } from 'node:crypto';
import { beginCommand, canonicalJson, parseCommandResponse } from './command-journal.mjs';
import { withImmediateTransaction } from './database.mjs';
import { readSessionContext } from './assignments.mjs';
import { bindConversation, readConversationOwner } from './conversation-bindings.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const text = (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 1024;
const codeFor = (id, key) => createHmac('sha256', key).update(`cockpit-conversation-transfer-v1\0${id}`).digest('base64url');
const failure = (code) => ({ ok: false, code });

export function readTransferState(db, sessionId, options = {}) {
  const row = db.prepare("SELECT * FROM conversation_transfers WHERE session_id = ? AND state = 'pending'").get(sessionId);
  if (!row) return null;
  return { transferId: row.id, sessionId, worktreeId: row.worktree_id, status: 'pending', frozen: true,
    expired: row.expires_at <= (options.now ?? Date.now()), expiresAt: row.expires_at,
    revision: row.issued_revision, targetHost: row.target_host, targetConversationId: row.target_conversation_id };
}

function live(db, sessionId, revision) {
  const context = readSessionContext(db, sessionId);
  if (!context.ok) return context;
  if (context.status !== 'active' || context.run?.lifecycle !== 'active') return failure('SESSION_NOT_ACTIVE');
  if (context.revision !== revision || context.run.revision !== revision) {
    return { ...failure('CONVERSATION_TRANSFER_STALE'), sessionId, revision: context.revision };
  }
  const lease = db.prepare('SELECT * FROM write_leases WHERE worktree_id = ?').get(context.worktreeId);
  if (!lease || lease.run_id !== sessionId || lease.generation !== context.run.leaseGeneration) return failure('LEASE_NOT_HELD');
  return context;
}

function advance(db, context, commandId, kind, at, actor, options) {
  const revision = context.revision + 1;
  if (db.prepare("UPDATE runs SET revision = ?, last_heartbeat_at = ? WHERE id = ? AND revision = ? AND lifecycle = 'active'")
    .run(revision, at, context.sessionId, context.revision).changes !== 1) throw new Error('Transfer run CAS failed');
  options.faultInjector?.('transfer.after_run_cas');
  if (db.prepare('UPDATE assignments SET revision = ?, updated_at = ?, last_heartbeat_at = ? WHERE session_id = ? AND revision = ?')
    .run(revision, at, at, context.sessionId, context.revision).changes !== 1) throw new Error('Transfer assignment CAS failed');
  const summary = { issue: '用户在工作台授权转交，等待新的聊天接手。', consume: '新的聊天已通过工作台授权接手。', cancel: '用户取消转交并恢复此前聊天继续。' }[kind];
  db.prepare(`INSERT INTO progress_events (id, assignment_id, session_id, client_request_id,
    expected_revision, revision, status, summary, details_json, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'working', ?, ?, ?, ?)`)
    .run(`progress_${hash(commandId)}`, context.assignmentId, context.sessionId, commandId,
      context.revision, revision, summary, canonicalJson([{ nodeType: `conversation.transfer.${kind}`, actor }]), summary, at);
  options.faultInjector?.('transfer.after_event_insert');
  return revision;
}

function execute(db, kind, request, options, operation) {
  if (!text(request.sessionId) || !text(request.clientRequestId)) return failure('INVALID_REQUEST');
  const commandId = `conversation.transfer.${kind}.${request.sessionId}.${request.clientRequestId}`;
  const intent = { ...request };
  if (intent.transferCode) { intent.codeHash = hash(intent.transferCode); delete intent.transferCode; }
  return withImmediateTransaction(db, () => {
    const { command } = beginCommand(db, { commandId, kind: `conversation.transfer.${kind}`, request: intent, inTransaction: true });
    if (command.state === 'committed' || command.state === 'failed') return parseCommandResponse(command);
    const at = new Date(options.now ?? Date.now()).toISOString();
    const response = operation({ commandId, at });
    db.prepare('UPDATE commands SET state = ?, response_json = ?, run_id = ?, updated_at = ? WHERE id = ?')
      .run(response.ok ? 'committed' : 'failed', canonicalJson(response), request.sessionId, at, commandId);
    options.faultInjector?.('transfer.before_commit');
    return response;
  });
}

export function issueConversationTransfer(db, request = {}, options = {}) {
  if (!Number.isInteger(request.expectedRevision) || !text(options.authorizationKey)
    || ((request.targetHost != null || request.targetConversationId != null)
      && (!text(request.targetHost) || !text(request.targetConversationId)))) return failure('INVALID_REQUEST');
  const response = execute(db, 'issue', request, options, ({ commandId, at }) => {
    const context = live(db, request.sessionId, request.expectedRevision);
    if (!context.ok) return context;
    const owner = readConversationOwner(db, request.sessionId);
    if (!owner) return failure('CONVERSATION_BINDING_MISSING');
    // User authorization supersedes a waiting Relay without deleting history.
    // The revision advance below also prevents the old expired-code confirmation
    // path from ever reviving it, including after cancellation of this transfer.
    db.prepare("UPDATE relays SET state = 'expired' WHERE session_id = ? AND state = 'active'").run(request.sessionId);
    // Reissuing explicitly replaces a pending (including expired) authorization.
    db.prepare("UPDATE conversation_transfers SET state = 'superseded', resolved_at = ? WHERE session_id = ? AND state = 'pending'").run(at, request.sessionId);
    const transferId = `transfer_${randomUUID()}`;
    const expiresAt = Date.parse(at) + 10 * 60 * 1000;
    const revision = advance(db, context, commandId, 'issue', at, { type: 'user' }, options);
    db.prepare(`INSERT INTO conversation_transfers (id, session_id, worktree_id, state, code_hash,
      issued_revision, previous_owner_key, target_host, target_conversation_id, expires_at, created_at)
      VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`)
      .run(transferId, request.sessionId, context.worktreeId, hash(codeFor(transferId, options.authorizationKey)), revision,
        owner.conversationKey, request.targetHost ?? null, request.targetConversationId ?? null, expiresAt, at);
    return { ok: true, status: 'pending', transferId, sessionId: request.sessionId, worktreeId: context.worktreeId, revision, expiresAt };
  });
  // Do not store bearer secrets in the journal. A persistent service key restores
  // the exact same code on a lost-response replay, including after process restart.
  if (!response.ok) return response;
  const current = db.prepare('SELECT state, expires_at FROM conversation_transfers WHERE id = ?').get(response.transferId);
  const currentStatus = current?.state === 'pending' && current.expires_at <= (options.now ?? Date.now())
    ? 'expired' : current?.state ?? 'unavailable';
  return { ...response, currentStatus,
    ...(currentStatus === 'pending' ? { transferCode: codeFor(response.transferId, options.authorizationKey) } : {}) };
}

export function consumeConversationTransfer(db, request = {}, options = {}) {
  if (!text(request.transferCode) || !text(request.conversationKey) || request.binding?.bindingKind !== 'host'
    || !text(request.binding.host) || !text(request.binding.locator)) return failure('CONVERSATION_IDENTITY_REQUIRED');
  return execute(db, 'consume', request, options, ({ commandId, at }) => {
    const row = db.prepare('SELECT * FROM conversation_transfers WHERE session_id = ? AND code_hash = ?').get(request.sessionId, hash(request.transferCode));
    if (!row || row.state !== 'pending') return failure('CONVERSATION_TRANSFER_INVALID');
    if (row.expires_at <= Date.parse(at)) return failure('CONVERSATION_TRANSFER_EXPIRED');
    if (row.target_host && (row.target_host !== request.binding.host || row.target_conversation_id !== request.binding.locator)) return failure('CONVERSATION_TRANSFER_TARGET_MISMATCH');
    const context = live(db, request.sessionId, row.issued_revision);
    if (!context.ok) return context;
    if (readConversationOwner(db, request.sessionId)?.conversationKey !== row.previous_owner_key) return failure('CONVERSATION_TRANSFER_STALE');
    const revision = advance(db, context, commandId, 'consume', at,
      { type: 'ai', platform: request.binding.host, conversationId: request.binding.locator }, options);
    const binding = { sessionId: request.sessionId, worktreeId: context.worktreeId, relayId: null, relaySequence: null, acceptedRevision: revision };
    bindConversation(db, request.conversationKey, binding, { transfer: true, owner: request.binding });
    db.prepare("UPDATE conversation_transfers SET state = 'consumed', consumed_by = ?, resolved_at = ? WHERE id = ?").run(request.conversationKey, at, row.id);
    options.faultInjector?.('transfer.after_binding_transfer');
    return { ok: true, takeoverAccepted: true, status: 'active', transferId: row.id, sessionId: request.sessionId,
      assignmentId: context.assignmentId, worktreeId: context.worktreeId, expectedRevision: context.revision, revision, binding };
  });
}

export function cancelConversationTransfer(db, request = {}, options = {}) {
  if (!Number.isInteger(request.expectedRevision) || request.restorePreviousOwner !== true) return failure('INVALID_REQUEST');
  return execute(db, 'cancel', request, options, ({ commandId, at }) => {
    const row = db.prepare("SELECT * FROM conversation_transfers WHERE session_id = ? AND state = 'pending'").get(request.sessionId);
    if (!row) return failure('CONVERSATION_TRANSFER_INVALID');
    const context = live(db, request.sessionId, request.expectedRevision);
    if (!context.ok) return context;
    if (row.issued_revision !== context.revision || readConversationOwner(db, request.sessionId)?.conversationKey !== row.previous_owner_key) return failure('CONVERSATION_TRANSFER_STALE');
    const revision = advance(db, context, commandId, 'cancel', at, { type: 'user' }, options);
    db.prepare("UPDATE conversation_transfers SET state = 'cancelled', resolved_at = ? WHERE id = ?").run(at, row.id);
    return { ok: true, status: 'cancelled', sessionId: request.sessionId, transferId: row.id, revision, restoredPreviousOwner: true };
  });
}
