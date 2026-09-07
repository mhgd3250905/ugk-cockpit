# 会话身份与中断恢复

## 当前契约（0.1.0-alpha.38）

### 接力失败与过期恢复

接力码的普通接收仍有有效期。支持稳定聊天身份的宿主在原码过期后，可以在当前聊天取得 `confirmation_required` 响应；这不是接手成功，也不改变运行 revision、租约或聊天归属。服务使用已有 `commands` 日志持久保存确认请求，绑定 code hash、聊天身份及当时版本，不存接力码原文，无需新增 schema。

用户明确确认后，使用新的 clientRequestId，附原确认响应的 confirmationRequestId 和 expectedRevision。服务在同一事务内再次核对原码、同一聊天、最新接力、项目身份、active 会话、写入租约及冻结版本，再完成接力消费和归属转移。旧会话推进版本、新接力取代旧码或其他聊天先接手都会拒绝，不把过期码当成自动接管权限。没有稳定宿主身份的旧客户端继续返回既有身份或过期错误，不能走此确认流程。

MCP 对 relay/resume/takeover 的传输错误原样自动重试一次；仍失败分别返回 `RELAY_TRANSPORT_UNCERTAIN` 或 `CONVERSATION_TAKEOVER_TRANSPORT_UNCERTAIN`：结果未知，不能声称“状态没有更新”。用户之后继续时沿用相同请求参数与请求 ID。成功命令回执及待确认回执都由持久日志恢复，进程缓存不承担正确性。

新聊天用 context 发现另一个 active 持有人时，服务返回 `bindingReason: "held_by_another_chat"`，并附 `owner`：持有类型、可用时的宿主和聊天定位符、任务、Agent、最后活动时间与绑定时间。查询仍然只读，不能因为目录相同或服务重启自动取得写入权。支持稳定宿主身份时，`owner` 会显示 `durable_chat` 与宿主定位符；未适配宿主显示 `previous_mcp_connection`，明确说明只能定位此前受认证的 MCP 连接，不能伪造聊天 ID。

当前聊天必须先向用户展示该事实。用户选择回到持有人时不做写入；用户明确选择在当前聊天接手时，调用两步 `ugk_work_takeover`：第一步得到持久的 `confirmation_required`，第二步只在用户确认同一对象后使用新的 clientRequestId、原 confirmationRequestId 与同一 revision。服务在一个事务中复核 active 会话、lease、无待接 Relay、原确认属于当前聊天和 revision CAS，再递增 run/assignment revision、记录审计 progress、撤销旧绑定并建立新绑定。确认过期、其他聊天确认或出现新接力都会拒绝。接手成功后，用户若想从新聊天 C 继续，由已接手的 B 再发起普通 Relay；不会由服务静默创造或替换聊天。

被新接力替代的旧聊天仍为 `stale` / `replaced`。若 context 同时显示当前 `owner`，它也可以按上述用户确认流程请求接手；没有 owner 的历史 stale 记录只能使用服务提供的最新接力线索，不能凭旧绑定自动取回。历史 relayGeneration 和 acceptedRevision 属于工作会话历史，不是当前聊天的身份凭据。Skill 要求恢复未完成时先补办恢复，不能在继续开发时遗忘失败请求。

2026-09-06 验证：会话绑定、接手、stdio 和 Skill 定向回归 31/31 通过，覆盖稳定宿主显示 A 后由 B 跨服务重启确认接手、B 再 Relay 到 C、无稳定聊天 ID 的 connection-only 重启恢复，以及接手事务提交前真实子进程终止后的原持有人保留和幂等重试。`npm run build:web` 通过。启动器已切换 alpha.38，并验证 6 个既有项目及详情；只读核对 schema 24、quick_check `ok`、6 项目/19 运行保留。未重新 init、清理、覆盖或重置任何业务项目记录。

回归覆盖过期确认后真实进程 SIGKILL、进程重建重放、确认跨聊天拒绝、确认期间版本变化/新接力、HTTP 服务重启和两个聊天并发确认，以及响应体丢失后的原样重试。既有 schema 21 历史升级与归属撤销回归继续保留。

工作会话、聊天绑定和 MCP 连接具有不同生命周期。项目、运行、时间线、写入归属和接力记录以 SQLite 为事实源；聊天绑定也由服务数据库持久保存，MCP 进程不再是支持身份的宿主的唯一绑定持有者。

认证主体与连接归属同样分离。匿名 MCP bridge 首次建立 scoped session 时获得 `v1.<nonce>.<hmac>` opaque connection handle；HMAC 使用现有持久服务 token 密钥并采用独立域分隔，服务只持久化不可逆的 connection principal 摘要，不保存 handle 原文。新版 bridge 通过内部 v1 能力标记使用该 handle；未声明能力的旧客户端继续按原 token-level 兼容路径工作。bridge 进程重建或服务重启时提交同一 handle 才能恢复原 connection-only binding；没有 handle 的新 bridge 只能成为新连接，不能声明旧连接。服务 token 更换会明确拒绝旧 handle。既有认证 `principalHash` 语义保持不变，连接摘要只用于连接归属键，不能替代认证或反推出 token。

新表 `conversation_bindings`（schema 22 引入，23 保留同聊天的多任务绑定，24 添加持有类型和可显示定位信息）关联宿主聊天身份摘要、工作副本、工作会话、接力代际和撤销状态。一个工作会话最多一个未撤销聊天绑定；同一聊天接受新任务时不覆盖旧任务绑定，避免旧任务意外退回无身份兼容路径。默认查询最近明确关联的任务，写入按指定任务核验。工作副本的单一写入权限继续由现有 lease 约束。普通 context 查询不修改业务 revision、心跳或历史记录；用户确认的接手是单独记录、可审计的写入操作。

身份从每次 MCP `tools/call` 的宿主 `_meta` 提取，不读取继承的线程环境变量，不让模型填写，不以目录、PID或最新会话猜测归属。当前支持：

- Codex 原生 `_meta.threadId`，对应 [Codex 请求元数据实现](https://github.com/openai/codex/blob/main/codex-rs/core/src/mcp_tool_call.rs)。本次在真实原聊天的 MCP 进程中只读捕获并核对，与当前聊天 ID 一致；诊断未记录凭据，探针已移除。
- 其他宿主适配可提供 `_meta['io.ugk.cockpit/conversation'] = { host, id }`；host 是稳定的宿主命名空间，id 必须是本聊天的稳定身份，分叉聊天必须不同。此为接入契约，不代表所有第三方客户端已适配或实测。

当宿主没有提供稳定聊天元数据时，新版 bridge 使用签名 handle 对应的连接主体摘要作为 `connection` 类型绑定；同一 bridge 内短期凭据刷新或服务重启不再改变该身份。handle 当前只由 bridge 进程内持有，不写入项目共享目录，因此全新 bridge 进程不会自动继承它。未协商 handle 的旧客户端仍使用 scoped 凭据的不可逆摘要，新凭据会产生新连接身份。失去原 handle 的连接不能自动认领旧绑定，旧绑定仍作为“此前连接持有”显示，须正常接力或经用户确认接手。这个降级路径不替代宿主提供稳定聊天 ID。

身份仅用于在已认证的本机 MCP 通道内关联既有授权，首次查询不会凭聊天 ID 自动取得已有会话。它不是可向不可信远端开放的独立身份认证协议；普通工具参数不能注入该元数据或 HTTP 头。

上下文与接力响应中的 `bindingKind`、`bindingPersistence`、`bindingReason` 和 `capabilities` 描述当前事实，而不是历史回执的推断：不可变 receipt 只能证明曾经发生过的接力/确认，不能重新授权当前写入。`host` 绑定为 durable，`connection` 绑定为 connection-only，旧兼容路径明确标记为 legacy；读取、继续、写入、准备/恢复 relay 与 takeover 的能力按当前 binding 返回，不能因旧 schema 字段缺失而猜测。

服务与 bridge 为每个逻辑请求传递受限 `diagnosticId`，日志仅保留时间、版本、操作、结果、身份来源/识别状态、凭据事件及必要的 session/revision/reason/code，并按大小轮转。日志不记录请求体、token、handle、continueCode、原始 threadId、路径或异常原文；日志失败不影响业务响应。浏览器项目详情的近期诊断接口只按数据库中当前项目已有 session 读取固定轮转日志并再次脱敏，复制出的内容同样不含凭据或路径。

## 恢复、迁移与接力

1. 首次 init/accept 成功建立聊天绑定；恢复 Relay 时，接力消费、revision 变更、新绑定和旧绑定撤销在同一事务中完成。恢复请求的幂等意图包含宿主聊天身份，不允许另一个聊天借相同请求 ID 认领。
2. 同一聊天重建 MCP 或服务重启后，每次查询用宿主身份定位数据库绑定，再核对会话及接力代际。当前业务 revision 从数据库读取。
3. 同目录新聊天没有绑定，不能自动认领。旧聊天被新接力替代后，撤销记录保留；重启、查询最新 revision、重放旧 init/resume 都不能刷新旧权限。
4. 绑定恢复定位精确 session，不能被同目录另一 active/standby 会话替代。写入入口再次核对绑定；带业务会话的写入不会因少传宿主身份退回旧授权方式。工作说明在探测完成后从数据库读取可信归属。
5. 升级只为绑定添加持有类型和可显示定位列，不改写已有项目、运行、时间线或接力历史。旧会话在没有可靠宿主关联时保留原状态，需要一次明确确认、明确接手或正常 Relay 建立关联。不得从目录或聊天摘要批量推断历史归属。
6. 未发送稳定元数据的客户端使用受认证 MCP 连接的持久摘要；`bindingPersistence: connection_only` 表示恢复依赖原连接 handle（旧客户端依赖原 scoped 凭据），不承诺跨全新 bridge 自动恢复。失去该依据时须正常接力或由用户确认接手。已经迁移的会话不能通过无身份请求绕过绑定。应升级宿主适配，不在全局配置中写死一个聊天 ID。
7. 连接 handle、宿主 metadata 和 diagnosticId 都是 bridge/服务内部连续性信息；relay、progress、resume、takeover 等模型可见工具参数不携带这些字段。传输结果未知时保留原有 journal/clientRequestId 重放语义，不用新的身份字段猜测结果。

## 同类状态摸排

| 状态 | 当前存储及处理 |
| --- | --- |
| 项目、运行、时间线、Relay、写入归属 | 已持久化；本轮不删除、不重建 |
| 聊天绑定 | 平台持久化、代际撤销、持有类型与安全可显示的宿主定位信息 |
| 操作命令、提交/合并 attempts | 已持久化；prepared 合并重入在 Git 写入前重读当前送审与领取的状态和 revision，命令化回执以稳定 command id 重放，不因时钟变化产生冲突 |
| Git 索引锁 | 本轮记录并 fsync Cockpit 归属，真实进程终止后仅回收可证明原实例已退出、文件身份和内容仍匹配的锁 |
| 文件夹授权 | 已持久化，保留过期和一次性消费规则 |
| MCP 短期凭据、浏览器凭据 | 凭据可重新建立且不存原文；scoped MCP 凭据的不可逆摘要可作为 connection-only 绑定的关联键 |
| 并发 Promise、审核/探测缓存 | 可重新读取事实源或重新预检，不作为业务成果唯一记录 |

合并恢复沿用原始幂等请求。每次 prepared 重入都必须在实际 Git 写入前确认送审仍为 `approved`、领取仍为 `active`，且两者 revision 与冻结值一致；期间被拒绝、撤回或版本变化时返回冲突，不能继续冻结的 Git 计划。普通进展不应阻断恢复；会话终止、写入归属或 Relay 代际变化仍拒绝继续。实际 Git 写入前复核当前归属。

索引锁回收支持重新预检后的新 command，避免旧预检过期形成死路。存活或复用 PID、未知 Git 锁、被替换的文件身份/内容一律保留。历史空锁以及完整归属记录落盘前崩溃形成的不完整锁无法证明所有权，不能自动删除。

## 验证与运维

回归覆盖：有历史数据的 schema 21 升级、业务表前后逐行一致、重复打开、服务和 bridge 重建、同连接不同聊天隔离、active 与 standby 共存、旧聊天写入阻断、Relay 重试及另一聊天不能重放认领、稳定宿主的持有人展示/跨重启确认接手/旧聊天阻断、无稳定聊天 ID 的 connection-only 持有人跨服务重启恢复、备忘归属、普通 progress 后合并恢复、真实子进程 SIGKILL 后索引锁恢复且不重复提交/不丢无关暂存内容。

服务切换遵循 [本机服务恢复](LOCAL_SERVICE_RECOVERY.md)：SQLite backup API 一致性备份并检查完整性，核对实际监听进程和数据库，停止准确识别的旧服务后升级，再核对已有项目和历史。不得在服务运行期间覆盖数据库、删除 WAL 或重新 init。

schema 24 无需降级迁移。回退程序版本前必须确认它支持该 schema；旧版本会拒绝较新的数据库。使用备份恢复会舍弃备份之后的新增记录，不能把它当无损日常回退操作。

此前完整门禁和本机切换结果见 [当前阶段记录](PHASE1_VERTICAL_SLICE.md)。本次连接连续性优化的实现、验收及未部署边界见 [连续性优化记录](CONVERSATION_CONTINUITY_PLAN.md)。
