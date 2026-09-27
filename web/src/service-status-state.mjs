// 关停请求后的横幅判定（AGENTS.md：每个异常要回答发生了什么/下一步）。
//
// 事实基线（第 30 轮独立复核实测并主线程复验）：服务确认关闭后先关监听
// （http-server.mjs `close()` 先 `server.close()` 再 await 在飞请求），因此
// 之后的状态请求只会连不上——`status:'stopping'` 只出现在 shutdown 自己的
// 202 回执里，对轮询不可观测。「暂时连不上」无法区分「正在排空」与「已退出」，
// 所以文案不冒充结论；「重新发起关闭」只在服务确认仍在应答 running 时才是出路。
export const SHUTTING_DOWN_TEXT = '服务正在关闭';
export const STOPPED_TEXT = '暂时连不上，服务可能仍在关闭或已停止';
export const STUCK_TEXT = '已请求关闭，但服务仍在响应';

export function describeServiceBanner({ requested, offline, status }) {
  if (!requested) {
    if (offline) return { text: '服务未连接' };
    if (!status) return { text: '正在连接服务' };
    return { text: '服务运行中' };
  }
  if (offline) return { text: STOPPED_TEXT, stopped: true };
  // 确认回执刚刚落定、下一轮探测还没跑完：按已确认的语义显示，不得据旧快照
  // 里的 'running' 判成「关闭没走完」。
  if (status === 'stopping') return { text: SHUTTING_DOWN_TEXT };
  if (status === 'running') {
    return {
      text: STUCK_TEXT,
      offerRetry: true,
      detail: '服务可能仍在处理更早的请求，也可能已经是一次新的启动。',
    };
  }
  return { text: SHUTTING_DOWN_TEXT };
}
