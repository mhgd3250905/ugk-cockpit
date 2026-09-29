# MCP 宿主支持清单

核对日期：2026-09-25。本文不复述任何版本号——当前开发版本以 `VERSION` 与[阶段记录](PHASE1_VERTICAL_SLICE.md)为准，那类复述在 2026-09-25 一天的两次提版本里就失效过；下表记录的是各宿主能提供哪些 `_meta` 字段，这类宿主能力不随小版本变化。宿主能力本身若要重新核对，请按[本机服务恢复](LOCAL_SERVICE_RECOVERY.md)的流程在当前运行版本上重跑，不要按本文的核对日期推断线上版本。

下表按宿主记录的是 `_meta` 字段形状，alpha.52 未改变各宿主能提供哪些字段，因此结论仍然有效。但从 alpha.52 起平台对外的**呈现方式**发生了变化：聊天归属凭据不再下发给非持有方，宿主/会话定位符默认遮蔽并返回 `identityWithheld: true`。逐宿主的真机验收**尚未在 alpha.52 及之后的版本上重跑**；需要定位符明文时按[本机服务恢复](LOCAL_SERVICE_RECOVERY.md)的流程重新核对。

连接 MCP、安装 Skill、识别当前聊天、成功恢复工作会话是不同的验收项。Skill 不能替宿主注入聊天身份，工作台转交也不能补齐缺失的宿主身份。

| 宿主 | 当前聊天身份来源 | 当前支持状态 |
| --- | --- | --- |
| Codex | 每次请求的 `_meta.threadId` | 已适配，保留既有验收记录 |
| ZCode | `_meta['com.zcode/request-context'].session_id`，以及命名空间存在时的镜像 `session_id` | 已适配，保留既有验收记录 |
| Antigravity IDE / CLI | `_meta['antigravity.google/conversation_id']` | alpha.48 新增身份适配；alpha.51 起全局登记 + declaredWorkspace 声明回退即可用（见下节），按项目插件为可选严格模式 |
| Claude Code | 尚无已验证的逐请求原生聊天字段 | 不能宣称完整接力支持；进程环境变量会过时 |
| Cursor | 尚无已验证的逐请求原生聊天字段 | 不能宣称完整接力支持 |
| Gemini CLI | 核对源码的 `_meta` 只有每次生成的 `progressToken` | 不接受进度编号作为聊天身份 |
| 自定义宿主适配器 | `_meta['io.ugk.cockpit/conversation'] = { host, id }` | 已支持通用协议，须由宿主按当前请求提供真实身份 |

## Antigravity 加载与验收

### 宿主形态（2026-09-23 实测核实）

Antigravity 的 MCP 登记全局只有一份，桥接进程是 Language Server 管理的常驻 daemon：**所有聊天共用一个进程**，其工作目录是宿主安装目录而非用户项目（经读取运行中桥进程的 PEB 核实）。`tools/call` 的 `_meta` 仅含 `antigravity.google/conversation_id`、`parent_conversation_id`、`agent_name`、`artifacts_dir` 四个字段（经官方二进制符号核实），没有任何工作区路径。因此「全局登记 + cwd 指向某个项目」无法区分聊天，按目录解析项目在此宿主上结构不可行；`artifacts_dir` 指向宿主内部缓存，不得用于推断项目。

### 正确接入方式：全局登记 + 声明回退（alpha.51 起，2026-09-23）

Antigravity 只需**全局一份** MCP 登记（与 Codex/ZCode 同等的安装体验）：在全局 `mcp_config.json` 注册 stdio 服务器，command 为 Node.js，args 指向 Cockpit 的 `src/mcp/main.mjs`，无需设置 cwd，也不需要任何逐项目配置。项目归属由一次性接入指令确定：操作台生成的接入/接力/转交消息自带「项目目录」行；宿主桥进程的工作目录解析不到项目时，入口工具（context/init/resume/takeover）接受把该目录作为 `declaredWorkspace` 传入——声明必须落在已登记项目内并与指令所属项目比对，错配拒绝；可解析的工作目录事实优先，声明不得覆盖。Codex/ZCode 不受影响（其工作目录天然正确，无需声明）。

可选的更严格模式：`npm run setup:antigravity -- <项目绝对路径>` 为项目写入官方工作区插件（`.agents/plugins/ugk-cockpit/`，幂等；保留插件配置内的其他 MCP 服务器；拒绝覆盖外来插件；不可读配置须 `--force`）。插件让该项目内聊天经自己的桥进程以正确工作目录启动，从而完全不走声明路径；alpha.51 之前这是唯一可行方式（2026-09-23 按插件方案实测通过并完成接力交接）。

不要共享 token，也不要让模型填造聊天 ID。**不要在全局登记里为 Cockpit 设置指向某个项目的 cwd**：全局登记是所有聊天共用的，那样会让每个聊天都解析到同一项目。更新 Cockpit 源码后须重启宿主让桥进程重载；无需重新 init。

验收分两步：先在目标聊天调用 `ugk_work_context({})`（全局登记的宿主如报「没有可识别的工作目录」，按消息中的「项目目录」行带上 `declaredWorkspace` 重查），核对返回的项目与绑定状态；有用户明确提供的接力指令时再执行该指令，只有返回的 sessionId、revision 和可继续状态才是恢复成功证据。身份被识别不自动取得已有工作会话的写权限。2026-09-23 本机以插件方式实测：播客项目解析正确，旧聊天完成接力、新聊天接手并正常写入进展；alpha.51 的声明回退路径由 `test/declared-workspace.test.mjs` 端到端验证，alpha.51 已于 2026-09-23 部署（见[本机服务恢复](LOCAL_SERVICE_RECOVERY.md)），但全局登记的现场验收仍未补记，仍是待办。

### 事件记录

2026-09-22 曾发生一次未授权的源码热修：Agent 在 `src/mcp/main.mjs` 硬编码 cwd 重定向以绕过项目解析失败，当日回退（详见阶段记录）。上节宿主形态核实与插件接入方案即为该事件的根因收束。

### 历史验收记录

alpha.48 身份适配（2026-09-20）：本机 CLI 探针 `_meta` 为 `artifacts_dir`、`conversation_id`、`progressToken`；连续两次调用与重建 CLI 后恢复同一聊天的身份摘要相同，新聊天摘要不同，共 4 次真实调用通过；只使用聊天字段，不从 artifacts 目录推断身份。IDE 接力验收来自用户重载 MCP 后的现场确认，未另行取得其 sessionId/revision 回执。

## 其他常用宿主的已知边界

- [Claude Code 官方环境变量说明](https://code.claude.com/docs/en/env-vars)：MCP 子进程的 `CLAUDE_CODE_SESSION_ID` 保持启动时值；切换或恢复聊天可能不同于当前聊天。不能将其直接提升为持久聊天绑定。
- [Gemini CLI 固定版本源码](https://github.com/google-gemini/gemini-cli/blob/cfbcaa8df13ea4610bb379b377b56d62980c0032/packages/core/src/tools/mcp-client.ts#L1436-L1462)：`tools/call` 使用单次 `progressToken`，未提供稳定聊天 ID。此结论针对该源码状态，不代表未来版本永远不能支持。
- [Cursor 官方 MCP 文档](https://cursor.com/docs/mcp)：核对时没有可用于本功能的逐请求稳定聊天身份契约；不能臆造 composerId/conversationId 字段。

这些宿主仍可按现有权限进行只读查询。完整写入支持需要可验证的逐请求适配器，再通过不同聊天隔离、同聊天重连、接力后旧聊天失效与真实服务重建测试。不能用全局固定 ID、PID、工作目录或“最近会话”替代。
