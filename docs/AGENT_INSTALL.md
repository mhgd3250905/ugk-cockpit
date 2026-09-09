# 让 Agent 安装并开始使用 Cockpit

这份说明供收到用户“帮我安装这个工具”请求的 Agent 执行。自动安装目前支持 Windows 下的 Codex 和 ZCode。用户不需要理解 MCP 或记住技能名。

## 取得程序并安装

1. 在用户的软件目录取得本仓库。新安装可使用 `git clone https://github.com/mhgd3250905/ugk-cockpit.git`；已有目录先核对来源和状态，不能覆盖、清理或重置已有修改，也不要为了安装自动拉取合并。不要把用户的业务项目当成 Cockpit 程序目录。
2. 检查 Node.js（要求 Node.js 24，最低 24.15.0，即 `>=24.15.0 <25`）、Git 和当前宿主。Codex 需要支持 `codex plugin` 的 CLI；ZCode 使用其安装包自带的 CLI 与原生插件接口。缺少依赖时由 Agent 使用当前环境允许的官方安装方式准备；需要系统权限时说明具体缺失项。不得声称下载仓库即安装完成，也不能把 Codex 的配置格式套用到 ZCode。
3. 在 Cockpit 程序目录执行当前宿主的命令：Codex 使用 `npm run setup:codex`，ZCode 使用 `npm run setup:zcode`。安装器准备网页、启动或复用服务、核对数据库中的项目及网页详情，再通过宿主原生接口安装包含全部技能和 MCP 配置的插件。桥接进程由宿主启动，不要另起一个终端里的 stdio 进程作为“连接成功”的证明。
4. 按安装结果处理当前宿主连接。发现并真实调用 `ugk_work_context({})`；若宿主尚未加载插件，重连或开启新聊天后完成这一项。响应没有工作会话不代表安装失败，不能为验收而 init。若用户提供接力码，直接遵循 `cockpit-relay` 恢复，不先用 context 阻挡。
5. 加载统一入口 `cockpit` Skill，告诉用户“现在可以让我打开工作台，或介绍如何开始”。工作台左侧“使用指南”介绍全部七个技能的场景和可复制说法；用户也可直接问“各个技能怎么用”或“接力和结束有什么区别”。只给当前所需的下一步，教程咨询不执行示例中的业务动作。

新安装可在克隆命令中加 `--depth 1`。安装和运行不依赖完整 Git 历史，浅克隆通常也可正常获取后续更新；需要查看旧版本或处理较复杂的历史时，在程序目录执行 `git fetch --unshallow` 补全历史。升级前仍需核对本地修改和版本，浅克隆不改变这些要求。

## 命令

```powershell
# Codex 完整安装
npm run setup:codex

# ZCode 完整安装
npm run setup:zcode

# 仅检查并展示待执行步骤（按当前宿主选择）
npm run setup:codex -- --dry-run
npm run setup:zcode -- --dry-run

# 以后启动工作台，正常运行时直接复用（按当前宿主选择）
npm run setup:codex -- --start-only
npm run setup:zcode -- --start-only
```

安装器的 `host_verification_pending` 表示程序、插件和本机服务已准备好，当前聊天的实际工具调用仍需验证。不要把它转述为全部可用。最后向用户分别确认网页可用和聊天工具可用；尚缺的一步明确说明。

Codex 和 ZCode 的安装及 `--start-only` 结果提供 `dataDirectory`，表示服务实际使用的数据目录。Windows 默认位置为 `%LOCALAPPDATA%\UGK Cockpit`，设置了自定义目录时以返回路径为准；程序目录、插件目录与数据目录用途不同。

## 脚本存活检查

可执行以下免认证检查；也可将安装结果中 `serviceUrl` 的路径替换为 `/health`：

```powershell
curl.exe http://127.0.0.1:41737/health
```

响应包含 `status` 和 `version`。该端点只用于确认服务存活与版本，不代表已有项目和数据库核对通过，也不替代宿主实际工具调用验收。不要用 `/api/health` 作为免认证检查；`/api/*` 接口受认证保护。

## 已有安装与故障

旧版手工安装的同名 Skills 或 MCP 配置可能与插件重复。安装器发现冲突时会保留原配置并停止插件注册。先解释当前仍可使用旧安装，再提出有备份的迁移方案；不能自动删除、覆盖或使用 `--force` 掩盖冲突。MCP 不支持稳定聊天身份时，不能伪造身份或保证工作写入可用。

已运行服务版本不兼容、端口被占用或项目数据核对失败时，不能通过重启、清库、重新 init 或重新添加项目解决。按 [本机服务恢复](LOCAL_SERVICE_RECOVERY.md) 处理。安装器不会替换正在运行的服务；升级程序与迁移旧安装需要单独完成。

程序目录用于后续启动和维护，生成的插件目录用于 MCP 启动；安装后不能当成临时下载随手删除。数据库不打包到插件中，卸载插件不等于删除工作记录。当前没有发布到 npm，也没有宣称上述范围外的 Agent 或系统已通过安装验收。

## 维护者验收

构建入口 `node scripts/build-codex-plugin.mjs <输出目录>` 与 `node scripts/build-zcode-plugin.mjs <输出目录>` 从相同的仓库技能和 MCP 源码生成对应宿主的独立插件；不复制数据库、凭据、Git 或 node_modules。两宿主使用各自的输出目录，不能共用同一个安装源。插件内容版本来自 `VERSION` 和内容摘要，同内容重复构建可复用，不覆盖被改动的产物。清单源位于 `packaging/ugk-cockpit`，其本身不是可直接安装的成品。

ZCode 使用 `.zcode-plugin/plugin.json` 声明插件，marketplace 使用其兼容的 `.claude-plugin/marketplace.json` 与相对路径字符串来源。安装器调用 ZCode 原生插件接口，不伪造缓存与安装记录。ZCode 会给插件 MCP 添加宿主自己的命名空间；验收时按工具能力找到 `ugk_work_context`，不要因展示名称与 Codex 不同就重复添加独立 MCP。

ZCode 安装器优先使用已提供的 `ZCODE_CLI_PATH`，也可从 PATH 或正在运行的 ZCode 安装位置定位其内置 CLI。若未定位到程序，先打开 ZCode 再试；Agent 也可将该变量设为已核实的 CLI 文件位置。它只决定使用哪个程序，不携带凭据。ZCode 的 `plugins` 命令当前没有 install 子命令，因此安装器使用其原生 app-server 插件管理接口；不能改写为猜测的 `zcode plugin install` 命令。日常 `--start-only` 不需要重新定位或安装宿主插件。

验证至少包括：隔离 Codex 配置中的真实插件安装和重复安装、仓库外 MCP 初始化、全量 `npm test`、Phase 0 门禁，以及真实宿主中的工具调用。命令行打包测试不能证明宿主提供了项目目录和聊天身份；后两项必须按实际宿主返回事实判断。

Codex 原生插件安装方式依据本机 `codex plugin --help` 与 [OpenAI 插件文档](https://learn.chatgpt.com/docs/plugins)。

### 2026-09-09 本地验收

Windows、Node.js 24.15.0、Codex CLI 0.144.4 的隔离配置中，真实安装、重复安装、版本更新和 MCP 注册均已通过。完整安装入口复用了本机已有服务并核对项目数据，没有替换用户现有配置；统一入口也被 Codex 的提示词预览发现。

`npm test` 通过 466 项；新增测试文件及后续调整另外按安装专项复验，17 项全部通过；`npm run test:phase0` 通过 97 项。生成插件清单和入口 Skill 验证通过。首次启动编排另由真实子进程、随机端口和一个已有项目的数据库夹具验证。

尚未执行用户真实新聊天中对新插件的工具调用验收；这一步不能由隔离安装、MCP 列表或命令行初始化替代。本轮未发布远端，也未迁移用户已有手动安装。

### 2026-09-09 ZCode 本地验收

Windows、Node.js 24.15.0、ZCode CLI 0.16.5 的隔离用户目录中，原生安装、重复安装和同一安装源的版本更新均已通过；宿主返回全部 7 个 Skills 和已启用的插件 MCP。完整安装入口复用了已有服务并核对项目数据，日常启动入口的只读检查通过，没有修改用户真实 ZCode 配置。

`npm test` 通过 469 项；ZCode 安装与打包专项按最终修改复验，10 项全部通过；`npm run test:phase0` 通过 97 项。共享的 Codex 打包测试与统一入口 Skill 验证通过。

ZCode 新聊天中对已安装插件的实际工具调用仍待验收。本轮只形成本地实现与提交，未发布远端，也未在用户真实配置中安装或迁移插件。
