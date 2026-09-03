const messages = {
  COMMIT_IDENTITY_MISSING: ['尚未配置可用于保存的 Git 作者信息。', '请先配置 user.name 和 user.email；平台不会冒用其他人的身份。'],
  DELIVERY_CACHE_INVALID: ['预检临时数据已失效。', '已有代码会保留，请重新预检；不要手动清理项目文件。'],
  DELIVERY_PUSH_FAILED: ['未能确认普通推送成功。', '本地保存会保留；请核对已有 Git 登录和网络后使用原请求恢复，不要强推。'],
  DELIVERY_REVIEW_REF_UNAVAILABLE: ['暂时无法读取本次审核对应的远端代码。', '请核对网络、远端权限或分支是否被删除，再继续审核。'],
  REPOSITORY_LOCKED: ['这个项目正在处理另一个代码保存或合并操作。', '请稍后使用原请求继续，平台不会并发覆盖代码。'],
  SOURCE_BRANCH_DETACHED: ['当前代码没有处于可送审的工作线上。', '请先确认要交付的分支，再重新送审。'],
  SOURCE_BRANCH_MAIN: ['当前位于主工作线，不能把它作为功能分支送审。', '请到完成功能的分支会话调用 submit。'],
  REMOTE_SOURCE_AHEAD: ['远端工作线包含本机尚未取得的提交。', '请先核对并取得远端成果，再重新预检；不要强推覆盖它。'],
  REMOTE_SOURCE_DIVERGED: ['本机与远端工作线各有不同的提交。', '请先解决两边的版本分歧，再重新预检；平台不会自动重排或覆盖提交。'],
  REMOTE_TARGET_CHANGED: ['检查后远端 main 已经更新。', '已有保存会保留；请用新的预检重新核对与 main 的关系。'],
  REMOTE_TARGET_UNREACHABLE: ['暂时无法确认远端 main 的最新版本。', '请检查网络与已有 Git 登录配置后重新预检；不能用旧状态代替检查。'],
  REMOTE_SOURCE_UNREACHABLE: ['暂时无法读取或上传这条工作线。', '请检查网络与已有 Git 登录配置；本地已保存时使用原请求恢复上传。'],
  REMOTE_SOURCE_MISMATCH: ['远端工作线已经不是本次送审的代码版本。', '请核对最新成果并重新预检；本次不能登记为已送达。'],
  DELIVERY_SOURCE_UPDATED: ['送审后这条工作线又有了更新。', '请让开发会话重新送审，新版本需要重新审核。'],
  REMOTE_IDENTITY_CHANGED: ['推送目的地与之前核对的仓库不一致。', '请核对 origin、推送地址与项目归属后再试。'],
  NO_COMMON_ANCESTOR: ['这份成果与主项目没有可确认的共同开发历史。', '请核对是否选择了错误项目或分支，不自动强行合并。'],
  SOURCE_CONTENT_CHANGED: ['预检后文件内容或暂存状态发生了变化。', '请保留当前文件并重新预检。'],
  HEAD_MOVED: ['预检后代码保存点发生了变化。', '请确认当前分支与成果，再重新预检。'],
  BRANCH_MISMATCH: ['预检后切换了工作线。', '请在当前需要交付的工作线上重新预检。'],
  SENSITIVE_FILE_REJECTED: ['本次选择包含疑似密钥或凭据文件。', '请从交付范围移除敏感文件，再重新预检。'],
  INVALID_DELIVERY_FILES: ['选择的文件不属于本次可安全保存的范围。', '请使用预检列出的精确相对文件名；重命名需同时选择旧、新路径。'],
  UNFINISHED_GIT_OPERATION: ['这份代码还有未处理完的 Git 操作。', '请先完成当前冲突或操作，再重新送审；平台不会自行中止它。'],
  GIT_FILTER_UNSUPPORTED: ['这份代码使用了暂不支持的内容转换配置。', '请在原开发工具中完成保存上传后核对兼容性；不要关闭转换规则强行提交。'],
  UNSAFE_REMOTE_URL: ['远程地址或重定向配置不能安全用于自动送审。', '请核对仓库配置；平台不会运行自定义传输命令。'],
  DELIVERY_INDEX_LOCKED: ['另一个 Git 操作正在使用暂存区。', '请等该操作完成后恢复送审，不要删除锁文件。'],
  DELIVERY_INDEX_CHANGED: ['成果已保存，但暂存区随后发生了变化。', '平台保留了当前暂存内容；请核对选中文件后重新预检，不要重置。'],
  DELIVERY_MERGE_CONFLICT: ['这次交付仍有合并冲突，不能记录为审核通过。', '请记录需要修改的意见，并由开发会话解决后重新送审。'],
  DELIVERY_FOLDER_REQUIRED: ['这份代码尚未获得送审访问授权。', '请同意打开文件夹选择器，并选择当前会话的代码目录；不需要重新 init。'],
  PROJECT_NOT_FOUND: ['平台中没有找到这份代码对应的项目。', '请先在平台添加主项目；已有 fork 请确认它配置了指向主项目的来源。'],
  DELIVERY_PROJECT_AMBIGUOUS: ['这份代码对应多个已登记项目，暂时无法确定交给谁。', '请在平台核对重复登记或项目对应关系，不要猜测目标。'],
  DELIVERY_SOURCE_IS_MAIN: ['当前不是可送审的功能工作线。', '请确认会话位于要交付的功能分支；不要直接送审 main。'],
  DELIVERY_PREFLIGHT_REQUIRED: ['送审前检查尚未完成。', '请更新 cockpit-submit Skill，并先调用 ugk_work_submit_preflight。'],
  DELIVERY_PREFLIGHT_STALE: ['检查后代码内容或目标版本发生了变化。', '请重新检查当前成果，再使用新预检结果送审。'],
  DELIVERY_PREFLIGHT_EXPIRED: ['送审前检查已过期。', '请重新检查当前成果后再送审。'],
  DELIVERY_PREFLIGHT_USED: ['这次检查已经用于另一个保存操作。', '请恢复原操作，或重新预检；不要重复制造提交。'],
  DELIVERY_REMOTE_CHANGED: ['代码的远程来源或目标发生了变化。', '请先核对仓库配置与项目归属。'],
  DELIVERY_SESSION_MISMATCH: ['提供的工作会话与当前代码位置或最新状态不匹配。', '请使用可信的最新会话信息，或只读登记已经上传的成果；不要重新 init 或猜会话编号。'],
  DELIVERY_WRITE_LEASE_CONFLICT: ['这份代码已有尚未交接的写入会话。', '请在原会话送审或先接力；不能抢占。无未提交改动且已上传的成果可以只读登记。'],
  DELIVERY_CONFLICT_CONFIRMATION_REQUIRED: ['本次成果与最新 main 存在合并冲突。', '请先解决冲突，或明确确认仅保存为“需要解决冲突”的待办。'],
  DELIVERY_DIRECTORY_MISMATCH: ['当前会话目录与本次送审对象不一致。', '请回到对应代码目录，不能拿另一份代码的检查结果送审。'],
  DELIVERY_INTEGRATION_BUSY: ['同一交付正在执行合并。', '请等待该操作结果后重新检查，不要替换它正在处理的版本。'],
};

export function deliveryResponse(result) {
  if (result.ok) return result;
  const known = messages[result.code] ?? ['送审检查或保存没有完成，不能确认已送达审核。', '请核对错误代码、远端连接与分支状态；保留已有改动，不要强推或重置。'];
  return { ...result, message: known[0], impact: result.pushed
    ? '代码已上传，但审核登记尚未完成；主项目代码没有被合并。'
    : result.localSaved ? '本地成果已保存，尚未确认上传并送达审核；主项目代码没有被修改。'
      : '尚未确认新的保存或送审；平台没有合并、覆盖或清理主项目。',
  required_action: known[1], next_command: null, warnings: [] };
}
