// After the assignment exists, clipboard write and detail refresh are
// best-effort follow-ups: a failed copy or a failed refresh must never claim
// the assignment was not generated, and any retry offered here must never
// re-create the assignment (creation stays outside this flow entirely).
export async function completeAssignmentCopy({
  copyText,
  refreshDetail,
  notify,
  isCurrent = () => true,
}) {
  const copied = await copyText().catch(() => false);
  if (!isCurrent()) return { copied, refreshed: false };
  if (copied === true) {
    try {
      await refreshDetail({
        message: '开发空间接入消息已复制。',
        detail: '请把它粘贴给将在该代码位置工作的 Agent。',
      });
      return { copied, refreshed: true };
    } catch {
      if (!isCurrent()) return { copied, refreshed: false };
      notify({
        tone: 'error',
        message: '开发空间接入消息已生成并复制，但详情刷新暂时失败。',
        impact: '接入指令已创建且仍然有效，项目代码没有变化。',
        required_action: '点击“重试刷新”重新拉取项目详情；不需要、也不会重新创建任务。',
        actionLabel: '重试刷新',
        retry: () => { refreshDetail().catch(() => {}); },
      });
      return { copied, refreshed: false };
    }
  }
  notify({
    tone: 'error',
    message: '开发空间接入消息已生成，但无法自动写入剪贴板。',
    impact: '接入指令已创建且仍然有效，代码没有变化。',
    required_action: '点击“重试复制”再次尝试；仍失败时在该开发空间卡片重新生成接入指令并手动复制。',
    actionLabel: '重试复制',
    retry: () => { copyText().catch(() => {}); },
  });
  return { copied, refreshed: false };
}
