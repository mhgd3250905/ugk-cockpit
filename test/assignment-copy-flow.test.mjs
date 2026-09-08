import assert from 'node:assert/strict';
import test from 'node:test';
import { completeAssignmentCopy } from '../web/src/assignment-copy-flow.mjs';

test('a successful copy and refresh shows the success message without error notice', async () => {
  const notices = [];
  let refreshArgs = null;
  const outcome = await completeAssignmentCopy({
    copyText: async () => true,
    refreshDetail: async (args) => { refreshArgs = args; },
    notify: (notice) => notices.push(notice),
  });
  assert.deepEqual(outcome, { copied: true, refreshed: true });
  assert.equal(refreshArgs.message, '开发空间接入消息已复制。');
  assert.equal(notices.length, 0);
});

test('a failed refresh keeps the generated-and-copied fact with a read-only retry', async () => {
  const notices = [];
  let refreshCalls = 0;
  let copyCalls = 0;
  const outcome = await completeAssignmentCopy({
    copyText: async () => { copyCalls += 1; return true; },
    refreshDetail: async () => {
      refreshCalls += 1;
      if (refreshCalls === 1) throw new Error('detail GET failed');
    },
    notify: (notice) => notices.push(notice),
  });
  assert.deepEqual(outcome, { copied: true, refreshed: false });
  assert.equal(notices.length, 1);
  const notice = notices[0];
  assert.match(notice.message, /已生成并复制/);
  assert.match(notice.required_action, /不会重新创建任务/);
  assert.equal(notice.actionLabel, '重试刷新');

  // The retry only re-runs the read-only refresh: no creation, no extra copy.
  notice.retry();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshCalls, 2);
  assert.equal(copyCalls, 1);
});

test('a retry of the failed refresh does not raise an unhandled rejection', async () => {
  const notices = [];
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    await completeAssignmentCopy({
      copyText: async () => true,
      refreshDetail: async () => { throw new Error('detail GET failed'); },
      notify: (notice) => notices.push(notice),
    });
    notices[0].retry();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(unhandled.length, 0, 'the refresh retry must swallow its own rejection');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('a failed copy reports the assignment as generated and retries only the copy', async () => {
  const notices = [];
  let copyCalls = 0;
  let refreshCalls = 0;
  const outcome = await completeAssignmentCopy({
    copyText: async () => { copyCalls += 1; return false; },
    refreshDetail: async () => { refreshCalls += 1; },
    notify: (notice) => notices.push(notice),
  });
  assert.deepEqual(outcome, { copied: false, refreshed: false });
  assert.equal(refreshCalls, 0, 'no refresh is attempted after a failed copy');
  assert.equal(notices.length, 1);
  assert.match(notices[0].message, /已生成/);
  assert.equal(notices[0].actionLabel, '重试复制');
  notices[0].retry();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(copyCalls, 2, 'the retry re-runs only the clipboard write');
});

test('a stale detail request skips the follow-ups entirely', async () => {
  const notices = [];
  let copyCalls = 0;
  const outcome = await completeAssignmentCopy({
    copyText: async () => { copyCalls += 1; return true; },
    refreshDetail: async () => { throw new Error('must not be called'); },
    notify: (notice) => notices.push(notice),
    isCurrent: () => false,
  });
  assert.deepEqual(outcome, { copied: true, refreshed: false });
  assert.equal(notices.length, 0);
});
