// 第 30 轮审计（2026-09-28）：处理工作说明后不得弹「空绿条」。
// onNoteStatusChange 的入参在 main.jsx 侧是详情动作回执（notice），消费端只读
// message/detail 并按 error 决定红绿；而说明视图把**业务 note 对象**原样递了过去
// （Promise.resolve(onNoteStatusChange(res.note))）——note 没有 error 字段，于是
// 弹出一条绿色、正文为空、6.5 秒后自己消失的条。同文件族其它调用方
// （main.jsx 的复制接入消息/空间操作）传的都是 { message, detail }。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { noteStatusNotice, buildNoteStatusRequest } from '../web/src/submit-notes-view.mjs';

const viewSource = readFileSync(new URL('../web/src/submit-notes-view.mjs', import.meta.url), 'utf8');

test('the notice carries product copy for each handled status', () => {
  const handled = noteStatusNotice({ note: { noteId: 'n1', status: 'handled', revision: 2 } });
  assert.equal(typeof handled.message, 'string');
  assert.ok(handled.message.length > 0, 'an empty toast body is what the defect shipped');
  assert.ok(!handled.error);
  const archived = noteStatusNotice({ note: { noteId: 'n2', status: 'archived', revision: 3 } });
  assert.ok(archived.message.length > 0);
  assert.notEqual(archived.message, handled.message, 'archive and handled must not claim the same thing');
});

test('a missing status still produces a readable notice (fail-soft on the copy surface)', () => {
  const fallback = noteStatusNotice({});
  assert.equal(typeof fallback.message, 'string');
  assert.ok(fallback.message.length > 0);
});

test('the view hands the notice builder to the host instead of the raw note', () => {
  assert.doesNotMatch(viewSource, /onNoteStatusChange\(res\.note\)/,
    'the raw business note object has no message/detail — it renders an empty success bar');
  assert.match(viewSource, /onNoteStatusChange\(noteStatusNotice\(res\)\)/);
});

test('buildNoteStatusRequest keeps the original payload contract (protection)', () => {
  const original = buildNoteStatusRequest({ revision: 2 }, 'handled', undefined);
  assert.equal(Object.hasOwn(original, 'handlingNote'), false);
  assert.equal(original.expectedRevision, 2);
});
