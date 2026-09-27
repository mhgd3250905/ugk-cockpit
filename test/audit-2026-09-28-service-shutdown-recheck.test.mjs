// 第 30 轮审计（2026-09-28）：请求关闭之后必须继续复查，且复查必须按可观测
// 事实说话。旧实现两点都缺：`if (!api || requested) return` 让状态轮询在确认
// 关闭的那一刻永久停止，横幅冻结在「已请求关闭服务」。而服务确认关闭后先关
// 监听再排在飞请求（`close()` 实测：新连接 ECONNREFUSED、进程仍存活排空），
// `status:'stopping'` 只在 shutdown 的 202 回执里出现过——轮询永远观察不到它。
// 因此修复不能反过来造一个新谎：拿点击前的 'running' 快照判「仍在响应」，或
// 把「连不上」说成「已停止」。判定收进纯函数，横幅三分：暂时连不上（不冒充
// 结论）、确认回执窗口内/探测仍报 stopping（正在关闭）、探测成功且 running
// （关闭没走完或已是一次新启动——这才给「重新发起关闭」）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  describeServiceBanner,
  SHUTTING_DOWN_TEXT,
  STOPPED_TEXT,
  STUCK_TEXT,
} from '../web/src/service-status-state.mjs';

const jsxSource = readFileSync(new URL('../web/src/service-status.jsx', import.meta.url), 'utf8');

test('before a request the banner keeps its three connection states', () => {
  assert.equal(describeServiceBanner({ requested: false, offline: true, status: 'running' }).text, '服务未连接');
  assert.equal(describeServiceBanner({ requested: false, offline: false, status: null }).text, '正在连接服务');
  assert.equal(describeServiceBanner({ requested: false, offline: false, status: 'running' }).text, '服务运行中');
});

test('after the listener is gone the banner never claims more than "cannot reach"', () => {
  // 真卡在在飞请求上：监听已关、进程还活着——与已退出不可区分，文案不得选边。
  const banner = describeServiceBanner({ requested: true, offline: true, status: 'running' });
  assert.equal(banner.text, STOPPED_TEXT);
  assert.match(banner.text, /可能/, 'the UI cannot observe which of the two happened — it must keep both open');
  assert.doesNotMatch(banner.text, /^服务已停止/, 'must not assert a stop the UI cannot observe');
});

test('the confirmed shutdown receipt is shown as closing, not as a stuck stop', () => {
  // 点击刚结束、下一轮探测还没跑：必须用回执里的 stopping，而不是旧快照 running。
  assert.equal(describeServiceBanner({ requested: true, offline: false, status: 'stopping' }).text, SHUTTING_DOWN_TEXT);
  assert.equal(describeServiceBanner({ requested: true, offline: true, status: 'stopping' }).text, STOPPED_TEXT);
});

test('a probe that genuinely answers running after the request is visible and retryable', () => {
  // 只有轮询成功后才会带着 running 进来（关闭没走完 / 新一次启动）——此时
  // 「重新发起关闭」是真出路。
  const banner = describeServiceBanner({ requested: true, offline: false, status: 'running' });
  assert.equal(banner.text, STUCK_TEXT);
  assert.equal(banner.offerRetry, true);
});

test('the component feeds the receipt into the snapshot and keeps polling', () => {
  assert.match(jsxSource, /from '\.\/service-status-state\.mjs'/);
  assert.match(jsxSource, /describeServiceBanner\(/);
  // 回执的 stopping 必须写入 info，否则确认后的窗口里横幅拿着旧 running 谎报。
  assert.match(jsxSource, /setInfo\(\(current\) => \(\{ \.\.\.\(current \?\? \{\}\), \.\.\.result \}\)\)/);
  // 状态轮询的效果不得再被请求态门掉（任何拼写的同义早退同样禁止——第三轮复核实测
  // 「把 requestedRef 早退塞进 poll() 首行」可绕过字面量断言）。
  const effect = jsxSource.match(/useEffect\(\(\) => \{[\s\S]*?\n {2}\}, \[api\]\);/);
  assert.ok(effect, 'status poll effect anchored on [api] not found');
  assert.doesNotMatch(effect[0], /\brequested\b/, 'the poll must not gate on the request flag again');
  assert.doesNotMatch(jsxSource, /if \(!api \|\| requested\) return/);
});
