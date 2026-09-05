import assert from 'node:assert/strict';
import test from 'node:test';
import { copyNoteText } from '../web/src/copy-note-text.mjs';

test('copy preserves the complete instruction, including Unicode, links and line breaks', async () => {
  const text = '说明：修复复制\n\n处理指令\r\nhttps://example.test/review\n  保留原文 🚀';
  let written;
  assert.equal(await copyNoteText(text, {
    clipboard: { writeText: async (value) => { written = value; } },
  }), true);
  assert.equal(written, text);
});

test('copy reports success only after the clipboard write completes', async () => {
  let complete;
  let settled = false;
  const result = copyNoteText('完整说明', {
    clipboard: { writeText: () => new Promise((resolve) => { complete = resolve; }) },
  }).then((value) => { settled = true; return value; });
  await Promise.resolve();
  assert.equal(settled, false);
  complete();
  assert.equal(await result, true);
});

test('permission rejection and unavailable clipboard require manual copy without false success', async () => {
  for (const clipboard of [null, {}, { writeText: async () => { throw new DOMException('Denied', 'NotAllowedError'); } }]) {
    assert.equal(await copyNoteText('完整说明', { clipboard }), false);
  }
});

test('missing copy instruction does not overwrite the clipboard with an empty or partial body', async () => {
  let writes = 0;
  for (const value of [null, undefined, '', '  \n', {}]) {
    await assert.rejects(copyNoteText(value, { clipboard: { writeText: async () => { writes++; } } }), /缺少完整说明/);
  }
  assert.equal(writes, 0);
});
