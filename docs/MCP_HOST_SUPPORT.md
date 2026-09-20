# MCP 宿主支持清单

核对日期：2026-09-20；源码版本：0.1.0-alpha.48。

连接 MCP、安装 Skill、识别当前聊天、成功恢复工作会话是不同的验收项。Skill 不能替宿主注入聊天身份，工作台转交也不能补齐缺失的宿主身份。

| 宿主 | 当前聊天身份来源 | 当前支持状态 |
| --- | --- | --- |
| Codex | 每次请求的 `_meta.threadId` | 已适配，保留既有验收记录 |
| ZCode | `_meta['com.zcode/request-context'].session_id`，以及命名空间存在时的镜像 `session_id` | 已适配，保留既有验收记录 |
| Antigravity IDE / CLI | `_meta['antigravity.google/conversation_id']` | alpha.48 新增适配；本机 CLI 实际请求已验证；2026-09-20 用户重载 IDE MCP 后确认接力测试通过 |
| Claude Code | 尚无已验证的逐请求原生聊天字段 | 不能宣称完整接力支持；进程环境变量会过时 |
| Cursor | 尚无已验证的逐请求原生聊天字段 | 不能宣称完整接力支持 |
| Gemini CLI | 核对源码的 `_meta` 只有每次生成的 `progressToken` | 不接受进度编号作为聊天身份 |
| 自定义宿主适配器 | `_meta['io.ugk.cockpit/conversation'] = { host, id }` | 已支持通用协议，须由宿主按当前请求提供真实身份 |

## Antigravity 加载与验收

已有 MCP 配置指向本仓库 `src/mcp/main.mjs` 时，更新源码后在宿主 MCP 管理界面重新加载该服务器，让桥接进程加载新解析器。仅重启 Cockpit HTTP 服务不能替代桥接进程重载。若使用复制出的安装包，应先更新包内源码；无需重新 init。

没有配置时，按 [Antigravity 官方 MCP 文档](https://antigravity.google/docs/mcp) 配置 stdio 服务器：command 为 Node.js 可执行文件，args 指向 Cockpit 的 `src/mcp/main.mjs`，cwd 指向用户已登记且明确选择的项目目录。不要共享 token，也不要让模型填造聊天 ID。多项目配置必须明确对应目录，不根据最近聊天猜位置。

验证分两步：先在目标聊天调用 `ugk_work_context({})` 核对身份识别与绑定状态；有用户明确提供的接力指令时再执行该指令，只有返回的 sessionId、revision 和可继续状态才是恢复成功证据。身份被识别不自动取得已有工作会话的写权限。

本机实际 CLI 探针收到的 `_meta` 字段为 `antigravity.google/artifacts_dir`、`antigravity.google/conversation_id`、`progressToken`。连续两次调用与重建 CLI 后恢复同一聊天的身份摘要相同，新聊天摘要不同，共 4 次真实调用通过；临时探针配置已移除。只使用聊天字段；不从 artifacts 目录推断身份。本机 IDE 程序包含同名字段，程序字段和 CLI 探针本身不代表 IDE 业务验收；2026-09-20 的 IDE 接力通过来自用户重载后的现场确认，未另行取得其 sessionId/revision 回执。

## 其他常用宿主的已知边界

- [Claude Code 官方环境变量说明](https://code.claude.com/docs/en/env-vars)：MCP 子进程的 `CLAUDE_CODE_SESSION_ID` 保持启动时值；切换或恢复聊天可能不同于当前聊天。不能将其直接提升为持久聊天绑定。
- [Gemini CLI 固定版本源码](https://github.com/google-gemini/gemini-cli/blob/cfbcaa8df13ea4610bb379b377b56d62980c0032/packages/core/src/tools/mcp-client.ts#L1436-L1462)：`tools/call` 使用单次 `progressToken`，未提供稳定聊天 ID。此结论针对该源码状态，不代表未来版本永远不能支持。
- [Cursor 官方 MCP 文档](https://cursor.com/docs/mcp)：核对时没有可用于本功能的逐请求稳定聊天身份契约；不能臆造 composerId/conversationId 字段。

这些宿主仍可按现有权限进行只读查询。完整写入支持需要可验证的逐请求适配器，再通过不同聊天隔离、同聊天重连、接力后旧聊天失效与真实服务重建测试。不能用全局固定 ID、PID、工作目录或“最近会话”替代。
