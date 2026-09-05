import { createHash } from 'node:crypto';

// Identity comes from the host's request envelope, never model tool arguments
// or an inherited process environment (one process may serve several chats).
export function conversationIdentity(meta) {
  const explicit = meta?.['io.ugk.cockpit/conversation'];
  const value = explicit ?? (typeof meta?.threadId === 'string'
    ? { host: 'codex', id: meta.threadId } : null);
  if (!value) return null;
  if (typeof value.host !== 'string' || !/^[a-z0-9.-]{1,64}$/.test(value.host)
    || typeof value.id !== 'string' || !value.id.trim() || value.id.length > 256) {
    throw new Error('Invalid host conversation metadata.');
  }
  return { host: value.host, id: value.id };
}

export function conversationKey(identity) {
  return identity ? createHash('sha256').update(JSON.stringify([identity.host, identity.id])).digest('hex') : null;
}
