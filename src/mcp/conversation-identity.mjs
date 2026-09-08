import { createHash } from 'node:crypto';

// Identity comes from the host's request envelope, never model tool arguments
// or an inherited process environment (one process may serve several chats).
export function conversationIdentity(meta) {
  const explicit = meta?.['io.ugk.cockpit/conversation'];
  const candidates = [];
  if (explicit != null) candidates.push(explicit);
  if (meta?.threadId !== undefined) candidates.push({ host: 'codex', id: meta.threadId });
  // ZCode emits both its namespaced request context and mirrored top-level
  // fields. A bare session_id is not enough to identify the host.
  if (meta && Object.hasOwn(meta, 'com.zcode/request-context')) {
    const context = meta['com.zcode/request-context'];
    if (!context || typeof context !== 'object' || Array.isArray(context)) {
      throw new Error('Invalid host conversation metadata.');
    }
    if (Object.hasOwn(context, 'session_id')) candidates.push({ host: 'zcode', id: context.session_id });
    if (Object.hasOwn(meta, 'session_id')) candidates.push({ host: 'zcode', id: meta.session_id });
    if (!Object.hasOwn(context, 'session_id') && !Object.hasOwn(meta, 'session_id')) {
      throw new Error('Invalid host conversation metadata.');
    }
  }
  if (!candidates.length) return null;
  for (const candidate of candidates) {
    if (!candidate || typeof candidate.host !== 'string' || !/^[a-z0-9.-]{1,64}$/.test(candidate.host)
      || typeof candidate.id !== 'string' || !candidate.id.trim() || candidate.id.length > 256) {
      throw new Error('Invalid host conversation metadata.');
    }
  }
  const value = candidates[0];
  if (candidates.some(candidate => candidate.host !== value.host || candidate.id !== value.id)) {
    throw new Error('Conflicting host conversation metadata.');
  }
  return { host: value.host, id: value.id };
}

export function conversationKey(identity) {
  return identity ? createHash('sha256').update(JSON.stringify([identity.host, identity.id])).digest('hex') : null;
}
