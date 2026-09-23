# MCP 宿主支持清单

核对日期：2026-09-23；源码版本：0.1.0-alpha.49。

连接 MCP、安装 Skill、识别当前聊天、成功恢复工作会话是不同的验收项。Skill 不能替宿主注入聊天身份，工作台转交也不能补齐缺失的宿主身份。

| 宿主 | 当前聊天身份来源 | 当前支持状态 |
| --- | --- | --- |
| Codex | 每次请求的 `_meta.threadId` | 已适配，保留既有验收记录 |
| ZCode | `_meta['com.zcode/request-context'].session_id`，以及命名空间存在时的镜像 `session_id` | 已适配，保留既有验收记录 |
| Antigravity IDE / CLI | `_meta['antigravity.google/conversation_id']` | alpha.48 新增身份适配；项目解析须按项目安装工作区插件（见下节，2026-09-23 本机实测通过并完成接力交接） |
| Claude Code | 尚无已验证的逐请求原生聊天字段 | 不能宣称完整接力支持；进程环境变量会过时 |
| Cursor | 尚无已验证的逐请求原生聊天字段 | 不能宣称完整接力支持 |
| Gemini CLI | 核对源码的 `_meta` 只有每次生成的 `progressToken` | 不接受进度编号作为聊天身份 |
| 自定义宿主适配器 | `_meta['io.ugk.cockpit/conversation'] = { host, id }` | 已支持通用协议，须由宿主按当前请求提供真实身份 |

## Antigravity 加载与验收

### 宿主形态（2026-09-23 实测核实）

Antigravity 的 MCP 登记全局只有一份，桥接进程是 Language Server 管理的常驻 daemon：**所有聊天共用一个进程**，其工作目录是宿主安装目录而非用户项目（经读取运行中桥进程的 PEB 核实）。`tools/call` 的 `_meta` 仅含 `antigravity.google/conversation_id`、`parent_conversation_id`、`agent_name`、`artifacts_dir` 四个字段（经官方二进制符号核实），没有任何工作区路径。因此「全局登记 + cwd 指向某个项目」无法区分聊天，按目录解析项目在此宿主上结构不可行；`artifacts_dir` 指向宿主内部缓存，不得用于推断项目。

### 正确接入方式：按项目安装工作区插件（2026-09-23 本机实测通过）

使用 Antigravity 官方插件机制（`.agents/plugins/`，见其内置文档 plugins.md 与 mcp_servers.md）按项目接入。在需要接入的项目根目录创建两个文件：

```
.agents/plugins/ugk-cockpit/plugin.json
  {"name": "ugk-cockpit"}

.agents/plugins/ugk-cockpit/mcp_config.json
  {"mcpServers":{"ugk-cockpit":{"command":"node",
   "args":["<Cockpit 仓库>/src/mcp/main.mjs"],
   "cwd":"<该项目绝对路径>"}}}
```

重启宿主后，该项目内的聊天由插件启动自己的桥进程，`process.cwd()` 即项目目录，项目解析、会话识别、接力全部沿用既有机制。每个要接入 Antigravity 的项目重复这一份两文件安装。**不要在全局 `~/.gemini/*/mcp_config.json` 登记 Cockpit**：全局登记只会让所有聊天解析到错误位置（本机已于 2026-09-23 移除）。更新 Cockpit 源码后须重启宿主让桥进程重载；无需重新 init。

验收分两步：先在目标聊天调用 `ugk_work_context({})`，核对返回的项目与绑定状态；有用户明确提供的接力指令时再执行该指令，只有返回的 sessionId、revision 和可继续状态才是恢复成功证据。身份被识别不自动取得已有工作会话的写权限。2026-09-23 本机按上述流程实测：播客项目装插件后项目解析正确，旧聊天完成接力、新聊天接手并正常写入进展。

### 事件记录

2026-09-22 曾发生一次未授权的源码热修：Agent 在 `src/mcp/main.mjs` 硬编码 cwd 重定向以绕过项目解析失败，当日回退（详见阶段记录）。上节宿主形态核实与插件接入方案即为该事件的根因收束。

### 历史验收记录

alpha.48 身份适配（2026-09-20）：本机 CLI 探针 `_meta` 为 `artifacts_dir`、`conversation_id`、`progressToken`；连续两次调用与重建 CLI 后恢复同一聊天的身份摘要相同，新聊天摘要不同，共 4 次真实调用通过；只使用聊天字段，不从 artifacts 目录推断身份。IDE 接力验收来自用户重载 MCP 后的现场确认，未另行取得其 sessionId/revision 回执。

## 其他常用宿主的已知边界

- [Claude Code 官方环境变量说明](https://code.claude.com/docs/en/env-vars)：MCP 子进程的 `CLAUDE_CODE_SESSION_ID` 保持启动时值；切换或恢复聊天可能不同于当前聊天。不能将其直接提升为持久聊天绑定。
- [Gemini CLI 固定版本源码](https://github.com/google-gemini/gemini-cli/blob/cfbcaa8df13ea4610bb379b377b56d62980c0032/packages/core/src/tools/mcp-client.ts#L1436-L1462)：`tools/call` 使用单次 `progressToken`，未提供稳定聊天 ID。此结论针对该源码状态，不代表未来版本永远不能支持。
- [Cursor 官方 MCP 文档](https://cursor.com/docs/mcp)：核对时没有可用于本功能的逐请求稳定聊天身份契约；不能臆造 composerId/conversationId 字段。

这些宿主仍可按现有权限进行只读查询。完整写入支持需要可验证的逐请求适配器，再通过不同聊天隔离、同聊天重连、接力后旧聊天失效与真实服务重建测试。不能用全局固定 ID、PID、工作目录或“最近会话”替代。
