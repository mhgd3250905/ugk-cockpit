// The service database owns conversation bindings. A process is only a transport.
export function readConversationBinding(db, key, worktreeId, sessionId = null) {
  if (!key) return null;
  const row = db.prepare(`SELECT * FROM conversation_bindings WHERE conversation_key = ? AND worktree_id = ?
    AND (? IS NULL OR session_id = ?) ORDER BY bound_at DESC, rowid DESC LIMIT 1`)
    .get(key, worktreeId, sessionId, sessionId);
  if (!row) return null;
  return {
    sessionId: row.session_id, worktreeId: row.worktree_id,
    relayId: row.relay_id, relaySequence: row.relay_sequence,
    acceptedRevision: row.accepted_revision, revoked: row.revoked === 1,
    bindingKind: row.binding_kind ?? 'legacy',
    ownerHost: row.owner_host ?? null,
    ownerLocator: row.owner_locator ?? null,
    boundAt: row.bound_at,
  };
}

export function readConversationOwner(db, sessionId) {
  const row = db.prepare(`SELECT * FROM conversation_bindings
    WHERE session_id = ? AND revoked = 0 ORDER BY bound_at DESC, rowid DESC LIMIT 1`)
    .get(sessionId);
  if (!row) return null;
  return {
    conversationKey: row.conversation_key,
    sessionId: row.session_id,
    worktreeId: row.worktree_id,
    relayId: row.relay_id,
    relaySequence: row.relay_sequence,
    acceptedRevision: row.accepted_revision,
    bindingKind: row.binding_kind ?? 'legacy',
    ownerHost: row.owner_host ?? null,
    ownerLocator: row.owner_locator ?? null,
    boundAt: row.bound_at,
  };
}

// Relay receipts describe history; the unique unrevoked database owner grants
// current authority. Every authenticated read/write gate uses this same rule.
// Transfers revoke previous owners atomically in bindConversation.
export function readConversationAuthorization(db, key, state, allowedStatuses = ['active']) {
  const owner = state ? readConversationOwner(db, state.sessionId) : null;
  const binding = key && state
    ? readConversationBinding(db, key, state.worktreeId, state.sessionId) : null;
  let reason = null;
  if (!state) reason = 'session_missing';
  else if (!key) reason = 'metadata_missing';
  else if (!allowedStatuses.includes(state.status)) reason = 'session_not_active';
  else if (!binding) reason = owner && owner.conversationKey !== key ? 'held_elsewhere' : 'binding_missing';
  else if (binding.revoked) reason = owner && owner.conversationKey !== key ? 'replaced' : 'revoked';
  else if (owner?.conversationKey !== key) reason = 'held_elsewhere';
  else if (owner.worktreeId !== state.worktreeId || owner.sessionId !== state.sessionId) reason = 'binding_mismatch';
  return { authorized: reason === null, reason, binding, owner };
}

export function bindConversation(db, key, binding, {
  transfer = false,
  owner = null,
} = {}) {
  if (!key) return;
  const activeOwner = db.prepare('SELECT conversation_key FROM conversation_bindings WHERE session_id = ? AND revoked = 0')
    .get(binding.sessionId);
  const previous = readConversationBinding(db, key, binding.worktreeId, binding.sessionId);
  if (!transfer && ((activeOwner && activeOwner.conversation_key !== key)
    || (previous?.revoked && previous.sessionId === binding.sessionId))) {
    throw Object.assign(new Error('此工作会话已有聊天归属，请通过 Relay 接手。'), { code: 'CONVERSATION_BINDING_CONFLICT' });
  }
  if (transfer) {
    db.prepare('UPDATE conversation_bindings SET revoked = 1 WHERE session_id = ? AND conversation_key <> ?')
      .run(binding.sessionId, key);
  }
  db.prepare(`INSERT INTO conversation_bindings
    (conversation_key, worktree_id, session_id, relay_id, relay_sequence, accepted_revision,
     revoked, bound_at, binding_kind, owner_host, owner_locator)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
    ON CONFLICT(conversation_key, worktree_id, session_id) DO UPDATE SET
      session_id = excluded.session_id, relay_id = excluded.relay_id,
      relay_sequence = excluded.relay_sequence, accepted_revision = excluded.accepted_revision,
      revoked = 0, bound_at = excluded.bound_at,
      binding_kind = excluded.binding_kind, owner_host = excluded.owner_host,
      owner_locator = excluded.owner_locator`)
    .run(key, binding.worktreeId, binding.sessionId, binding.relayId ?? null,
      binding.relaySequence ?? null, binding.acceptedRevision ?? null, new Date().toISOString(),
      owner?.bindingKind ?? 'legacy', owner?.host ?? null, owner?.locator ?? null);
}
