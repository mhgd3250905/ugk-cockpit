# Phase 1 首个可用垂直切片

- 目标版本：0.1.0
- 面向用户：同时推进多个项目、把任务交给不同 AI、不了解内部数据模型也能使用的人
- 核心承诺：打开后 10 秒内知道先处理什么；添加项目、开始工作和结束工作都不要求 Git 知识

## 实施状态

- `0.1.0-alpha.1`：Project Registry、一次性且可恢复的文件夹授权、同源浏览器会话、首次添加项目、晨间简报首页。
- `0.1.0-alpha.2`：本地服务重启后自动恢复浏览器会话；写操作先续期且只发送一次，避免用户处理“身份已失效”或重复写入。
- `0.1.0-alpha.3`：以“文件资源管理器当前唯一打开的文件夹”为可靠主路径；原生选择器失联时 30 秒内安全返回，不再无限卡住。
- `0.1.0-alpha.4`：恢复真正的逐项目手动选择；选择器使用置顶的独立交互 helper，不扫描工作区、不自动导入项目。
- `0.1.0-alpha.12`：提供 `$cockpit-init`、`$cockpit-progress`、`$cockpit-handoff` 三个配套 Skill，网页新入口统一生成 initCode。
- `0.1.0-alpha.13`：新增 `$cockpit-relay`、`ugk_work_relay` 与 `ugk_work_resume`，让用户显式把上下文接到新聊天，同时保持原 active session、revision 链和写入权限。
- `0.1.0-alpha.14`：把 cockpit-relay 准备输出固定为可原样复制的标准恢复指令，以 MCP continueMessage 为唯一事实源，摘要与复制块严格隔离，resume 自动返回已存 relayContext。
- `0.1.0-alpha.15`：完成专业 Mission Control 前端重构，界面由真实状态驱动并支持响应式与无障碍；修复 assignment/reissue/interrupted/paused 状态下的安全问题，新增 `PRODUCT.md` 与 `DESIGN.md`。
- `0.1.0-alpha.16`：移除 false liveness 与服务重启导致的中断推断；Dashboard 仅依据明确会话节点展示状态，服务重启不修改 active run 的 health，现存 recovery_uncertain 数据在普通界面统一作为 active work 处理。
- `0.1.0-alpha.17`：移除 Dashboard 置顶大卡，所有项目直接进入统一行动状态分组矩阵，每个项目仅渲染一次；引入四套直观且克制的状态背景色与色彩强调边框。
- `0.1.0-alpha.18`：主界面项目卡片只保留必要概览；新增按需加载的大尺寸项目运行详情和最新在上的 `init / progress / relay / handoff` 节点时间线，结合可证明的 Git 分支/提交上下文、响应式布局、键盘焦点管理与减少动态效果降级。
- `0.1.0-alpha.19`：Windows 原生文件夹选择器升级为 COM `IFileOpenDialog` 文件夹选择模式，支持资源管理器导航与 Client GUID 位置记忆，根除 Windows PowerShell 5.1 下的中文乱码，保留置顶交互与非错误取消语义。
- `0.1.0-alpha.20`：项目详情弹窗按 4 秒节奏自动刷新并保留已加载历史；relay 节点增加等待/已接手状态和实际接手时间，同一 Cockpit session 的新会话恢复不再表现为缺失，也不生成虚假的新 INIT。
- `0.1.0-alpha.21`：progress 改为一句摘要加结构化详情，服务端在事件发生时采集并固化分支/HEAD；旧 note 原文保留并折叠展示，不对历史 Git 状态作事后推断。
- `0.1.0-alpha.22`：RELAY/HANDOFF 默认收束为摘要、状态、Git、下一步和数量概览，完整上下文按需展开；新 RELAY 固化服务端 Git 证据，并修复 INIT/HANDOFF 可信快照被误标为未确认的问题。
- `0.1.0-alpha.23`：新增 `$cockpit-closeout` 阶段收束检查点；它只核对已知阶段 delta、确定的 canonical 对齐项和必要验证，并以本地 commit SHA 记录一个非终态 progress 检查点，不因该 commit 重复记录。relay 准备只复用已知未对齐项，completed handoff 在同一手动工作流中必须先执行或复用对当前 HEAD 仍有效的 closeout；三者均须用户显式触发。
- `0.1.0-alpha.24`：收紧 `$cockpit-closeout` 的两阶段门禁；Preflight 必须从适用项目级 `AGENTS.md` 与根 README/等价入口一跳发现并核对当前 canonical source，完整核对 tracked/untracked 归属并绑定验证证据到 source state；来源、归属或证据无法证明时 fail closed，成功报告分开 Agent alignment 与 MCP-verified Git/session 事实。
- `0.1.0-alpha.25`：前端改为深色优先控制台视觉，提供「亮色 / 暗色 / 跟随系统」三档手动切换与 localStorage 持久化。色值全量转换为语义设计令牌，状态色收敛为左侧色条与徽标；项目卡片改为紧凑三行结构，时间线收敛节点色与强调形状，中文字重规范为 400/600/700 并禁用负字距；首绘前同步脚本注入主题与 color-scheme，Vite 构建版本号自 package.json 自动派生。
- `0.1.0-alpha.26`：补齐 INIT 节点的规范化展示，以接入时的工作目标作为摘要，完整 currentState 收入“查看接入状态”折叠区；历史记录无需迁移即可避免长段文字占满时间线，并继续保留基线 Git 证据。
- `0.1.0-alpha.27`：交付平台持有的多开发空间生命周期。用户从项目详情选择空目录创建通用功能空间，空间会话通过 `$cockpit-submit` 显式保存并普通 push；主项目待办提供一键复制审核提示词，以固定 SHA、独占 claim、revision CAS 驱动领取、审核和 `ff-only` 接入。接入的本地保存、远端 push 与不可变回执可从崩溃或网络失败恢复，平台不自动 rebase、reset、force push 或清理空间。
- `0.1.0-alpha.28`：修复开发空间创建入口依赖历史项目观察值的问题。用户选定空目录后，平台先只读复核主项目身份与当前 Git 状态，将最新观察写入项目记录，再把该 HEAD 作为创建 CAS 基线；只有复核与创建之间确有并发提交时才继续安全停止。
- `0.1.0-alpha.29`：统一受管空间与外部分支的显式送审入口。新增 `ugk_work_submit_preflight`，先核对已登记项目、目录授权、交付文件范围、最新远端 main 与真实合并冲突，再通过 `ugk_work_submit` 精确保存、普通推送、固定 SHA 登记待办。无 session 不要求重新 init，也不接管旧写入权限；新版使旧审核失效，审核可在隔离副本进行。完整边界与验收见 [统一送审](UNIFIED_SUBMIT.md)。
- `0.1.0-alpha.30`：修正预检误读源/目标无关文件的范围问题。已提交代码按提交对象检查，待保存内容仅检查选中文件；主项目未跟踪素材不再触发送审体积上限。Skill 不以聊天归属限制已确认的分支成果，也不建议清理 build 绕过平台问题。
- `0.1.0-alpha.31`：将 `$cockpit-closeout` 的本地两阶段收束与可选平台进度登记解耦。缺少可信会话或 MCP 不可用时不阻断本地文档整理、commit 和已明确授权的普通 push；基线可来自已记录的任务起点或明确版本记录。解除 closeout 元数据的必需 MCP 依赖，同步 handoff/progress 文案；正式 handoff 仍保留 active session、revision CAS 与 `cockpitVerified: true` 门槛。不修改生产 API、数据库 schema 或送审/合并逻辑。
- `0.1.0-alpha.32`：新增 `ugk_work_context` 只读恢复会话信息。bridge 记住接入绑定，服务端按当前已授权代码位置核对会话及最新 revision；无绑定时只展示候选，经用户明确确认后建立当前客户端的临时绑定。接力代际变化使旧绑定失效，查询不修改平台会话、lease、心跳或 revision。同步 relay/progress/handoff 与 closeout 可选登记规则，不要求因聊天缺编号重新 init；不改变 submit 无需提前接入的契约。方案及验收见 [会话信息恢复](SESSION_CONTEXT_RECOVERY.md)。
- `0.1.0-alpha.33`：运行详情时间线按稳定工作副本绘制多条工作线，移除跨副本 `branchChanged` 推断；开发空间来源显示为轻量来源锚点，未知来源独立归轨，真实 `integrated` 回执才绘制接入主项目关系。新增整条工作线聚焦与“显示全部”，并以紧凑 Metro smooth-step 绘制带统一受限圆角的分叉/接入路径，保留分页、详情展开、深浅主题、减弱动效和窄屏多轨行为；项目卡片进入独立项目详情页并使用正常页面滚动。实现与验收边界见 [工作线时间线](WORK_LINE_TIMELINE.md)。
- `0.1.0-alpha.34`：审核领取不再按时间失效，修复领取/结论重试和 HTTP 至 MCP 的恢复信息传递。继续保留固定版本、唯一审核领取、状态 CAS 与明确合并授权。全量测试 250/250、Phase 0 89/89、独立定向验收 40/40 及 Web 构建通过；运行中的服务尚未切换。方案与验收见 [统一送审](UNIFIED_SUBMIT.md)。
- `0.1.0-alpha.35`：轻量 Submit 工作说明，本地实现与验收完成；2026-09-03 已切换运行服务、页面资源与用户级 `cockpit-submit` Skill，已有客户端须重连 MCP 并重新加载 Skill。发布说明与代码保存上传、旧审核对象及会话生命周期分开；项目待办支持复制、标记处理、归档与恢复，不增加冻结、领取或退回流程。`npm test` 289/289、Phase 0 90/90、隔离构建、Skill 校验及浏览器实测通过，Antigravity 独立复核通过。完整契约与本轮验证记录见 [Submit 工作说明](SUBMIT_NOTES.md)。
- `0.1.0-alpha.36`：会话绑定由平台持久保存，支持宿主身份的聊天重连恢复，保留接力代际失效；修复合并中断恢复与自有 Git 索引锁恢复，见 [持久性契约](CONVERSATION_DURABILITY.md)。
- 当前小步：会话持久绑定与中断恢复服务已升级，当前 Codex 需重连 MCP 加载新版适配器并确认旧关联；工作台界面继续等待用户试用反馈。跨机 MCP 可达性、托管平台合并 API、清理或删除工作副本仍不在本次默认动作内。

### alpha.35 工作台与本机认证收束（2026-09-05）

本轮基线为本会话开始时的 `9c50e0af76bb0587a1f85a14db88250fddb8a24a`；Preflight HEAD 为 `6785b7adda2abcf8b50358fa3ccd8a870ea8199d`。阶段内 2 个提交、18 个路径：`97ceec10afd08077a90d9c03fc6a5566873a40b6` 保存界面重构、服务恢复约束及最初的认证重读修复，`6785b7adda2abcf8b50358fa3ccd8a870ea8199d` 进一步消除 MCP 对客户端与服务共享同一认证文件的依赖。完整工作区检查为暂存 0、未暂存 0、未跟踪 0；阶段改动均来自本会话及用户授权移交的认证修复。

当前工作台采用固定项目导航、按状态分组的真实进展项目行、默认工作线页签及当前工作侧栏；工作说明和开发空间保留原行为。石墨暗色与雾灰亮色、项目切换及聚焦等反馈动效已实现，保留减弱动效设置和既有时间线归属、来源、合流及分页规则。当前产品与视觉规范分别见 [PRODUCT.md](../PRODUCT.md)、[DESIGN.md](../DESIGN.md)，实现与浏览器检查见 [工作台重构记录](WORKBENCH_REDESIGN.md)。**用户仍在使用测试，尚未最终确认界面体验；后续按用户反馈优化。**

原 ZCode 聊天持续 401 的直接原因已实测为同路径下不同的凭据文件。MCP 入口现使用服务已有的 loopback 专用认证通道，失效后有限续期；不读取客户端 AppData 的服务私有凭据，不重新 init 或改变会话版本与写入归属。原聊天已验证恢复原 active 会话及 revision 17；此次没有代其确认绑定或提交 Relay。文件视图分离的具体 Windows 机制尚未查明，不能将认证机制修复描述为修复了全部底层文件异常。详细证据见 [MCP 认证恢复记录](MCP_AUTH_RECOVERY.md)；数据库维护继续遵循 [本地服务恢复记录](LOCAL_SERVICE_RECOVERY.md)。

验证绑定：2026-09-05 的 `npm test` 333/333（exit 0，约 539 秒，含 Phase 0）对应 `6785b7a` 的生产与测试实现，测试后仅补充注释与事实记录；`npm run build:web`、独立审查及浏览器检查对应 `97ceec1` 的前端源码，`97ceec1..6785b7a` 未改变前端、版本或依赖，故仍适用。此次 closeout 仅对齐 README 与本阶段记录，复用上述验证，另检查文档链接、版本字段与 diff。未升级依赖、迁移数据库、修改业务项目、创建发布标签或推送远端；版本字段继续一致为 `0.1.0-alpha.35`。主 JS 包约 600kB（gzip 约 193kB）的构建提示保留为已知限制。

### alpha.33 工作线时间线与验收（2026-09-03）

本轮在 alpha.32 基线之上补充只读工作线投影和前端多轨图。事件按 `worktreeId`/开发空间身份归轨，来源未知不猜测；`RELAY` 保持原轨；集成关系只接受带 `integrated_commit` 的 `integrated` 回执。分叉和接入使用约 2px 的 Metro smooth-step 路径，首尾沿实测竖轨短段切入/切出，圆角半径受轨距与纵向落差限制。定向夹具覆盖交错副本、同名工作线、未知来源、分页和真实/非真实回执；浏览器实际检查覆盖轨道聚焦、分叉与接入回流、显示全部、详情控件、刷新/分页、窄屏和主题。局部时间线/几何用例 8/8、`npm test` 236/236、`npm run test:phase0` 89/89、`npm run build:web` 和 `git diff --check` 均通过。无数据库迁移、无新生产依赖、未修改业务项目。

本阶段基线为本会话 UI 工作开始时记录的 `3d50efc40c7255d01822dd49f6a66103b625c13a`；首轮工作线图实现与验证对应 `b220ea7c2738c93f3a85ec763506172c89890620`。阶段内随后完成 `459eaae63127dee964e48ad1b02a8d8e49caeb4f` 的节点/连接居中修正和旧固定偏移 helper 测试调整，以及 `97144cd1d0266d7d8963c4b6fd24108ce53ba9f3` 的项目详情路由页。最终实现验证对应 `97144cd1d0266d7d8963c4b6fd24108ce53ba9f3`；本次 closeout 仅对齐文档，不改变生产代码。最终 `npm test` 234/234（exit 0），总数由首轮记录的 236 降为 234 是因为 459 提交删除了两项已失效的固定偏移 helper 测试，并非失败或跳过；`npm run build:web`、`git diff --check` 均通过。41737 实际页面验证了 `#/projects/<projectId>` 直达、刷新、前进后退、返回列表、详情展开、深浅主题和 640px 窄屏，详情使用正常页面滚动且无详情 modal/遮罩。此前 `npm run test:phase0` 89/89 对应首轮工作线实现；459/971 后续涉及前端、测试调整与文档，未改变 Phase0 生产路径或其测试，89/89 仍适用。无数据库迁移、无新生产依赖、未修改业务项目。

### alpha.32 会话恢复与验收（2026-09-03）

基线 `6ca91e92f5430ad848b15e8a5880567d679e5522`，起点工作区干净。Luna Max 实现只读 context、bridge 临时绑定和接力代际校验，主会话复核并补齐自动绑定及确认后复查的真实客户端验证。新增 MCP 工具和 HTTP 查询路由，补充 init/accept 响应的 worktreeId；无数据库迁移、生产依赖或业务仓库改动。

本轮工作树验证：核心临时项目链路 2/2；MCP/技能受影响检查 23/23；既有 relay、MCP-first、stdio 启动检查 5/5；最终 `npm test` 229/229、`npm run test:phase0` 89/89，均 exit 0。四个技能格式校验、三个实现文件语法检查、`git diff --check` 和 `npm run build:web` 通过。六个 Cockpit 技能的仓库、共享目录及 Codex 安装副本正文和元数据 SHA-256 一致。完整计划及证据见 [会话信息恢复](SESSION_CONTEXT_RECOVERY.md)。

本地服务已加载 alpha.32；空参数只读查询找回已有 active 会话和 revision 20，新 bridge 无绑定时正确要求确认。更新服务和查询前后会话、租约、接力状态与操作记录数量摘要不变，schema 19、完整性正常。未对真实会话执行确认、relay、init 或 progress；旧 MCP 连接仍需重新连接以发现新工具，此操作不等于重新 init。

### alpha.31 收束与验收（2026-09-03）

本轮基线 `33e547f4948af8411d264e4314c34473e98fec75`，依据为本次规则修复开始前已保存的 alpha.30 交付；仅收束 closeout/handoff/progress 技能、对应当前说明、版本字段及既有送审实测补记。起点工作区干净；本轮 10 个已跟踪文件修改分别来自 Antigravity 的规则修复和宿主的版本/验收记录，无新增未跟踪交付文件。未修改生产源码、API、数据库 schema、安装器或业务仓库。

Luna Max 与 Antigravity 并行核对影响面，宿主确定规则边界后由 Antigravity 实施（`task-20260903-030106-bee064`）；宿主指出回执不确定不能冒充登记失败后，由新任务 `task-20260903-030742-c1e17a` 精确修正。最终技能保留本地来源/归属/证据门槛，分开报告本地成果、已授权 push 结果与可选平台登记；终态 handoff 仍须可信会话、revision 和 `cockpitVerified: true`。

验证对象为上述基线加本次提交的技能工作树：`node --test test/cockpit-skills.test.mjs` 最终 12/12 通过，技能校验与 `git diff --check` 通过。该专项是既有契约/安装器检查；实际决策边界另由宿主复核，不将文字匹配测试当作真实 MCP 成功证明。3 个技能正文及 closeout 元数据已精确同步共享 `.agents/skills` 和 Codex `.codex/skills`，三方 SHA-256 一致。`npm run build:web` 通过，运行服务健康检查为 `0.1.0-alpha.31`，schema 仍为 19、完整性正常，服务更新前后业务记录数量一致。未重复全量/Phase 0 回归；alpha.30 的送审验证仍对应未变化的生产代码，真实送审及无会话去重证据见 [统一送审实测](UNIFIED_SUBMIT.md)。

当前上下文缺少最近 MCP 返回的可信会话信息，本轮不调用 progress、不重新 init 或接力，平台检查点未登记；这不否定本地收束，也不阻塞用户已明确授权的普通 push。平台登记状态与 Git 提交/上传结果分别如实报告，不以服务健康检查冒充 MCP 检查点回执。

## 产品方向：晨间工作简报

首页不是工程监控大盘，而是一张每天早上可以直接照着行动的简报。

首屏只回答三件事：

1. 哪个项目最需要我处理？
2. 为什么？
3. 我现在按哪个按钮？

当前视觉采用石墨暗色、雾灰亮色和克制的橙色强调；以常驻导航、清晰排版及短促交互反馈组织日常工作。状态颜色不能单独承载含义，必须同时有文字与动作。历史纸张与卡片矩阵方案不再作为当前视觉基线。

## 首日流程

### 1. 首次打开

空状态只有一个主按钮：`添加第一个项目`。

用户点击“选择项目文件夹”，在置顶的 Windows 系统窗口中亲自选择一个项目。Cockpit 一次只处理这个明确选择的文件夹；取消不会创建记录，不扫描父目录或工作区，也不自动导入其他项目。普通流程不提供手填绝对路径。

### 2. 自动识别

选中后系统只读检查：

- 是否是一份可识别的代码；
- 是否与已经添加的项目重复；
- 当前有没有尚未纳入版本记录的本地改动；
- 这份代码是否在已授权文件夹内，身份是否稳定。

只有一个明确候选时自动选中。用户只确认项目名称，默认取文件夹名；阶段默认 `开发中`。技术详情折叠显示。

### 3. 首页

项目按行动意义分组，而不是按内部状态枚举分组：

- `需要你处理`：身份变化、未归属改动、同时编辑或状态读取失败；
- `工作会话`：存在已经接入且尚未交接的 AI 工作会话；
- `可以继续`：没有阻断，可开始下一段工作；
- `暂时放下`：用户主动暂停。

项目总览按行展示名称、人话状态、最近记录时间、真实进展摘要与可用动作；左侧可搜索和切换项目。详情默认打开工作线，工作说明、开发空间置于独立页签，右侧展示当前工作和最近代码检查，原始技术信息按需展开。

### 4. 交给 AI 与继续

主按钮为 `交给 AI` 或 `继续工作`。用户选择 Agent，也可以填写一句当前目标。Cockpit 创建短期一次性 initCode，并生成调用 `$cockpit-init` 的可复制消息。系统先做只读预检：

- 有本地改动：默认保留并标记为“开始前已有改动”；
- 另一个 AI 正在编辑：默认只读，不自动接管；
- 存在尚未交接的旧会话：保持“会话已接入”，展示最近确认节点；只有用户显式 relay、handoff 或 takeover 才转换状态；
- 代码位置身份变化：停止，要求用户重新选择，绝不自动重绑。

消息复制后页面只显示“等待 AI 接入”。AI 在当前项目目录调用 `ugk_work_init`，校验项目绑定并保留现有改动后显示“会话已接入”；这只确认接入节点，不声称 Agent 进程持续在线。最近交接存在时随 init 返回。工作中通过 `$cockpit-progress` 报告里程碑。阶段需要收束时，用户可显式调用 `$cockpit-closeout`：AI 先从适用项目级 `AGENTS.md` 与根 README/等价入口一跳发现当前 canonical source，再核对当前阶段 delta、完整 tracked/untracked 归属和绑定到 source state 的验证证据；Preflight 通过后才修正确定的对齐项、运行必要验证，形成或复用本地 commit。普通本地收束与 commit 独立成功；具备 active 会话与 MCP 条件时可选登记指向本地 commit SHA 的非终态 progress 检查点，不因该 commit 再额外记录，登记跳过或失败不阻断本地成果和已授权普通 push。来源、归属或证据无法证明等本地门槛缺失时只报告并停止。上下文堆积时，用户可显式调用 `$cockpit-relay`：准备只复用已知事实和本阶段已观察到的未对齐项，不扫描全仓、运行测试、修文档或创建 commit；新聊天调用 `ugk_work_resume` 继续同一工作会话，恢复模式不执行对齐检查。只有用户显式选择结束阶段时，才通过 `$cockpit-handoff` 收束；选择 `completed` 时在同一手动 handoff 工作流中伴随执行或复用对当前 HEAD 仍有效的本地 closeout 成果，不以 progress 回执为硬前置，`blocked`/`abandoned` 不要求 closeout。普通用户不需要理解 MCP、heartbeat、lease、revision 或 snapshot。

### 5. 结束工作

用户明确要求结束当前阶段并选择结果后，AI 才通过 `ugk_work_handoff` 提交标准交接字段、建议技能和文件引用。选择 `completed` 时，在同一手动 handoff 工作流中先执行或复用对当前 `HEAD` 仍有效的本地 closeout 成果（而非必须存在 progress 回执）；若本地 closeout 未完成，不得进行 completed handoff，向用户报告并等待处理。选择 `blocked` 或 `abandoned` 不要求 closeout，只如实携带未解决事项。系统重新只读采集代码状态并保存可供下一次直接读取的交接手册；网页并列显示“Agent 报告”和 Cockpit 验证结果，最终确认与接管仍由用户完成。

如果出现外部代码保存点、未归属改动、工作线变化或检查中状态变化，不能显示“已完成”，必须解释原因并给出安全动作。

## 安全授权模型

- 网页只能通过本地 service 访问数据，不能直接读写 SQLite。
- Windows 系统选择器中由用户亲自选择的文件夹产生一次性授权凭证；注册成功后保存该代码位置的明确授权。选择器运行在独立交互 helper 中并有硬超时。
- 本地 API 使用 HttpOnly、SameSite=Strict 会话 Cookie；token 不暴露给页面脚本。
- 注册和刷新都复用 Phase 0 的真实路径、仓库 identity、Git metadata scope 和有界 probe。
- 首日路径不执行清理、删除、checkout、merge、reset、覆盖或自动提交。

## 0.1.0 数据与接口

新增最小实体 `Project`：名称、阶段、代码位置、仓库/工作副本 identity、最近观察、创建时间和更新时间。

最小接口：

- `POST /api/v1/folders/select`：打开置顶的 Windows 系统选择器，返回用户明确选择文件夹的短时一次性授权；
- `POST /api/v1/projects`：消费授权，探测并注册未知项目；
- `GET /api/v1/dashboard`：返回按行动意义组织的项目卡片；
- `POST /api/v1/projects/:projectId/assignments`：创建等待接手任务和一次性接手码；
- 本机 stdio MCP 的普通路径使用 `ugk_work_context`、`ugk_work_init`、`ugk_work_progress`、`ugk_work_relay`、`ugk_work_resume`、`ugk_work_submit_preflight`、`ugk_work_submit`、`ugk_work_handoff`；主项目审核提示词使用 `ugk_integration_begin`、`ugk_integration_review`、`ugk_integration_merge`。context 只读恢复权威会话信息，不创建或接管会话。阶段 closeout 以本地收束为主，具备条件时可选调用 `ugk_work_progress` 记录一个非终态检查点，不因 closeout commit 再额外触发通用 progress。`ugk_work_accept`、`ugk_work_begin`、`ugk_work_finish` 暂留作旧客户端兼容，共 14 个工具。服务端从一次性代码、接力码、session 或已授权送审来源解析项目和代码位置；查询及送审 cwd 只由 MCP bridge 注入，不允许 Agent 自填任意路径。
- Phase 0 Run API 继续作为内部状态机，不让 MCP 参数携带任意路径、projectId 或接管权限。

所有错误继续满足：发生了什么、是否影响代码、推荐下一步。

## 小步提交顺序

1. `feat: add project registry migration and domain`
2. `feat: add one-time folder grant and project APIs`
3. `feat: serve authenticated local web shell`
4. `feat: add first-project onboarding`
5. `feat: add morning briefing dashboard`
6. `feat: connect MCP-first assignment lifecycle`
7. `test: add zero-training journey gates`

每一步必须保持 `npm test` 全绿，且不得读取或修改五个业务项目；0.2.x 才以只读方式接入它们。

## 用户验收门禁

- 首次添加未知项目最多 3 个主要步骤，目标 60 秒内完成。
- 首页 10 秒内能指出一个最需要处理的项目、原因和下一步。
- 普通流程不出现 Repository、Worktree、HEAD、Dirty、Run、Lease、Snapshot、JSON。
- 没有持久化确认时不显示“已保存”；离线数据必须带最后更新时间。
- 有开始前改动时默认保留，错误归属给当前 AI 的次数必须为 0。
- 同一代码位置的第二个写入会话默认被拒绝；接管必须二次确认。
- 存在尚未交接的旧会话时，不得因 heartbeat、记录时间或 service 重启推断中断或完成；只展示最近确认节点，并通过显式 relay、handoff 或 takeover 转换。
- 错误仓库和同路径替换 100% 拒绝自动重绑。

## 进入实现前的依赖决策

推荐使用 React + Vite 构建产品界面，原因是后续会有文件夹授权、离线/恢复状态、Run Lite 和多项目筛选等持续交互；相比手写 DOM，它更容易维持可测试的状态边界。后端继续保持 Node 内置模块与 SQLite，不新增数据库依赖。

这是新增生产依赖，需要用户明确确认后再安装。若不希望引入依赖，也可以用原生 HTML/CSS/JavaScript 完成 0.1.0，但后续复杂交互的维护成本更高。


## 2026-09-05 会话持久绑定与中断恢复

本轮修复及兼容边界见 [会话身份与中断恢复](CONVERSATION_DURABILITY.md)。界面仍处于用户试用期。本轮新增 schema 22 聊天绑定表，schema 23 保留同一聊天的多任务绑定，并修复合并中断恢复和可证明归属的 Git 索引锁恢复；不重建已有运行记录。定版全量 `npm test` 338/338（exit 0，677.00 秒）、Phase 0 92/92（exit 0）、Web 构建通过；Relay 技能契约说明更新后定向 12/12 通过。构建保留既有主 bundle 大于 500 kB 的提示，本轮没有扩展界面性能优化。

12:32 首次迁移至 schema 22，26 张既有业务表内容摘要完全一致。12:47 最终服务通过已有启动器切换到 alpha.36 / schema 23（PID 50588），再次一致性备份后核对全部 27 张既有表，内容摘要完全一致；6 个项目、17 条运行、25 条任务、125 条进展、21 条接力保留（期间其他项目正常新增 1 条进展）。完整性与外键检查通过，项目列表及 Cockpit/手腕详情接口正常。

真实 Codex 原请求已核对包含原聊天的 `_meta.threadId`。停止旧 MCP PID 42164 后，当前宿主本轮未自动重连，返回 `Transport closed`；需要在 Codex 重新连接 MCP 加载新版适配器。旧会话首次持久关联的明确确认仍待用户回答，当前未写入任何业务会话或生成新 Relay。独立重启夹具已通过，不将其冒充原聊天端到端验收。

工程约束已写入 AGENTS.md；仓库与 Codex/共享安装副本的 cockpit-relay 仅更新绑定持久性的说明，保留原确认与接力成功判据。未修改产品仓库代码，未 push 或创建标签。
