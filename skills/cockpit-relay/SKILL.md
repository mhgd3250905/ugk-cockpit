---
name: cockpit-relay
description: 用户显式要求跨聊天接力时调用；同一 Skill 支持旧会话准备非终态接力与新会话凭 continueCode 恢复工作。
---

# UGK Cockpit 接力

本 Skill 必须由用户显式调用。当需要跨聊天会话无缝继续当前工作时使用，同一 Skill 包含两种显式模式：

1. **准备接力（旧聊天）**：当前聊天中无 `continueCode`，用户希望换新聊天继续时，调用 `ugk_work_relay` 准备非终态接力。
2. **恢复接力（新聊天）**：新聊天收到用户提供的 `continueCode` 时，调用 `ugk_work_resume` 恢复工作状态。

不得调用 `ugk_work_init` 或 `ugk_work_handoff` 代替接力；接力是非终态流程，不结束 Cockpit 阶段、不重新 init、不自动 handoff，不要自动 commit、清理、覆盖或 reset。

### 会话信息遗失时先恢复

如果准备接力前当前聊天没有最近一次成功 MCP 返回的 `sessionId` 或 `revision`，先在当前项目目录调用只读 `ugk_work_context`（默认 `{}`）。它会由 MCP bridge 注入工作目录并从平台读取权威状态；不要翻查凭据、猜测编号或重新 init。

MCP bridge 的 scoped credential 与 connection handle 由 bridge 和服务内部维护。handle 不是聊天身份，也不是工具参数；不要在 relay payload、说明文字或手工命令中读取、复制或拼接它。宿主每次调用提供的 `_meta` 才是当前聊天身份的优先来源；缺少 `_meta` 时按服务返回的 connection/legacy binding 事实处理，不能套用另一个聊天的缓存身份。服务返回的 `diagnosticId` 只用于定位本次请求；错误或 uncertain 时随原始请求记录，不要换 `clientRequestId`。

- 只有工具返回 `canContinue: true`、`status: "active"`、有效 `sessionId` 和 `revision` 时，才可继续准备 relay。
- 返回 `awaiting_resume`、已结束、`ambiguous` 或其他不可继续状态时，停止写入并如实说明；不要用同目录候选自动接续。
- 返回 `bindingReason: "held_by_another_chat"`，或返回 `bindingReason: "replaced"` 且带有 `owner` 时，这是安全拒绝，不是服务故障：先向用户报告 `owner` 中可用的持有类型、宿主/聊天定位符、任务、Agent 和最后活动时间。`holderType: "durable_chat"` 可定位回原聊天；`"previous_mcp_connection"` 表示宿主没有提供稳定聊天 ID，只能确认是此前受认证连接持有。两种情况都不得自动写入、重新 init 或绕过绑定。
- 这时只提供用户选择：回到持有人继续；或由用户在工作台的“会话接续与转交”面板授权其他聊天接手。聊天中的口头确认不能签发转交权限，不再使用旧的两步 takeover。只有用户提供工作台生成的接手指令后，调用 `ugk_work_takeover`，参数为其中的 `sessionId`、`transferCode` 和新的 `clientRequestId`。成功后先空参 context 确认可继续，再执行用户安排；接手本身就是新聊天的节点。授权过期、目标不符或已撤销时回工作台处理，不循环 takeover。用户取消转交也必须在工作台操作。
- 返回 `transfer_pending` 时，旧聊天已被冻结；只允许使用用户提供的工作台接手指令或由用户在平台取消。返回 `inspect_binding` 时保留诊断并停止写入，不把它解释为另一聊天已接手，不自动生成 Relay。其他 stale 情况按服务明确的恢复动作处理，不能凭旧绑定自动取回。
- 返回 `requiresUserConfirmation: true` 且 `bindingStatus: "unbound"` 时，只向用户确认是否“继续此工作会话”。用户确认后，使用上一次 context 返回的 `sessionId` 与 `revision` 成对调用 `ugk_work_context` 的 `confirmSessionId` 和 `expectedRevision`；确认期间 revision 变化则重新查询并再次确认。
- 只有确认调用返回 `bindingEstablished: true`、`canContinue: true`、`status: "active"` 后，才可准备 relay。context 确认建立当前聊天绑定：支持宿主身份时由服务持久保存；未适配客户端也会以受认证 MCP 连接摘要持久记录，服务或 MCP 重启后必须由用户确认接手；context 本身不改变平台工作会话、租约、心跳或 revision。
- 同时阅读响应中的 `bindingKind`、`bindingPersistence`、`bindingReason` 与 `capabilities`。它们表示当前绑定和当前能力；历史 receipt、旧 `relayGeneration` 或 `acceptedRevision` 不是重新授权。`connection_only` 表示可定位此前受认证连接，但重建后仍需按用户确认流程接手。

Codex/ZCode 的平台与宿主会话 ID 由每次 MCP 请求元数据传入；不得从路径、最近活动或任务标题猜当前聊天，也不要在普通工具参数里填写/冒充宿主身份。返回的最新节点及 owner 可用于引导用户回到正确聊天。宿主 ID 不等于 Cockpit `sessionId`。

新聊天已经收到 `continueCode` 时直接按模式二调用 `ugk_work_resume`，不要先用 context 的 `awaiting_resume`、`unbound`、`held_by_another_chat` 或 `stale` 结果阻挡恢复。历史 `relayGeneration` / `acceptedRevision` 是工作会话的历史，不是当前聊天已接手的证据。

## 模式一：准备接力（旧聊天）

在已有 active Cockpit session 且通过最近一次成功 MCP 返回或上述 context 恢复流程掌握可信 `sessionId` 与 `revision` 时调用 `ugk_work_relay`。准备模式只做轻量对齐摘要：复用当前已知事实和本阶段已经观察到的未对齐项，不为 relay 扫描全仓、运行测试、修文档或创建 commit，也不要因此触发 `$cockpit-closeout`。无论是否有未对齐项都不得阻塞 relay；把已知事项带入 `pendingItems`、`risks` 和 `nextSessionFocus`，不明事实不要猜测。所有列表字段都必须提供字符串数组，若无内容提供 `[]`：

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

恢复模式只恢复已保存的 relay 上下文，不执行对齐检查，也不扫描、验证或修正文档；恢复成功后再等待用户安排下一步。

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

### 过期码必须由工作台重新授权

当恢复返回 `CONVERSATION_PLATFORM_AUTHORIZATION_REQUIRED` 或接力码已过期，接手尚未完成。请用户在工作台打开该工作链并授权转交；取得平台生成的指令后使用 `ugk_work_takeover` 消费授权，不在聊天内确认过期码。

如果旧服务仍返回 `confirmation_required`，只报告协议需升级，不继续旧的聊天内确认流程。已提交但回复丢失的历史请求仍沿用原请求 ID 原样核对，不把重放当作新的授权。

若返回 `RELAY_SUPERSEDED` 或 `RELAY_ALREADY_ACCEPTED`，此旧码不能取回归属；必须使用当前持有者生成的新接力。不要自动接管已经被其他聊天接走的工作。

### 断线与回复丢失

新版 MCP 对 relay/resume/takeover 的传输失败进行一次原样自动重试。仍返回 `RELAY_TRANSPORT_UNCERTAIN` 或 `CONVERSATION_TAKEOVER_TRANSPORT_UNCERTAIN` / `status: recovery_pending` 时，结果未知，不能声称“平台没有更新”或“恢复成功”。连接恢复后，在当前聊天沿用同一 clientRequestId 和完全相同参数重试；确认请求也必须原样重试，不重复询问已明确确认的同一对象和方案。

未成功恢复时保留待恢复请求，不因用户接着安排开发而遗忘恢复。再次工作前先补办恢复；不得重新 init，也不得以目录相同推测归属。

## 不变量与失败处理

- `clientRequestId` 必须非空且唯一。传输结果不确定时，使用相同的 ID 重发完全相同的 payload；不要换 ID 或修改 revision。
- 请求中严禁携带 `path`、`projectId` 或 `worktreeId`；`ugk_work_resume` 新请求仅包含 `continueCode` 与 `clientRequestId`，不得追加旧过期确认字段或 `currentTask`、`currentState`；`ugk_work_takeover` 只允许 `sessionId`、`clientRequestId`、`transferCode`，授权只来自用户在工作台生成的指令；`ugk_work_relay` 不得携带 `reason`、`nextTask` 等未定义字段；MCP 会绑定当前工作目录并负责权限、CAS revision 与状态流转。
- MCP 报错或缺少成功标志时，按具体返回原因处理：待确认按当前聊天确认流程，结果未知按原样重试，已被替代则保留现有归属。只有工具不可用或不支持新参数时，才提示安装/启用或重新连接新版 `ugk-cockpit` 本地 MCP，不把所有错误都归结为需要重连。缺少必要字段不得声称接力准备或恢复成功，也不要因为 context 不可用就重新 init。
- 诊断信息只使用服务返回的固定 `code`/`reason`/`diagnosticId`/`impact`/`required_action`；不要把 token、connection handle、请求体、路径或异常原文写入接力消息。
- 恢复成功前不要修改代码；不得清理或重置工作区已有改动。
