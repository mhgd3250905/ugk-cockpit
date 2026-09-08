import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationIdentity, conversationKey } from '../src/mcp/conversation-identity.mjs';

const namespace = 'com.zcode/request-context';
const custom = 'io.ugk.cockpit/conversation';
const envelope = id => ({ session_id: id, [namespace]: { session_id: id, runtime_scope: 'main', turn_id: 'turn-1' } });

test('ZCode native request metadata resolves the stable session independently of tracing fields', () => {
  assert.deepEqual(conversationIdentity(envelope('sess-a')), { host: 'zcode', id: 'sess-a' });
  assert.equal(conversationKey(conversationIdentity(envelope('sess-a'))),
    conversationKey(conversationIdentity({ [namespace]: { session_id: 'sess-a', turn_id: 'turn-2', runtime_scope: 'branch' } })));
  assert.deepEqual(conversationIdentity({ [namespace]: {}, session_id: 'sess-a' }), { host: 'zcode', id: 'sess-a' });
});

test('generic session_id without a ZCode namespace never claims ZCode identity', () => {
  assert.equal(conversationIdentity({ session_id: 'sess-a' }), null);
  assert.deepEqual(conversationIdentity({ threadId: 'codex-a', session_id: 'unrelated' }), { host: 'codex', id: 'codex-a' });
});

test('Codex and explicit host metadata remain compatible and same-source duplicates agree', () => {
  assert.deepEqual(conversationIdentity({ threadId: 'codex-a' }), { host: 'codex', id: 'codex-a' });
  assert.deepEqual(conversationIdentity({ [custom]: { host: 'other', id: 'a' } }), { host: 'other', id: 'a' });
  assert.deepEqual(conversationIdentity({ ...envelope('sess-a'), [custom]: { host: 'zcode', id: 'sess-a' } }), { host: 'zcode', id: 'sess-a' });
  assert.deepEqual(conversationIdentity({ threadId: 'codex-a', [custom]: { host: 'codex', id: 'codex-a' } }), { host: 'codex', id: 'codex-a' });
});

test('conflicting identities are rejected rather than selected by precedence', () => {
  for (const meta of [
    { ...envelope('sess-a'), session_id: 'sess-b' },
    { ...envelope('sess-a'), [custom]: { host: 'zcode', id: 'sess-b' } },
    { ...envelope('sess-a'), threadId: 'sess-a' },
    { threadId: 'a', [custom]: { host: 'codex', id: 'b' } },
  ]) assert.throws(() => conversationIdentity(meta), /Conflicting host conversation metadata/);
});

test('malformed recognized identity metadata fails closed', () => {
  for (const meta of [
    { [namespace]: null }, { [namespace]: [] }, { [namespace]: 'sess-a' }, { [namespace]: {} },
    { [namespace]: { session_id: '' } }, { [namespace]: { session_id: ' ' } },
    { [namespace]: { session_id: 1 } }, { [namespace]: { session_id: 'x'.repeat(257) } },
    { ...envelope('sess-a'), session_id: null }, { threadId: 1 },
  ]) assert.throws(() => conversationIdentity(meta), /Invalid host conversation metadata/);
});

test('interleaved requests never inherit another request identity', async () => {
  const inputs = [envelope('sess-a'), undefined, envelope('sess-b'), {}, envelope('sess-a'), { session_id: 'sess-b' }];
  const results = await Promise.all(inputs.map(async meta => {
    await Promise.resolve();
    return conversationIdentity(meta);
  }));
  assert.deepEqual(results, [{ host: 'zcode', id: 'sess-a' }, null, { host: 'zcode', id: 'sess-b' }, null, { host: 'zcode', id: 'sess-a' }, null]);
});
