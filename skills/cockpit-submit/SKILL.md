---
name: cockpit-submit
description: 用户明确要求把当前分支成果保存上传并交给主项目审核时，通过 MCP 先检查项目、范围与冲突，再安全送审；不要求开发前 init。
---

# UGK Cockpit 送审

这个动作只能由用户显式调用。只有用户明确调用 `$cockpit-submit` 或要求保存并送审时使用；不要因测试通过、出现 commit 或任务看似完成而自动调用。它接收一次交付，不补造开发历史，不自动合并或结束阶段。

## 先检查，再保存

1. 在当前代码目录调用 `ugk_work_submit_preflight`，传新的 `clientRequestId`。只有本聊天确有最近 MCP 返回的可信 `sessionId` 与 `revision` 时才一并传 `sessionId`、`expectedRevision`；没有也可检查，不要求先 init、不查找本地凭据、不猜旧会话。
2. 返回 `DELIVERY_FOLDER_REQUIRED` 时，说明需要用户选择当前代码目录。获得同意后以 `selectFolder: true` 和新请求号再次检查，用户可在系统选择器取消。目录由 bridge 注入，不传路径或 token。项目不存在/对应多个项目时先请用户在平台核对，不自动创建项目或选一个猜测的目标。
3. 返回 `DELIVERY_SCOPE_REQUIRED` 时，核对完整 `changes` 与本次任务，明确列出将保存的文件；不相关、敏感或归属不明的改动不能捎带。用新请求号和精确的 `files` 列表重新检查；`files: []` 只送审已提交代码，不保存未提交改动。选择不明确时问用户。
4. `ready: true` 表示得到了绑定本次内容与最新远端 main 的 `preflightId`。若 `relation: conflict`，先报告冲突，只有用户明确同意“先保存为需解决冲突的待办”才能传 `allowConflicts: true`。旧分支、非快进和文件冲突不是同一件事。已送审返回现有任务，已合入不重复提交；任何未完成的检查不能声称通过。
5. 从事实生成不超过 160 字的 `summary`，调用 `ugk_work_submit`：

```json
{
  "clientRequestId": "<本次唯一幂等键>",
  "preflightId": "<刚才 MCP 返回的预检编号>",
  "summary": "<本次功能交付摘要>"
}
```

已有 GitHub PR 时可传 `pullRequestUrl` 作为引用，不把它当作服务端验证过的审核/合并结果。不得自行执行 `git add`、`git commit`、`git push`、`git reset`、`git rebase`、`git merge` 或 worktree 清理；MCP 负责精确范围保存、非强推、幂等恢复与送审记录。

存在其他写入会话时不能抢占。只能只读登记无未提交改动且已上传的成果；需要保存/上传时请原会话处理或先接力，不擅自结束原会话。

## 回执

- submit `ok: true`：报告 `submissionId`、`sourceCommit`、`targetHead`、`revision` 与状态。普通状态为等待 main 审核；`conflict` 是需解决冲突，不是可合并。请用户在主项目待办复制审核指令转交 main。这里的 revision 属于审核任务，不是旧会话 revision。
- `localSaved: true, pushed: false`：明确本地已保存、远端尚未确认送达，报告错误与推荐动作；不得 reset 或另造 commit。用户要求重试时，使用同一个 `clientRequestId` 和完全相同的 payload。需要重新 preflight 的状态除外，应复用已保存成果。
- `pushed: true, ok: false`：代码已上传但平台审核登记尚未完成，不能声称送审成功。
- 其他失败：说明是否产生了本地保存、代码是否受影响，以及 MCP 返回的下一步；不要声称已送审。

传输结果不确定时，仅可用相同幂等键重发完全相同的 payload。不要传 `path`、`projectId`、`worktreeId`、分支名、remote 或本地 token，不从数据库提取内部编号绕过校验。

## 外部机器没有可用 MCP

不要绕过 preflight 自行保存推送，也不共享本机 token。可整理已经存在的远端分支或 PR、完整提交 SHA、摘要与未决问题，清楚标记“待接入，平台尚未收到”。未提交/未上传的代码如实列为未交付；请用户另行授权外部 Git 操作或在本机取得该成果后调用同一个技能。此信息不是平台回执，不能伪造 submissionId。
