# Cockpit 身份连续性与可追溯诊断计划

## 目标

让一次 AI 工作会话在凭据刷新、HTTP 服务重建后仍能被安全定位，并明确全新 MCP bridge 的恢复边界，同时让“当前聊天”“此前 MCP 连接”“当前数据库绑定”和“不可变接力回执”不会互相冒充。诊断必须能回答发生了什么、是否影响代码、下一步是什么，但不能把凭据、路径或聊天原始标识带出日志或界面。

## 不变量

- 认证凭据与连接归属分离。服务 token 继续决定认证主体；匿名 bridge 只通过服务签发的 `v1.<nonce>.<hmac>` opaque handle 恢复连接主体摘要。handle 使用现有持久服务 token 作为 HMAC 密钥，并采用域分离；原文不进入模型参数、普通工具 schema、数据库或日志。更换签名密钥明确拒绝旧 handle。
- 每次请求的宿主聊天元数据优先于 bridge 默认值；显式请求上下文缺少元数据时不得复用另一个聊天的缓存身份。没有稳定元数据的旧客户端继续使用 token-level legacy 兼容路径，但不能伪造旧连接或宿主聊天。
- `bindingKind`、`bindingPersistence` 和 `capabilities` 在 context/init/accept/resume/takeover 的成功与拒绝结果中保持真实：不可变回执只说明历史事实，当前 binding 才决定当前能否继续；旧回执不能重新授权。
- MCP 到服务的每个逻辑请求携带受限 `diagnosticId`。结构化日志只记录固定字段、有限轮转，日志失败不改变业务结果；传输丢失仍返回 uncertain 并沿用原有 journal/clientRequestId 重放。
- 浏览器只能用当前项目身份读取近期诊断。服务端从数据库取得该项目已有的 session ID，再读取固定诊断文件并二次脱敏；不接受任意路径、任意 session selector 或网页内容读取。

## 实施批次

### A：连接连续性

1. `/api/v1/mcp/session` 首次返回短期 scoped token 与签名 handle；新版 bridge 通过内部 v1 能力标记使用 handle 路径，并发 bootstrap single-flight；未声明该能力的旧客户端继续使用原 token-level 兼容路径。
2. bridge 进程内保存 handle，服务重启后用相同 handle 恢复同一 connection-only binding；没有 handle 的新 bridge 不能声明旧连接。
3. 保留既有 `principalHash` 语义，另存连接主体摘要；takeover 仍通过数据库 binding/revision/CAS 撤销旧连接归属。

### B：上下文与协议事实

1. 统一报告 binding 类型、持久性、当前能力和 owner 说明。
2. 明确 host metadata、connection handle、legacy token、anonymous bridge 四类身份来源；不猜历史 schema 字段，不靠目录/PID 补全身份。

### C：诊断闭环

1. 服务端记录 session/revision/identity source/recognized/credential event/binding reason/result 等白名单字段。
2. 固定日志文件按大小轮转；日志损坏、权限或 IO 失败只降低可观测性，不改变响应。
3. 项目高级详情提供近期诊断读取和复制脱敏结果；结构化错误继续包含 code、reason、diagnosticId、impact、required_action。

### D：人机交接

复用 workbench 的技术详情和工作说明区域。relay/progress 只携带业务参数；handle、宿主元数据和 diagnosticId 由 bridge/服务内部处理。submit-notes 仍是只读/写入说明的既有流程，不创建新的 finish、history 或 Cockpit 凭据。

## 验收矩阵

| 场景 | 期望结果 |
| --- | --- |
| 同一 bridge 跨服务重启 | 原 connection-only binding 可恢复，session/revision 不变且可继续 |
| 新 bridge 或 handle 签名密钥变化 | 不得声明旧连接；返回安全错误和下一步 |
| 两个 bootstrap 并发 | 只产生一次 session bootstrap，handle 不进入工具参数/schema |
| host metadata 缺失或更换 | 不复用其他聊天缓存；按 binding/owner 规则拒绝或要求确认 |
| context/init/accept/resume/takeover | 同时返回真实 binding 信息与 capability；旧 receipt 不授权 |
| 服务/bridge 传输中断 | 返回 uncertain，保留 diagnosticId，使用原 clientRequestId 重放 |
| 诊断读取 | 仅当前项目已知 session、固定文件、脱敏字段；不暴露 token/handle/path/body |
| 日志写入失败或轮转 | 业务响应照常返回，stdout 协议保持干净 |

## 当前落地与边界

本轮已落地 A-D 的服务与 bridge 核心、项目详情只读入口及 relay/progress 约束；数据库 schema 无新增迁移。现有业务项目不清理、不覆盖、不重新 init。独立复核后由主任务执行最终门禁并形成本地检查点，不执行发布操作。

handle 当前只保存在 bridge 进程内：本轮解决同一 bridge 的短期凭据刷新和服务重启连续性，不承诺缺少宿主身份的全新 bridge 自动恢复。没有原 handle 或稳定宿主身份时仍须正常接力或用户确认接手；不在项目共享目录保存可被新旧聊天共同读取的授权凭据。本轮未切换实际服务、未覆盖已安装技能，也未在最初报错的宿主或浏览器中进行人工端到端验收。

## 审查 finding 关闭证据（2026-09-07）

- P1：HTTP 成功回执中的 `capabilities` 现在独立核对当前数据库中的精确 conversation key、session、worktree、Relay 代际、未撤销 owner 和当前会话状态。历史 receipt 的 `revision` / `acceptedRevision` 不被当作当前业务 revision 门禁；同一 owner 在普通 progress 后仍可重放历史回执，owner 被替换或会话完成后 `writeSession`、`prepareRelay` 为 false。
- P2：绑定断言失败现在只携带已由数据库确认的 `sessionId`、当前 `revision`、白名单 `bindingReason` 和安全状态；全局 catch 与 stdio 只转发这些字段，不透传异常原文。诊断日志按数据库存在的 session 记录，项目接口仍按项目 assignment session 集合过滤。
- focused 回归覆盖 `resume` 与 `takeover` 的同 owner 重放、被 B 撤权后的旧回执、完成后的能力降级，以及旧 holder progress 的真实 HTTP→MCP 错误字段、同一 `diagnosticId` 日志和跨项目不可见性；受影响范围 46/46 通过。独立复核对上述两项 finding 精确复查，连续性文件测试 9/9 通过，两项均关闭；主任务核对后接受复查结论。

## 最终门禁（2026-09-07）

- `npm test`：363/363 通过，失败、取消、跳过均为 0，退出码 0。
- `npm run test:phase0`：93/93 通过，退出码 0。
- `npm run build:web`：通过，退出码 0；保留现有大于 500 kB 的 bundle 提醒，不在本次范围内拆包。
- `git diff --check`：通过。

以上是本地代码验收，不代表已部署或原宿主现场故障已验证消失。后续切换服务须按本机恢复文档核对已有项目和历史，再用原宿主完成接力→progress 的现场验证；浏览器诊断读取与复制还需人工验证。
