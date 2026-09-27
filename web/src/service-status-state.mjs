// 关停请求后的横幅判定（AGENTS.md：每个异常要回答发生了什么/下一步；回执不能
// 停在「已请求」就再也不核对事实）。输入全部来自仍在运行的 15 秒状态轮询：
// requested=用户已确认关闭，offline=最近一次轮询失败，status=服务自报状态。
export function describeServiceBanner({ requested, offline, status }) {
  if (!requested) {
    if (offline) return { text: '服务未连接' };
    if (!status) return { text: '正在连接服务' };
    return { text: '服务运行中' };
  }
  if (offline) return { text: '服务已停止', stopped: true };
  if (status === 'stopping') return { text: '服务正在停止' };
  // 请求已确认（回执 status:'stopping'）却仍应答 running：关闭没有走完
  // （在飞请求卡住关停、onShutdown 抛错等）。必须可看见、可重试。
  return {
    text: '已请求关闭，但服务仍在响应',
    offerRetry: true,
    detail: '服务可能在等待正在处理的请求结束；也可以重新发起关闭。',
  };
}
