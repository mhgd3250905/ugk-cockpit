// 第 30 轮审计（2026-09-28）：文件夹项目（或观察未取到基线的 Git 项目）点
// 「新建开发空间」不再静默无反应。
// 旧入口首行 `if (!projectId || !project?.git?.head || !isCurrentDetailRequest(...)) return;`
// 在 setBusy 之前直接返回：无 spinner、无提示、无请求——与按钮坏了不可区分，
// 违反 AGENTS.md「每个异常必须回答发生了什么/代码是否受影响/下一步」。
// 后端本来也必填 expectedBaseHead（缺了 INVALID_REQUEST），所以缺基线时确实无法继续，
// 但用户必须被告知原因和出路。判定收进纯函数 describeSpaceCreateBlock。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { describeSpaceCreateBlock } from '../web/src/space-create-notice.mjs';

const mainSource = readFileSync(new URL('../web/src/main.jsx', import.meta.url), 'utf8');

test('a Git project with a fresh baseline is not blocked', () => {
  assert.equal(describeSpaceCreateBlock({ id: 'p1', git: { available: true, head: 'a'.repeat(40) } }), null);
});

test('a folder project gets an explicit reason instead of silence', () => {
  const blocked = describeSpaceCreateBlock({ id: 'p1', git: { available: false, head: null } });
  assert.ok(blocked, 'folder projects must answer why the button cannot proceed');
  assert.ok(blocked.message.length > 0);
  assert.match(blocked.detail, /不是 Git 仓库|文件夹/);
  assert.ok(!blocked.error, 'nothing failed; this is a gate explanation');
});

test('a Git project whose observation has no baseline explains refresh as the next step', () => {
  const blocked = describeSpaceCreateBlock({ id: 'p1', git: { available: true, head: null } });
  assert.ok(blocked);
  assert.match(blocked.detail, /刷新|观察/);
});

test('a project view without git info at all still answers', () => {
  const blocked = describeSpaceCreateBlock({ id: 'p1' });
  assert.ok(blocked);
  assert.ok(blocked.message.length > 0);
});

test('the detail entry points the block notice instead of the silent return', () => {
  assert.match(mainSource, /from '\.\/space-create-notice\.mjs'/);
  assert.match(mainSource, /describeSpaceCreateBlock\(/);
  assert.doesNotMatch(mainSource, /if \(!projectId \|\| !project\?\.git\?\.head \|\| !isCurrentDetailRequest/,
    'the old silent-return condition combined the missing baseline with the staleness check');
});
