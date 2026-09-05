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
  };
}

export function bindConversation(db, key, binding, { transfer = false } = {}) {
  if (!key) return;
  const owner = db.prepare('SELECT conversation_key FROM conversation_bindings WHERE session_id = ? AND revoked = 0')
    .get(binding.sessionId);
  const previous = readConversationBinding(db, key, binding.worktreeId, binding.sessionId);
  if (!transfer && ((owner && owner.conversation_key !== key)
    || (previous?.revoked && previous.sessionId === binding.sessionId))) {
    throw Object.assign(new Error('此工作会话已有聊天归属，请通过 Relay 接手。'), { code: 'CONVERSATION_BINDING_CONFLICT' });
  }
  if (transfer) {
    db.prepare('UPDATE conversation_bindings SET revoked = 1 WHERE session_id = ? AND conversation_key <> ?')
      .run(binding.sessionId, key);
  }
  db.prepare(`INSERT INTO conversation_bindings
    (conversation_key, worktree_id, session_id, relay_id, relay_sequence, accepted_revision, revoked, bound_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)
    ON CONFLICT(conversation_key, worktree_id, session_id) DO UPDATE SET
      session_id = excluded.session_id, relay_id = excluded.relay_id,
      relay_sequence = excluded.relay_sequence, accepted_revision = excluded.accepted_revision,
      revoked = 0, bound_at = excluded.bound_at`)
    .run(key, binding.worktreeId, binding.sessionId, binding.relayId ?? null,
      binding.relaySequence ?? null, binding.acceptedRevision ?? null, new Date().toISOString());
}
