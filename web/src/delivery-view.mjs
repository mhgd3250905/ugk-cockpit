export const SUBMIT_MESSAGE = '请使用 $cockpit-submit 向当前项目发布一条工作说明。根据已有事实整理当前进展与待办，不需要假设任务已完成，不默认执行保存、上传或预检。';

export function noteStatusLabel(status) {
  const labels = {
    pending: '待处理',
    handled: '已处理',
    archived: '已归档',
  };
  return labels[status] ?? status;
}

export function deliveryStatusLabel(submission) {
  const labels = {
    pending: '等待主项目审核', claimed: '审核进行中', integrated: '已接入主项目',
    approved: '审核通过，等待授权接入', conflict: '需要解决合并冲突', stale: '已有新版本，此次审核已失效',
    changes_requested: '审核要求修改', rejected: '审核未通过', blocked: '需要处理后继续',
    cancelled: '已取消', withdrawn: '已撤回', merging: '正在接入主项目', push_failed: '保存成功，上传待恢复',
  };
  return labels[submission?.status] ?? '需要查看审核结果';
}
