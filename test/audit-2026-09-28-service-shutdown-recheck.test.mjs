// 第 30 轮审计（2026-09-28）：请求关闭之后必须继续复查，不能把「已请求」当结果。
// 旧实现里 `if (!api || requested) return` 让状态轮询在用户确认关闭的那一刻
// 永久停止：横幅停在「已请求关闭服务」、按钮消失，而服务真实可能停在在飞请求上
// 继续应答（后端 /api/v1/service/status 明确提供 running|stopping 就是为了复查），
// 同时侧栏仪表盘轮询还在成功——两条自相矛盾的状态同时在场。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { describeServiceBanner } from '../web/src/service-status-state.mjs';

const jsxSource = readFileSync(new URL('../web/src/service-status.jsx', import.meta.url), 'utf8');

test('before a request the banner keeps its three connection states', () => {
  assert.equal(describeServiceBanner({ requested: false, offline: true, status: 'running' }).text, '服务未连接');
  assert.equal(describeServiceBanner({ requested: false, offline: false, status: null }).text, '正在连接服务');
  assert.equal(describeServiceBanner({ requested: false, offline: false, status: 'running' }).text, '服务运行中');
});

test('after a real stop the banner says stopped instead of frozen "requested"', () => {
  const banner = describeServiceBanner({ requested: true, offline: true, status: 'running' });
  assert.equal(banner.text, '服务已停止');
  assert.equal(banner.stopped, true);
});

test('a service that keeps answering "running" after the request is visible and retryable', () => {
  const banner = describeServiceBanner({ requested: true, offline: false, status: 'running' });
  assert.equal(banner.offerRetry, true, 'a shutdown that never completed must not silently freeze at 已请求关闭');
  assert.match(banner.text, /仍在响应/);
});

test('the honest intermediate is "stopping" (the backend already reports it)', () => {
  const banner = describeServiceBanner({ requested: true, offline: false, status: 'stopping' });
  assert.match(banner.text, /正在停止/);
  assert.ok(!banner.offerRetry);
});

test('the status poll no longer stops when a shutdown was requested', () => {
  assert.doesNotMatch(jsxSource, /if \(!api \|\| requested\) return/,
    'the old early-return killed the 15s status poll forever after the click');
  assert.match(jsxSource, /from '\.\/service-status-state\.mjs'/);
  assert.match(jsxSource, /describeServiceBanner\(/);
  assert.match(jsxSource, /\}, \[api\]\);\n\s*async function shutdown/, 'the effect must depend on api only');
});
