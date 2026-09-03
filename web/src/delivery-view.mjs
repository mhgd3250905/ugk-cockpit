export const SUBMIT_MESSAGE = '本次分支任务已完成，请使用 $cockpit-submit 提交审核。先通过 MCP 核对平台项目、当前工作线、本次文件范围和最新 main 的合并关系，再保存并上传。不需要补做 init，不接管其他会话；存在冲突、目录未授权或项目不明确时先告知我。成功后报告平台审核任务与固定代码版本，不自动合并。';

export function deliveryStatusLabel(submission) {
  const labels = {
    pending: '等待主项目审核', claimed: '审核进行中', integrated: '已接入主项目',
    approved: '审核通过，等待授权接入', conflict: '需要解决合并冲突', stale: '已有新版本，此次审核已失效',
    changes_requested: '审核要求修改', rejected: '审核未通过', blocked: '需要处理后继续',
    cancelled: '已取消', withdrawn: '已撤回', merging: '正在接入主项目', push_failed: '保存成功，上传待恢复',
  };
  return labels[submission.status] ?? '需要查看审核结果';
}
