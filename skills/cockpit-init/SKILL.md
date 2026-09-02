---
name: cockpit-init
description: 通过 UGK Cockpit MCP 把空项目、已有开发或平台派发任务接入当前 AI 工作会话，并在成功后进入 working。
---

# UGK Cockpit 初始化

这是唯一通用的 Cockpit 开始入口；不要另设第二个开始 Skill。目标是让当前 AI 在 MCP 成功后进入 `working`，再开始修改代码。

## 调用

平台给出一次性 `initCode` 时调用 `ugk_work_init`。空项目、新派发任务、已有开发和存在本地改动的项目都使用这一条路径：

```json
{
  "initCode": "<平台提供的一次性代码>",
  "clientRequestId": "<本次请求生成的唯一 ID>",
  "currentTask": "<当前或准备开始的明确目标>",
  "currentState": "<简洁、可核实的起始状态或当前进展>"
}
```

优先从用户消息和当前会话事实填写 `currentTask`、`currentState`，不要为了格式重复盘问用户。空项目且尚无成果时可如实写“等待用户安排的首项开发”和“项目已创建，尚未产生开发成果”。

`ugk_work_init` 成功必须返回 `status: "active"`、`sessionId` 和 `revision`；这已经是 `working`，不需要也不应再调用 accept、begin 或第二个开始工具。如果结果带有 `latestHandoff` 且值非 `null`，用它恢复上下文并向用户简短复述；该字段可缺省或为 `null`，都不能阻断初始化。

旧消息若只提供 `dispatchCode` 而没有 `initCode`，说明它来自兼容流程，请用户在 Cockpit 重新生成 init 指令；不要把旧流程悄悄当作新流程执行。

`ugk_work_init` 的输入只包含上面的四个字段；不要自行传 `mcpWorkingDirectory`、路径或项目标识，stdio client 会绑定当前工作目录。

## 不变量与失败处理

- `clientRequestId` 必须非空且每个逻辑请求唯一。传输结果不确定时，使用同一个 ID 重发完全相同的 payload；不要换 ID、改 payload 或重复执行代码操作。
- 后续请求的 `sessionId` 与 `expectedRevision` 只使用最近一次成功 MCP 返回的值，不猜测、不自行递增。不要在请求中加入 `path`、`projectId` 或 `worktreeId`。
- MCP 负责权限、写入会话、CAS revision、幂等和事务；Skill 不复制状态机，也不强行接管其他 AI 的会话。
- MCP 报错、状态不是 `active`、返回缺少成功所需的 `sessionId`/`revision`，或 MCP 不可用时，明确告诉用户“无法连接或启用 UGK Cockpit 本地 MCP，请安装/启用后重试”；不要声称已经接入或完成。
- 初始化成功前不要修改代码；不要清理、覆盖、reset、checkout、merge 或自动 commit。已有改动必须保留。
