---
name: cockpit-handoff
description: 阶段结束时从事实整理紧凑交接并调用 UGK Cockpit MCP；必须用户显式要求，仅 cockpitVerified:true 才报告交接成功。
---

# UGK Cockpit 交接

本 Skill 必须由用户显式调用。只有当前用户明确要求结束或交接 Cockpit 阶段时才可调用 `ugk_work_handoff`，从当前已知事实整理下一次可直接读取的紧凑交接。

普通功能完成、任务完成、Git commit、测试通过、上下文堆积或对话轮次增加都必须保持 active 状态，绝对不能由 AI 自行推断或隐式触发交接。如需跨聊天无缝接力，应使用 `$cockpit-relay`，不得自行 handoff。

除下述用户手动选择 `completed` 后的 closeout 前置外，不要由 handoff 自动 commit、清理、覆盖或改写项目文件；MCP 会负责最终状态采集、权限、CAS revision、事务和幂等。

## `completed` 的收束前置

仅当用户明确选择 `outcome: "completed"` 时，才要求并检查完整 closeout：在调用 `ugk_work_handoff` 前，必须在同一手动 handoff 工作流中执行或复用一个针对当前 `HEAD` 仍有效的 `$cockpit-closeout` 本地收束成果，其中包含已核对的 `commit SHA`、必要验证和对齐结论，而非必须存在 progress 回执。该 `completed` 选择本身就是执行 closeout 前置的用户授权，不要求用户额外再点名 `$cockpit-closeout`；closeout 仍不得由普通完成、commit、测试或其他非终态动作隐式触发。

如果 closeout 未完成、验证已失效、当前 `HEAD` 已变化，或缺少可信 `commit SHA`，不得以 `completed` 调用 `ugk_work_handoff`；向用户说明代码是否受影响、closeout 失败的原因和推荐下一步，并等待处理。`blocked` 或 `abandoned` 不要求 closeout，只如实携带未解决事项。功能完成、commit、测试通过或上下文堆积都不能隐式触发 closeout 或 terminal handoff。

## 前置条件与内容

只在已有 active Cockpit session 且掌握最近一次成功 MCP 返回的 `sessionId`、`revision` 时调用。根据事实选择 `outcome`：`completed`、`blocked` 或 `abandoned`，不要为了好看把未完成工作写成 `completed`。所有列表字段都必须提供字符串数组，没有内容就用 `[]`。

```json
{
  "sessionId": "<已有 active session 的 MCP 返回值>",
  "clientRequestId": "<本次请求生成的唯一 ID>",
  "expectedRevision": <最近一次 MCP 返回的 revision>,
  "outcome": "<completed|blocked|abandoned>",
  "nextSessionFocus": "<下一次最重要的动作>",
  "summary": "<本阶段事实摘要>",
  "currentState": "<当前代码/任务状态>",
  "completedItems": ["<已完成事项>"],
  "pendingItems": ["<待处理事项>"],
  "decisions": ["<关键决定>"],
  "artifactRefs": ["<相关文件或产物引用>"],
  "risks": ["<风险或限制>"],
  "suggestedSkills": ["<下一次可用 Skill>"]
}
```

可选的 `acknowledgements` 只能放真实证据，例如 `"commit:<sha>"` 或用户已明确确认的 `"unattributed_changes"`；不能杜撰 commit、归属或验证结果。若 MCP 因未归属改动要求确认，先向用户说明这些改动不会被清理或提交，并等待明确确认；不要自行补 token 或通过改 outcome 绕过检查。

## 成功标准与重试

- 只有工具结果中严格出现布尔值 `cockpitVerified: true`（且不是工具错误）才向用户宣告“交接已由 Cockpit 验证并完成”。只有 `ok: true`、Markdown 或本地推断都不能替代该字段。
- 缺少 active session、MCP 不可用、缺少 `cockpitVerified: true` 或 revision 冲突时，只向用户报告未完成平台 handoff（说明发生了什么、代码是否受影响及建议下一步），绝不否定本地已完成的收束成果；不能绕过失败 CAS 继续终态调用，也不得声称交接成功。提示用户安装/启用 `ugk-cockpit` 本地 MCP 或按 MCP 返回的事实处理。
- 传输结果不确定时，使用同一个 `clientRequestId` 重发完全相同的 payload；不要换 ID、猜 revision、重复结束操作或再调用另一个终态工具。
- 请求不得携带 `path`、`projectId` 或 `worktreeId`；不要在 Skill 内复制状态机或绕过 MCP 权限。
