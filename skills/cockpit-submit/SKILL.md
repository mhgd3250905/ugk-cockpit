---
name: cockpit-submit
description: 用户明确表示受管开发空间的功能已经做完、需要保存提交并送交主项目审核时，安全执行一次可恢复的提交与非强推送审。
---

# UGK Cockpit 送审

这个动作只能由用户显式调用。只有用户明确调用 `$cockpit-submit` 或明确要求“把这个开发空间保存并送审”时使用；不要因测试通过、出现 commit 或任务看似完成而自动调用。

## 调用

确认已有 active Cockpit session，并使用最近一次 MCP 返回的 `sessionId` 与 `revision`。从已完成工作的事实中生成一句不超过 160 字的送审摘要和新的 `clientRequestId`，只调用一次：

```json
{
  "sessionId": "<active sessionId>",
  "clientRequestId": "<本次唯一幂等键>",
  "expectedRevision": <最近 revision>,
  "summary": "<本次功能交付摘要>"
}
```

调用 `ugk_work_submit`。不得自行执行 `git add`、`git commit`、`git push`、`git reset`、`git rebase`、`git merge` 或 worktree 清理；MCP 负责核验代码位置、普通 commit、非强推、幂等恢复与送审记录。

## 回执

- `ok: true`：告诉用户功能已保存并送达主项目，报告 `submissionId`、`sourceCommit`、`targetHead`、`revision`，并说明等待 main 审核；不要自动结束或接力当前会话。
- `localSaved: true, pushed: false`：明确说明本地成果已保存、远端尚未送达，报告错误和推荐动作；不得 reset 或另造 commit。用户要求重试时，使用同一个 `clientRequestId`、完全相同的 payload 和 revision。
- 其他失败：说明是否产生了本地保存、代码是否受影响，以及 MCP 返回的下一步；不要声称已送审。

传输结果不确定时，仅可用相同幂等键重发完全相同的 payload。不要传 `path`、`projectId`、`worktreeId`、分支名、remote 或本地 token。
