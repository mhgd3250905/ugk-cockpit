// Owned by the project page, never browser storage. Dialog subscribers may
// disappear while a request is in flight; its result still belongs to the page.
export function createConversationControlState() {
  const sessions = new Map();
  return {
    session(sessionId) {
      if (!sessions.has(sessionId)) {
        let snapshot = { busy: false, error: null, issued: null, requestNotice: '' };
        const listeners = new Set();
        sessions.set(sessionId, {
          pendingRequest: { current: null },
          getSnapshot: () => snapshot,
          subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          set(field, value) {
            if (Object.is(snapshot[field], value)) return;
            snapshot = { ...snapshot, [field]: value };
            for (const listener of listeners) listener();
          },
        });
      }
      return sessions.get(sessionId);
    },
  };
}
