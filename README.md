# UGK Cockpit

UGK Cockpit 是一个本机优先的个人 AI 开发控制台。它帮助用户在多个 Git 项目和多个 AI Agent 之间切换时，直接看见：现在谁在做什么、代码处于什么状态、哪里需要处理、下一步怎么继续。

## 让 Agent 帮你安装

把本仓库地址发给 Codex 或 ZCode，并说：

> 帮我按照 docs/AGENT_INSTALL.md 安装 UGK Cockpit，包括全部技能、MCP 连接和本机服务。验证完成后，带我开始使用。

已有本仓库的用户，也可以在程序目录执行对应命令（Windows 在 PowerShell、macOS 与 Linux 在终端中运行）。Linux 目前只覆盖服务与 MCP 安装路径：添加项目所需的原生文件夹选择器尚未实现（`FOLDER_PICKER_UNAVAILABLE`），需改用手动指定目录的入口，其余宿主能力与 macOS 一致：

```sh
# Codex
npm run setup:codex

# ZCode
npm run setup:zcode
```

安装器将准备工作台、安装包含全部技能和 MCP 的对应宿主插件，并复用已经正常运行的服务。若当前聊天需要重新连接才能加载工具，会明确提示；实际调用验证通过后才算可以使用。之后直接说“帮我打开 Cockpit”或“这个工具怎么用”即可。

目前提供 Windows 与 macOS 下 Codex 和 ZCode 两个安装入口，运行环境由 Agent 按[安装说明](docs/AGENT_INSTALL.md)准备；macOS 的宿主聊天内工具调用验收进度见该说明。已有手动安装发生冲突时保留原配置，先处理迁移；不会自动覆盖已有安装或重置项目。

2026-09-06 已按工作台试用反馈调整项目卡片、宽屏比例、时间线摘要、返回导航及 Logo，并修复提示语与加载占位重叠。完整问题清单和验证结果见 [工作台试用反馈](docs/WORKBENCH_FEEDBACK.md)。

## 当前版本

`0.1.0-alpha.54` — 审计修复（PR #20，合并提交 `542f82b`）：一次崩溃后的「工作副本生命周期围栏」不再永久锁死整个仓库——预约行、命令流水行与长期仓库锁现在可由用户一次确认同时结算（同一仓库只剩流水行时也可按命令逐条结算），并新增只读识别入口（此前该组合会让项目内所有写入会话永久返回占用且无产品内出路）；MCP stdio 桥不再被文本里的 U+2028/U+2029 截断分帧（一个换行类分隔符即可让已成功的写入拿不到回执、宿主因此重发）；`work/finish` 与 `work/handoff` 补齐请求体字段白名单（此前调用方可自填 `status`/`note`/`handoffId`，把会话结论改成枚举外的状态、绕过单条 4000 字预算、或自选持久主键）；代码位置重绑后同一目录不再以裸 `FOREIGN KEY constraint failed` 失败（工作副本 id 由指纹派生而指纹会被原地改写，现按位置解析到既有行）；工作说明的修改归属不再取「最新绑定」，无法证明时如实返回 `unattributed`；`conversation-control` 明面身份控制台改为仅浏览器会话可读（读路径同样遮蔽）；逃逸的未处理 Promise 拒绝按既有注释所述走正常关停而非常驻半坏状态；Windows 启动器不再吞掉参数里的 `!`（含 `!` 的数据目录会被静默改写成另一个空目录并回落到生产端口），并把端口真正交给服务进程；网页构建失败不再清空正在提供的工作台资源。本轮分支树 Windows 全量 684 项 0 失败（7 项平台跳过）、Phase 0 97/97、隔离 outDir 的网页构建通过；完整数字与遗留项见[阶段记录](docs/PHASE1_VERTICAL_SLICE.md)。

以下为 alpha.53 的记录：

`0.1.0-alpha.53` — 审计修复（PR #19，合并提交 `9a0f750`）：Windows 凭据助手参数改为 git 可实际执行的 `!` shell 形式（原带字面引号的格式使 helper 从不运行，Windows 上唯一凭据来源失效，认证类失败被误报为网络问题）；被拒绝的 `work/begin` 不再在报冲突后留下写锁与 active Run 的半状态（前置条件先于首个持久写入求值）；合并指令并发重放按 `commandId` 单飞行串行，并在三次写主仓库前复核仓库锁持有与有效期（注入时钟判定）；新增遗留「半开工作会话」的只读识别与显式收束运维小节。合并树 Windows 全量 664 项 0 失败、Phase 0 97/97。

以下为 alpha.52 的记录：

`0.1.0-alpha.52` — 审计修复（PR #18，合并提交 `1da1652`）：聊天归属凭据不再下发给非持有方（宿主/会话定位符默认遮蔽，返回 `identityWithheld: true`；持有方自证与工作台控制台仍可读）；交付索引锁改为「临时名写入 fsync 后硬链接发布」，消灭崩溃留下不可归属空锁卡死仓库的窗口，并新增真实进程终止回归；改派命令幂等键改按 `clientRequestId` 作用域，A→B→A 不再重放陈旧回执；`ugk_work_resume` 全面退役过期确认参数（schema/stdio/HTTP 一致）；路径守卫修复 `..` 前缀目录名误判；schema 29 迁移补表存在守卫。合并树 Windows 全量 654 项 0 失败、Phase 0 97/97。

以下为 alpha.51 的记录：

`0.1.0-alpha.51` — 接入指令即归属：接入/接力/接手入口工具在宿主桥进程无法解析工作目录时，以代理声明的工作区回退解析（`declaredWorkspace`），声明必须落在已登记项目内、不得覆盖可解析的工作目录事实，并与一次性指令的项目比对；操作台复制的接入指令自带「项目目录」提示行。全局一份 MCP 登记 + Skill 即可服务所有 Agent 的所有项目，无需逐项目配置（Codex/ZCode 行为不变）。协议细节见[会话身份与中断恢复](docs/CONVERSATION_DURABILITY.md)与[宿主支持清单](docs/MCP_HOST_SUPPORT.md)。

以下为 alpha.50 的记录：

`0.1.0-alpha.50` — 新增 `npm run setup:antigravity -- <项目绝对路径>`：一条命令把 Antigravity 工作区插件写入指定项目，该项目内的聊天即可正确解析项目并使用 Cockpit。alpha.51 起全局登记配合声明回退即可覆盖此需求，插件安装保留为可选的更严格模式。

以下为 alpha.49 的记录：

`0.1.0-alpha.49` — 修复 macOS 卷号漂移导致的身份误报并补上用户确认的代码位置重绑：目录身份指纹不再包含 device 编号，目录被真正替换（inode 变化）仍被拒绝；schema 30 迁移把健康机器上可精确重算的存量指纹原地改写为新格式，真漂移记录走浏览器确认的同路径重绑，同一仓库的全部工作副本一并重绑，活跃工作链一律拒绝确认。协议细节见[会话身份与中断恢复](docs/CONVERSATION_DURABILITY.md)。

2026-09-22 源码已合并至 main 并完成复审；本机服务仍运行 alpha.48 / schema 29，未迁移正式数据库。部署 alpha.49 需按规程备份并重启（重启即对正式库执行 schema 30 迁移），待用户授权后执行；已知限制与部署边界见[本机服务恢复](docs/LOCAL_SERVICE_RECOVERY.md)。

> 上面这行的「仍在 alpha.48 / schema 29」只是 2026-09-22 的现场快照，已经过期。正式库此后完成过 schema 29 → 30 迁移，当前实际运行版本、schema 与核对记录一律以[本机服务恢复](docs/LOCAL_SERVICE_RECOVERY.md)中最新的「部署验收」小节为准；本文件不重复登记运行版本，以免再次过期。

以下为 alpha.48 的宿主身份记录：

`0.1.0-alpha.48` — 补齐 Antigravity 原生 MCP 聊天身份识别，沿用既有持久绑定与接力协议。Codex、ZCode、Antigravity 的支持入口，以及 Claude Code、Cursor、Gemini CLI 的已核实限制，见[宿主支持清单](docs/MCP_HOST_SUPPORT.md)。自动安装与聊天身份支持分别验收，不把工具连接成功当成接力成功。

2026-09-20 已在本机部署 alpha.48，重启前后 10 个已有项目及全部详情核对正常；用户重载 Antigravity MCP 后确认测试通过。部署和备份记录见[本机服务恢复](docs/LOCAL_SERVICE_RECOVERY.md)。

以下为 alpha.47 的文件夹支持记录：

`0.1.0-alpha.47` — 添加项目支持空文件夹、资料文件夹和未使用 Git 的普通目录，无需代码文件或项目清单。只登记所选文件夹，不创建 Git 仓库、不修改已有文件；列表、详情、刷新和 AI 接入支持文件夹项目，版本状态未采集时如实显示。沿用 schema 29。

以下为 alpha.46 的历史修复与部署边界：

`0.1.0-alpha.46` — 独立安全审计修复：送审保存的 Git index 路径在写入前重新经过路径授权核验，Windows 文件夹选择器启动就绪纳入超时，损坏的送审预检记录不再阻塞后续预检；`merge --ff-only` 与 `merge-base --is-ancestor` 的尾随 revision 补齐对象 ID 断言，头像路由错误响应只透出受控文案，MCP stdio 桥补齐行长度上限、写失败兜底和凭据引导的关停信号；probe 通道对齐 maxBuffer 上限与专用错误码，WAL 连接设置不再依赖迁移分支。沿用 schema 29，无新增依赖。

本轮同时修正文档失实项：README 技能数量口径（六个 → 七个，含 `$cockpit`）、移除不存在的 `/api/health` 引用、DESIGN.md 导航枚举补「使用指南」，并补记 alpha.45 收束后遗漏的启动器修复 `d46ebc3`。验证与遗留项见[阶段记录](docs/PHASE1_VERTICAL_SLICE.md)。

本轮完成源码合并与文档收束，未重启本机服务或更新宿主插件。macOS 真实聊天工具调用和原生对话框人工点选仍待验收；跨平台验证及部署边界见[阶段记录](docs/PHASE1_VERTICAL_SLICE.md)、[安装说明](docs/AGENT_INSTALL.md)和[本机服务恢复](docs/LOCAL_SERVICE_RECOVERY.md)。未创建新发布标签或 GitHub Release；[alpha.41 预发布](https://github.com/mhgd3250905/ugk-cockpit/releases/tag/v0.1.0-alpha.41) 保留为历史发布入口。

alpha.44 的工作说明复制区、开发空间操作、工作线聚焦及顶部服务控制已于 2026-09-12 在本机更新并经用户验收；该记录不表示本轮 alpha.46 已部署。

2026-09-09 已发布 [alpha.40 预发布版本](https://github.com/mhgd3250905/ugk-cockpit/releases/tag/v0.1.0-alpha.40)，本机服务随后升级并核对 7 个已有项目及全部详情，用户确认使用指南页面正常。运行记录见[本机服务恢复](docs/LOCAL_SERVICE_RECOVERY.md)。插件中的新版对话指引仍需宿主更新并重新加载，服务重启不代表各宿主插件已同步更新。

保留 `alpha.39` 的工作节点持久记录平台与宿主会话 ID，接手成功本身就是新节点。异常转交由用户在工作台选择准确工作会话并授权：旧聊天立即冻结，新聊天凭一次性指令接手；支持定向授权、过期重签和明确取消恢复。聊天内两步 takeover 已关闭，正常 Relay 保留。ZCode 原生请求身份已接入；走错聊天时返回当前持有人和最新节点，未知历史不猜身份。本机服务当时已使用 schema 29（该状态已过期，正式库随后迁移到 schema 30，见上方 alpha.49 小节后的说明）；此前用户反馈原 ZCode 聊天接手后可写属于当时的现场验收，服务更新不代表宿主插件同步更新。协议与运维见[会话身份与中断恢复](docs/CONVERSATION_DURABILITY.md)和[本机服务恢复](docs/LOCAL_SERVICE_RECOVERY.md)。

保留轻量 Submit 工作说明：向所属项目发布说明，可以引用 PR、本地提交或其他分支的审核结果，不再默认保存上传或创建代码审核对象。说明发布不冻结分支，不结束会话，已有 progress 与 relay 照常推进。2026-09-03 的实现、切换及历史验收见 [Submit 工作说明](docs/SUBMIT_NOTES.md)。

保留 `alpha.34` 的审核长期保留与恢复修复：旧代码审核领取不因时间流逝失效，固定版本和审核状态变化仍须重新确认。历史实现与验收见 [统一送审](docs/UNIFIED_SUBMIT.md)。

保留 `alpha.33` 的独立项目详情页与多工作线时间线：真实接入回执才显示合流，点击节点或卡片可突出整条工作线。完整语义与验收边界见 [工作线时间线](docs/WORK_LINE_TIMELINE.md)。

保留 `alpha.31` 的本地收束与可选平台登记分离：没有会话信息或 MCP 不可用时，仍可整理文档、保存提交，并执行用户明确授权的普通 push。正式 handoff 仍须用户明确结束并通过平台校验。

当前开发版本以 `VERSION` 为准；版本与阶段验收的当前事实源是 [阶段记录](docs/PHASE1_VERTICAL_SLICE.md)。

2026-09-08 已合并工作台反馈及返工版本 `b523b386`，包含此前 PR #6 的修复。新增项目归档、手动关闭/重开工作线、按工作线查看上下文，以及工作副本复用/移除的并发保护和原请求恢复。独立全量 442/442、Phase 0 97/97、构建及差异检查通过；本机服务已从分支切回主项目并升级到 schema 27，7 个已有项目及详情正常。当时保留版本 alpha.39，未创建新发布；当前结果与既有遗留项见[阶段记录](docs/PHASE1_VERTICAL_SLICE.md)。

会话恢复的当前契约见 [会话身份与中断恢复](docs/CONVERSATION_DURABILITY.md)，alpha.32 历史计划见 [会话信息恢复](docs/SESSION_CONTEXT_RECOVERY.md)。升级后，运行中的本地服务及 Agent MCP 连接需加载新版；接手工具必填字段为 `sessionId/clientRequestId/transferCode` 才表示客户端已加载本轮接口。重新连接不等于重新 init，也不会结束平台已有会话。

保留 `alpha.30` 的送审内容范围修复：只送审已提交代码时，不读取无关工作文件内容；保存改动时仅对选中文件做内容检查。主项目里的截图、视频和未选中文件不再因体积过大阻塞送审，无需清理 build。用户确认的分支成果可以包含其他会话的提交，不冒称已验收，也不因换过会话拒绝接纳。

旧代码送审接口继续保留：不要求提前 init 或由平台创建分支，核对已登记项目、当前代码权限、本次文件范围及最新远端 main，再保存必要提交、普通推送并生成代码审核待办。其代码版本去重与旧审核失效规则只适用于旧审核对象，不适用于新的工作说明。

首次使用外部代码目录需在系统选择器中授权。审核可在隔离副本中进行，不占用正在开发的主项目；实际接入仍需用户授权，并满足原有干净工作区与 `ff-only` 门禁。远程 Agent 必须能连接本机 MCP 才能直接登记；不可连接时只能返回待接入交付信息，不共享本机 token。需求、阶段计划及验收记录见 [统一送审](docs/UNIFIED_SUBMIT.md)。

当前通过操作系统文件夹选择器（Windows 置顶对话框、macOS 系统对话框）逐个手动选择项目文件夹，不扫描工作区，也不自动导入项目。文件夹授权绑定路径和仓库身份，可在瞬时失败或 service 重启后安全恢复；浏览器会在写操作前安全续期，不重放写请求，也不会接触本地 API token。选择器由独立交互 helper 承载并保留硬超时，不会再让页面无限等待。

项目卡片现在统一通过 init 指令“交给 AI”：空项目、刚派发的新任务和已经开发到一半的项目使用同一入口。Agent 调用 `$cockpit-init` 后，Skill 通过 MCP 建立 active session；Cockpit 将调用时的代码状态作为接入基线，保留全部已有改动，并在存在标准交接手册时一并返回最近上下文。接入前的改动不会被自动归属给 Agent。

工作中的 AI 可通过 `$cockpit-progress` 主动记录进展；成功 commit、改变 `HEAD` 的 merge/rebase/cherry-pick、发布 tag 等有效 Git 检查点也会尽量自动记录，`status`、`diff`、`log`、`add` 和失败命令不会制造噪声。需要核对当前阶段 delta 时，用户显式调用 `$cockpit-closeout`；它先只读发现并核对适用项目入口声明的 canonical 来源，完整列出 tracked/untracked 状态和归属，绑定验证证据到 source state，只有 Preflight 通过后才修正确定的对齐项、运行必要验证，形成或复用本地 commit；普通本地收束与 commit 独立成功，具备活跃会话与 MCP 条件时可选记录一个非终态 progress 检查点，不因该 commit 再额外触发通用 progress，登记跳过或失败不阻断本地成果和已授权的普通 push。无法判定 canonical、归属或证据适用性等本地门槛缺失时只报告，不编辑或 commit。需要换聊天但继续同一阶段时，用户显式调用 `$cockpit-relay`；只有用户显式选择结束结果时，才调用 `$cockpit-handoff` 生成标准交接手册；选择 `completed` 会在同一手动 handoff 工作流中伴随执行或复用对当前 HEAD 仍有效的本地 closeout，不以 progress 回执为硬前置。功能完成、测试通过、Git commit 或上下文堆积都不会自动结束阶段。Cockpit 生成的短期接入与接力消息不含本地路径和 API token。

Phase 0 已验证的基础能力继续保留：

- SQLite Command journal、幂等和 revision CAS。
- 同一工作副本唯一写入会话。
- 重复或并发结束只产生一个不可变接手记录。
- 崩溃边界恢复，不产生“幽灵完成”。
- Windows 路径授权、junction/symlink 逃逸拒绝。
- 本地服务单实例锁。
- 同仓库多工作副本分别持有唯一写入会话，送审与主项目接入使用仓库级短锁串行化。
- 主项目只接入固定 source/target 代码保存点；不自动 rebase、reset、force push 或清理开发空间。

自动化测试只使用专门创建的临时仓库夹具（含跨盘验证目录）。用户明确打开项目文件夹后，产品读取必要的 Git 状态；用户确认后才登记到工作简报。普通查看、接入和新版工作说明发布不会修改项目文件；创建开发空间、保存上传代码与接入主项目各自需要对应的用户授权，平台不会自动清理或删除工作副本。

## 启动本地预览

要求 Node.js 24，最低 24.15.0（`>=24.15.0 <25`）：

```sh
npm install
npm run serve
```

Windows 用户也可运行 `launch-cockpit.cmd`，macOS 用户可执行 `./launch-cockpit.sh`；启动器会处理数据目录定位、Node 版本检查、必要的前端构建和后台运行。

然后打开 `http://127.0.0.1:41737`。数据默认保存在 Windows 的 `%LOCALAPPDATA%\UGK Cockpit`、macOS 的 `~/Library/Application Support/UGK Cockpit`、Linux 的 `$XDG_DATA_HOME/UGK Cockpit`（未设置时为 `~/.local/share/UGK Cockpit`）；也可以用 `--data-directory` 指定其他位置，安装器的 `dataDirectory` 返回实际使用的路径。项目代码不会被 Cockpit 自动清理、提交、上传或删除。

脚本可用 `curl http://127.0.0.1:41737/health` 免认证检查存活，响应包含 `status` 和 `version`。它不代表项目数据验收通过；受保护的 `/api/*` 接口仍需认证。浅克隆 `git clone --depth 1 https://github.com/mhgd3250905/ugk-cockpit.git` 可用于安装、运行及通常的后续更新；需要完整历史时执行 `git fetch --unshallow`。

启动验收还需确认已有项目列表及详情正常，不能仅检查 HTTP 200。不得在服务运行时覆盖数据目录；遇到项目突然消失，先按[本机服务数据一致性与故障恢复](docs/LOCAL_SERVICE_RECOVERY.md)排查，不要重新 init 或重新添加项目。

## 本机 MCP

MCP server 通过 loopback service 使用同一数据库事实源，不直接接触业务项目文件。可先手工验证：

stdio 入口通过服务已有的本机 MCP 认证通道获取凭据，不读取客户端 AppData 的服务私有凭据；认证失效后有限续期，原样保留业务请求和会话绑定。支持稳定聊天元数据的宿主在桥接进程重载后自动恢复持久绑定；无法证明当前身份与旧持有人对应时，必须由用户在工作台授权转交。缺少宿主身份的普通 MCP 不能新增工作节点，详见[会话身份与中断恢复](docs/CONVERSATION_DURABILITY.md)。

```sh
npm run mcp
```

手动接入时，stdio 配置执行 `node <仓库绝对路径>/src/mcp/main.mjs`。Codex 和 ZCode 安装入口通过各自宿主原生插件接口注册 MCP，无需用户填写程序路径；其他宿主仍需按各自配置方式接入。

## 配套 Skills

仓库内置七个 Skill：统一的 `$cockpit` 使用助手，以及六个面向用户动作的 Skill：`$cockpit-init`、`$cockpit-progress`、`$cockpit-relay`、`$cockpit-submit`、`$cockpit-closeout`、`$cockpit-handoff`。它们把 session、revision、幂等请求号、接力上下文和标准交接字段留在 Agent 与 MCP 之间，用户不需要记忆原始工具参数。聊天上下文遗失 session 信息时，`ugk_work_context` 会按当前代码目录重新核对平台状态；同目录候选不会自动接管。已有其他持有人时，用户可返回原聊天，或到工作台授权转交并将完整指令交给目标聊天；`ugk_work_takeover` 仅消费该授权。平台持久保存可靠宿主聊天身份；历史连接身份只读保留，不能根据同目录或时间相近认领。context 查询不改变业务会话、归属、租约、心跳或 revision，旧回执不恢复当前权限。`submit`、`closeout`、`relay`、`handoff` 都只能在用户显式动作中触发；closeout 聚焦本地收束与独立 commit 并可选登记检查点；`completed` handoff 的选择可伴随执行本地 closeout；`progress` 是唯一允许在有效检查点后自动触发的动作。主项目审核不另设 Skill，由项目页复制的标准提示词驱动 `ugk_integration_begin`、`ugk_integration_review`、`ugk_integration_merge`，确保平台收到规范回执。

推荐使用上方完整插件安装入口。仅需传统独立 Skills 安装时：

```sh
npm run install:skills:codex
```

安装器发现同名 Skill 时默认拒绝覆盖；确认这些目录可以更新后可执行 `npm run install:skills:codex -- --force`。其他兼容 `SKILL.md` 的 Agent 可运行 `node scripts/install-cockpit-skills.mjs --target <技能目录>` 指定自己的技能根目录；首版不会猜测或自动修改其他 Agent 的用户配置。

## 本地验证

要求 Node.js 24，最低 24.15.0（`>=24.15.0 <25`）：

```sh
npm test
npm run test:phase0
```

MCP 后端未新增生产依赖。

main 分支与外部 PR 由 GitHub Actions 自动运行同一组门禁（windows-latest / Node 24：全量 `npm test`、`test:phase0`、网页构建，见 `.github/workflows/ci.yml`）；macOS 与 Linux 尚未纳入 CI，平台结论仍以真机记录为准。

## 面向用户的首版目标

Phase 1 会交付最小网页闭环：添加项目、查看首页、开始或继续 AI 工作、创建独立功能开发空间、发布工作说明供主项目按需处理、显式结束并生成接手记录、处理未登记改动。旧代码审核与规范接入保留为独立能力，不是每条说明必须走的流程。普通路径不会要求用户填写项目 ID、worktree、分支、JSON 或 Git 命令。

详见 [路线图](docs/ROADMAP.md) 和 [产品语言规范](docs/PRODUCT_LANGUAGE.md)。
