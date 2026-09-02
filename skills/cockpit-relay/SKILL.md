---
name: cockpit-relay
description: 用户显式要求跨聊天接力时调用；同一 Skill 支持旧会话准备非终态接力与新会话凭 continueCode 恢复工作。
---

# UGK Cockpit 接力

本 Skill 必须由用户显式调用。当需要跨聊天会话无缝继续当前工作时使用，同一 Skill 包含两种显式模式：

1. **准备接力（旧聊天）**：当前聊天中无 `continueCode`，用户希望换新聊天继续时，调用 `ugk_work_relay` 准备非终态接力。
2. **恢复接力（新聊天）**：新聊天收到用户提供的 `continueCode` 时，调用 `ugk_work_resume` 恢复工作状态。

不得调用 `ugk_work_init` 或 `ugk_work_handoff` 代替接力；接力是非终态流程，不结束 Cockpit 阶段、不重新 init、不自动 handoff，不要自动 commit、清理、覆盖或 reset。

## 模式一：准备接力（旧聊天）

在已有 active Cockpit session 且掌握最近一次成功 MCP 返回的 `sessionId` 与 `revision` 时调用 `ugk_work_relay`。从当前事实整理交接信息，所有列表字段都必须提供字符串数组，若无内容提供 `[]`：

```json
{
  "sessionId": "<已有 active session 的 MCP 返回值>",
  "clientRequestId": "<本次请求生成的唯一 ID>",
  "expectedRevision": <最近一次 MCP 返回的 revision>,
  "nextSessionFocus": "<新聊天建议最重要的继续焦点>",
  "summary": "<本会话事实摘要>",
  "currentState": "<当前代码/任务状态>",
  "completedItems": ["<已完成事项>"],
  "pendingItems": ["<待处理事项>"],
  "decisions": ["<关键决定>"],
  "artifactRefs": ["<相关文件或产物引用>"],
  "risks": ["<风险或限制>"],
  "suggestedSkills": ["<建议新聊天使用的 Skill>"]
}
```

### 准备成功判定与报告

- **仅在**工具明确返回 `relayPrepared: true` 且 `status: "awaiting_resume"`（或 `status=awaiting_resume`），且包含非空的 `continueCode` 与 `continueMessage` 时，才向用户报告接力准备成功；缺任一字段不得宣告成功。
- **提供标准复制块**：准备成功后，必须将 MCP 返回的 `continueMessage` 作为唯一事实源，**原样放入一个单独的 text 代码块**中输出，供用户直接完整复制到同一项目的新会话中；绝对不得要求或让用户自行拼接指令、参数或代码。
- **摘要隔离**：会话事实摘要、当前状态、待办事项等交接信息若向用户说明，必须作为普通说明文字留在代码块之外，严禁混入或污染 `continueMessage` 复制块。
- prepare 成功后旧聊天停止继续修改代码与操作工作区；接力保持当前 Cockpit 阶段与写入租约，不结束阶段、不自动 handoff、不自动 commit、不清理工作区。

## 模式二：恢复接力（新聊天）

在新聊天中，用户提供了 `continueCode` 时调用 `ugk_work_resume`：

```json
{
  "continueCode": "<用户提供的一次性接力代码>",
  "clientRequestId": "<本次请求生成的唯一 ID>"
}
```

### 恢复成功判定与报告

- **仅在**工具明确返回 `relayAccepted: true` 且 `status: "active"`（或 `status=active`）且具备有效的 `sessionId` 与 `revision` 时，才向用户报告恢复成功并进入工作状态。
- 成功后使用返回的 `sessionId` 和 `revision` 作为后续调用（如 `$cockpit-progress`）的基准；接力恢复后直接继续工作，不得重新调用 `ugk_work_init`。
- 恢复后由 MCP 返回已保存的 `relayContext`（包含 `summary`、`currentState`、`pendingItems` 等交接信息），简短向用户复述关键上下文与下一步焦点，并报告 `sessionId` 与 `revision` 后等待安排或继续工作。

## 不变量与失败处理

- `clientRequestId` 必须非空且唯一。传输结果不确定时，使用相同的 ID 重发完全相同的 payload；不要换 ID 或修改 revision。
- 请求中严禁携带 `path`、`projectId` 或 `worktreeId`；`ugk_work_resume` 仅包含 `continueCode` 与 `clientRequestId`，不得携带 `currentTask`、`currentState`；`ugk_work_relay` 不得携带 `reason`、`nextTask` 等未定义字段；MCP 会绑定当前工作目录并负责权限、CAS revision 与状态流转。
- MCP 报错、不可用、缺少成功标志（如 `relayPrepared: true` / `status: "awaiting_resume"` / 非空 `continueCode` / 非空 `continueMessage`）或状态不符时，向用户说明发生了什么、代码是否受影响及建议下一步；提示用户安装/启用 `ugk-cockpit` 本地 MCP。缺少必要字段不得声称接力准备或恢复成功。
- 恢复成功前不要修改代码；不得清理或重置工作区已有改动。
