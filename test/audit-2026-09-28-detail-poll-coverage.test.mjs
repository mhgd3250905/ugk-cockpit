// 第 30 轮审计（2026-09-28）：项目详情轮询在用户「加载更早记录」超过一页后，
// 不得再把整个响应连同状态一起永久丢弃。
// 旧逻辑：`limit = calculateRefreshLimit(已显示条数)` 封顶 100，而响应最多回 100 条；
// 一旦用户累计显示超过 100 条，`if (visibleCount > limit) return prev` 永远命中——
// 4 秒定时器照常发请求，但项目状态、进行中会话、工作说明计数从此不再更新。
// 修法按第一性原理：轮询页覆盖不了用户累积窗口时，历史窗口留给用户（不截断），
// 其余详情照常刷新——用纯函数 applyPolledProjectDetail 表达这个决定并可测。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { applyPolledProjectDetail } from '../web/src/project-detail-poll.mjs';

const mainSource = readFileSync(new URL('../web/src/main.jsx', import.meta.url), 'utf8');

function items(count, tag) {
  return Array.from({ length: count }, (_, index) => ({ id: `${tag}-${index}` }));
}

function detail(tag, count, status) {
  return {
    project: { id: 'p1', status, git: { head: 'h' } },
    timeline: { items: items(count, tag), total: count, hasMore: false },
  };
}

test('a poll page that cannot cover the accumulated window keeps the user list and refreshes the rest', () => {
  const previous = detail('prev', 120, 'ready');
  const polled = detail('polled', 100, 'attention');
  const merged = applyPolledProjectDetail(previous, polled);
  assert.equal(merged.timeline, previous.timeline, 'the accumulated timeline window must not be truncated');
  assert.equal(merged.project.status, 'attention', 'status must still update from the polled page');
});

test('a poll page that covers the window replaces the detail wholesale', () => {
  const previous = detail('prev', 30, 'ready');
  const polled = detail('polled', 30, 'active');
  assert.equal(applyPolledProjectDetail(previous, polled), polled);
});

test('the first detail load is passed through unchanged', () => {
  const polled = detail('polled', 30, 'ready');
  assert.equal(applyPolledProjectDetail(null, polled), polled);
  assert.equal(applyPolledProjectDetail({ timeline: null }, polled), polled);
});

test('a shrinking poll result never truncates the accumulated window (protection)', () => {
  const previous = detail('prev', 60, 'ready');
  const polled = detail('polled', 55, 'attention');
  const merged = applyPolledProjectDetail(previous, polled);
  assert.equal(merged.timeline, previous.timeline);
  assert.equal(merged.project.status, 'attention');
});

test('main.jsx uses the merge decision instead of the freeze branch', () => {
  assert.match(mainSource, /from '\.\/project-detail-poll\.mjs'/);
  assert.match(mainSource, /applyPolledProjectDetail\(/);
  assert.doesNotMatch(mainSource, /visibleCount > limit/,
    'the old guard discarded the whole poll response once more than 100 items were displayed');
});
