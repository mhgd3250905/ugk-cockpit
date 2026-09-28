// 「新建开发空间」在缺少 Git 基线时的出路说明（AGENTS.md：每个异常必须回答
// 发生了什么、代码是否受影响、推荐下一步）。此前入口函数在 setBusy 之前
// `if (... || !project?.git?.head || ...) return` 静默返回——按钮与坏死无异。
// 后端本就要求 expectedBaseHead 是一个 Git object id，缺基线时确实无法继续，
// 但拒绝必须说得出原因与下一步。
export function describeSpaceCreateBlock(project) {
  if (!project || project.git?.head) return null;
  if (project.git?.available === false) {
    return {
      message: '现在还不能创建开发空间',
      detail: '这个代码位置是文件夹而不是 Git 仓库，开发空间需要 Git 工作副本。请确认添加的是代码仓库目录。',
    };
  }
  return {
    message: '现在还不能创建开发空间',
    detail: '最近一次观察没有取到 Git 基线（代码位置暂不可读或检查未完成）。请先刷新项目，等观察成功后再试。',
  };
}
