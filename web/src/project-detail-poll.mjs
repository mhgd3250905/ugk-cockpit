// 项目详情轮询的合并决定（main.jsx 的 4 秒定时器用它代替旧的整包丢弃）。
//
// 用户通过「加载更早记录」累积的时间线窗口可以超过轮询页的上限（服务端封顶
// 100 条）。旧逻辑 `if (visibleCount > limit) return prev` 在这种情况下丢弃
// **整个**轮询响应——项目状态、进行中会话、工作说明计数从此不再更新，而定时器
// 还在每 4 秒发一次请求。决定按事实拆开：轮询页覆盖不了累积窗口时，历史窗口
// 留给用户（截断会丢掉他们明确翻出来的行），其余详情照常更新。
export function applyPolledProjectDetail(previousData, polledData) {
  if (!previousData) return polledData;
  const visible = previousData.timeline?.items?.length ?? 0;
  const polled = polledData?.timeline?.items?.length ?? 0;
  if (visible > polled) {
    return { ...polledData, timeline: previousData.timeline };
  }
  return polledData;
}
