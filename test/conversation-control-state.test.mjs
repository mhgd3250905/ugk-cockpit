import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversationControlState } from '../web/src/conversation-control-state.mjs';

test('dialog unsubscribe and lane switch retain the original request and late receipt', async () => {
  const page = createConversationControlState();
  const session = page.session('first');
  const request = { action: 'transfer', body: { clientRequestId: 'original', expectedRevision: 7 } };
  session.pendingRequest.current = request;
  session.set('busy', true);
  let notifications = 0;
  const closeDialog = session.subscribe(() => notifications++);
  closeDialog();
  const otherLane = page.session('second');
  assert.equal(otherLane.pendingRequest.current, null);
  session.set('error', { code: 'SERVICE_UNAVAILABLE' });
  session.set('busy', false);
  assert.equal(notifications, 0);
  const reopened = page.session('first');
  assert.equal(reopened.pendingRequest.current, request);
  assert.equal(reopened.getSnapshot().error.code, 'SERVICE_UNAVAILABLE');
  // A retry finishes after the view has gone away again.
  const receipt = { transferCode: 'fixture-only', revision: 8 };
  await Promise.resolve().then(() => {
    reopened.set('issued', receipt);
    reopened.pendingRequest.current = null;
  });
  assert.equal(page.session('first').getSnapshot().issued, receipt);
  assert.equal(otherLane.getSnapshot().issued, null);
  assert.equal(createConversationControlState().session('first').getSnapshot().issued, null);
});
