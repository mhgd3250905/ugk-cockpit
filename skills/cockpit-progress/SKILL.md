---
name: cockpit-progress
description: 在已有 active UGK Cockpit 会话中记录有意义的工作检查点，并在有效 Git 成果后同步进度。
---

# UGK Cockpit 进展

此 Skill 可显式调用，也应在当前 AI 成功产生有意义的检查点后自动调用。它只记录进展，不主动执行 Git。

## 何时记录

仅在已有 active Cockpit session，且当前 AI 刚刚成功完成以下事项之一时调用 `ugk_work_progress`：

- `commit` 成功；
- `merge`、`rebase` 或 `cherry-pick` 成功且 `HEAD` 确实变化；
- 发布 tag 成功；
- 用户明确要求记录进展。

不要为 `status`、`diff`、`log`、`add`，失败命令，或没有成果的切分支调用；这些不是检查点。不要为了判断是否该记录而主动运行 Git。

如果当前聊天遗失了最近一次成功 MCP 返回的 `sessionId` 或 `revision`，不要直接放弃、猜测或重新 init；在当前项目目录先调用只读 `ugk_work_context`（默认 `{}`）。只有返回 `canContinue: true`、`status: "active"`、有效 `sessionId` 和 `revision` 时，才可按下方格式登记。如果返回 `bindingStatus: "unbound"`，先向用户确认是否继续该候选会话，再把 context 返回的 `sessionId` 填入 `confirmSessionId`、把返回的 `revision` 填入 `expectedRevision`，成对调用 context 确认；确认成功前不要写 progress。`awaiting_resume`、`stale`、`ambiguous`、已结束或无会话时只报告平台登记未完成，不能把目录候选当作当前聊天身份。context 查询本身不改变会话、租约、心跳、revision 或业务记录；不可用时提示重新连接新版 MCP，不要求重新 init。

## 调用

只使用最近一次成功 MCP 调用返回的 `sessionId` 和 `revision`，生成新的非空 `clientRequestId`，调用：

```json
{
  "sessionId": "<已有 active session 的 MCP 返回值>",
  "clientRequestId": "<本次请求生成的唯一 ID>",
  "expectedRevision": <最近一次 MCP 返回的 revision>,
  "status": "working",
  "summary": "<一句简洁、可核实的事实，最长 160 字符；可包含 commit SHA 或 tag 名称>",
  "details": [
    "<可选的关键结果、测试输出或证据，每项最长 500 字符，最多 8 项>",
    "<可选的风险或下一步说明>"
  ]
}
```

优先提交一句可核实的 `summary`，`details` 只列必要证据/结果/风险短列表；不把多个段落塞入 `summary`。legacy `note`（最长 4000 字符）保留用于向后兼容，结构化调用不要求重复传 `note`。

`status` 只能使用非终态的 `working` 或 `in_progress`，不要用 progress 伪造终态。只有用户明确要求结束当前 Cockpit 阶段时，才改用 `$cockpit-handoff`（`ugk_work_handoff`）；功能完成、commit、测试通过或上下文堆积都不能由 AI 自行推断为结束。只有用户明确要求换聊天继续时，才改用 `$cockpit-relay`，不要因上下文长度自动接力。

成功后只把 MCP 返回的 `revision` 作为下一次 `expectedRevision`，不自行递增或猜测。没有 active session、没有可信的 session/revision，或请求失败时不要调用或声称已记录；补充登记缺失或失败不影响已成功 Git 成果或后续已授权 Git 操作，不诱导仅做本地收束或普通 Git 的场景去 init，显式要求平台记录时向用户说明需要先接入/恢复会话。

## 重试与不可用

- 传输结果不确定时，用同一个 `clientRequestId` 重发完全相同的 payload；不要换 ID、改 revision 或再次执行 Git。
- 平台登记缺失、跳过或失败时，只报告平台进展未登记，不影响已成功 Git 或后续已授权 Git；不回滚、撤销 commit 或阻塞授权 push。
- MCP 不可用时明确提示安装/启用 `ugk-cockpit` 本地 MCP 后重试，不声称完成。
- MCP 负责权限、CAS revision、幂等和事务；不要在 payload 中加入 `path`、`projectId` 或 `worktreeId`，也不要在 Skill 内复制状态机。
