# Phase 1 首个可用垂直切片

- 目标版本：0.1.0
- 面向用户：同时推进多个项目、把任务交给不同 AI、不了解内部数据模型也能使用的人
- 核心承诺：打开后 10 秒内知道先处理什么；添加项目、开始工作和结束工作都不要求 Git 知识

## 实施状态

2026-09-10 外部审查修复轮（分支 `fix/audit-p0-lease-and-rebinding`）：全量 `npm test` **486/486**，Phase 0 **97/97**，`npm run build:web` 通过；独立只读审查两轮 + 统筹复审一轮返工后通过。实测验证并修复两项 P0：一是 HTTP 服务此前不校验 Host 头，DNS rebinding 域可取得首页会话 Cookie 并读取项目数据，现所有请求在接触任何响应体、Cookie 或凭据面之前按本机地址白名单（`127.0.0.1`/`localhost`/`[::1]` 且端口匹配监听端口）校验，域外 Host 一律 421 `HOST_REJECTED`；二是崩溃残留写租约此前只能经"工作台签发转交 → 新聊天接手 → 正常结束"这一条较重的路径恢复，对没有登记工作链的旧运行记录则完全无路可走，新增用户确认的 `releaseOrphanedWriteRun` 与 `POST /api/v1/runs/release-lease` 只面向这类无 assignment／聊天绑定／转交记录的旧运行记录：run 置 `abandoned` 并删除租约，revision 与 lease_generation 双重 fencing，`userConfirmed`、受管理拒绝与各结果均落命令日志，worktree 路径授权与 start/finish 同构，MCP token 不可调用；受管理工作链（含待转交状态）一律拒绝直接释放并保持可取消/可接手，必须走既有工作台转交协议，统筹复审曾用独立夹具证实无守卫版本会令转交链卡死（消费/取消/重签全部 `SESSION_NOT_ACTIVE`）。崩溃窗口由事务回滚保证、同命令可安全重放。同轮加固：api-token 改唯一随机临时名 + fsync + rename 原子写并以真实 SIGKILL 残留验证恢复（旧固定 `api-token.<pid>.tmp` 命名在 PID 复用时会阻塞启动），probe `git()` 补默认 5s/2MB 超时与输出上限，unsafe host 错误不再回显 URL。沿用 schema 27，无数据迁移，不改变既有认证边界。遗留：工作台 UI 的释放入口待下一迭代。

2026-09-09 alpha.40 发布前验收：全量 `npm test` **478/478**，Phase 0 **97/97**，安装器及版本专项 **24/24** 通过。生产网页构建、入口 Skill 格式校验、差异检查通过；独立只读审核无阻断。桌面浏览器验证指南入口、返回总览、刷新保留路由、全部七项内容、复制成功与失败反馈以及明暗主题显示。浏览器使用独立开发端口，不以该预览的项目列表或连接状态作为已有服务数据验收；当时没有重启正式服务或更改数据库。旧插件需更新并由宿主重新加载才能获得新版对话指引。本版本沿用 schema 27，不新增数据迁移。

发布与部署已完成：`v0.1.0-alpha.40` 标签和 GitHub 预发布指向 `b31618c51dbc7752d0d6302ca6059dbe3539a9af`，推送后远端 main 与标签目标一致。随后按用户要求使用原数据目录重启本机正式服务，备份验证、7 个已有项目和全部详情核对通过，服务返回 alpha.40；用户确认使用指南页面正常。详见[本机升级验收](LOCAL_SERVICE_RECOVERY.md)。

本次显式 closeout 基线为安装反馈修复开始前的 `9a84a40cb2873e8b0d5f36690e173c6ea3399796`，Preflight HEAD 为上述发布提交；增量 1 提交、16 文件，全部为本会话已授权实现。根 AGENTS/README 一跳确认版本、安装说明、阶段记录及本机恢复记录为当前来源；此前安装与部署段落按历史保留。完整工作区暂存、未暂存及未跟踪均为 0。仅对齐 README、安装说明、阶段记录和本机恢复记录中的发布后事实，不改源码、依赖、版本、现有发布标签或业务状态；工作会话保持继续。

证据绑定：2026-09-09 本会话执行 `npm test` 478/478、`npm run test:phase0` 97/97、`node --test test/setup-codex.test.mjs test/setup-zcode.test.mjs test/phase0/version.test.mjs` 24/24；新增指南随后完成 `npm run build:web`、桌面浏览器验收及 `python -X utf8 C:/Users/29485/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/cockpit` 校验，最终源码保存于 `b31618c51dbc7752d0d6302ca6059dbe3539a9af`。全量测试不作为浏览器交互测试的替代；本次仅文档差异不改变已验证的代码与构建输入，版本文档断言另行复验。

收束验证：四份文档对齐后，`npm test -- --test-concurrency=4 --test-name-pattern='VERSION, package metadata'` 与 `git diff --check` 通过；前者仅验证匹配的版本断言，其余测试文件加载不计作全量业务复验。既有全量、Phase 0 和构建证据因源码未改继续适用。

- `0.1.0-alpha.40`：提供 Codex / ZCode 原生插件安装入口，包含统一引导及全部 7 个 Skills 和 MCP。新增桌面工作台“使用指南”（`#/guide`），展示七个技能的场景、步骤、可复制说法和结果；内置 `cockpit` 可对话讲解，教程咨询不触发业务操作。按异机安装反馈统一 Node.js 范围为 `>=24.15.0 <25`，安装、启动及预览返回实际 `dataDirectory`；未认证请求提示兼顾浏览器和脚本，文档明确已有 `/health` 存活检查与浅克隆支持。保留 schema 27 和现有认证边界。

- `0.1.0-alpha.39`：schema 25 持久工作节点、宿主平台/会话 ID、工作台授权转交及冻结/消费/取消。关闭聊天内异常接手旁路，接手成功立即形成新节点，错误聊天返回当前持有人与最新节点；ZCode 原生身份已接入。保留历史未知归属、正常 Relay、幂等和 Git 副作用前权限复核。代码部署和技能切换完成，用户已反馈原 ZCode 聊天接手后可写。

- `0.1.0-alpha.38`：context 在已有持有人时返回可解释的持有人摘要；新增用户确认的 `ugk_work_takeover`，在 revision CAS 下撤销旧绑定、写入审计并转移写权限。无稳定聊天 ID 的 MCP 把受认证连接摘要持久化为 connection-only 归属，服务重启后提示确认接手，不再退化成无主会话。随后补齐可靠性边界：送审缓存使用真实临时路径；prepared 合并在 Git 写入前重新核验送审批准与领取 revision；命令回执以稳定 command id 重放；陈旧单实例锁串行回收；浏览器将非 JSON 服务响应投影为标准连接错误。

- `0.1.0-alpha.37`：接力断线重试、过期码在当前聊天显式确认恢复、持久确认与并发归属保护；区分从未接手与已被替代的聊天。启动器传递明确数据目录并核对已有项目列表及详情。

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
- 当前小步：工作台反馈与复用/移除恢复已合并部署，当前 schema 27；项目归档、手动工作线记录和按工作线查看上下文可用。工作台仍处于试用期，跨机 MCP、托管平台合并 API 和自动清理不在本轮范围。工作副本移除仅由用户明确操作，并保留并发和恢复检查。

### 独立审计修复与复验（2026-09-09）

外部审计在 `b523b386` 基线上确认并修复 7 项缺陷，每项先经真实复现证实，再从根因修复；新增 `test/audit-2026-09-09.test.mjs` 七项回归（审计者用 `git archive main` 验证这些测试在旧代码上逐项失败，确认真实锁定）。

1. **P0 安全（Git 传输协议自授权）**：仓库本地配置 `protocol.ext.allow=always` 配合 `ext::` 远端 URL，可在 Cockpit 的提交、集成及 delivery 探测路径上执行任意命令（已复现命令被执行）。修复：`probe.mjs` 的 `SAFE_GIT_PREFIX` 显式逐协议 deny（ext/git/http/ftp/ftps）并 allow file/https/ssh，`delivery-ops.mjs` 弃用本地副本改用同一前缀；提交与集成 push 在联网前用 `git remote get-url --push` 解析实际推送 URL（覆盖 pushurl/pushInsteadOf 重写与多 URL 远端）并执行与 delivery 相同的 `validateRemoteUrlSecurity`。注意 git 会先读具体键 `protocol.<name>.allow` 再读泛化 `protocol.allow`，仅设泛化键无效。
2. **P1 凭据卫生**：`validateRemoteUrlSecurity` 四条拒绝消息内嵌原始 URL，畸形 URL 携带的密码进入错误流（已复现）。修复：错误文本不再回显 URL。
3. **P1 稳定性（MCP stdio EOF）**：宿主关闭 stdin 不触发 onShutdown，in-flight 服务调用不被中止、进程滞留至超时（挂起服务实测滞留 >8 秒）。这正是此前台账记录“宿主 stdin EOF 自动触发中止未完成”的遗留项，本轮完成：readline `close` 接线到与 `close()` 相同的幂等 shutdown 路径；stdout/stderr 挂 error 监听并用 try/catch 包裹写出，防宿主销毁管道时 EPIPE 崩溃。
4. **P1 契约（传输层过窄）**：HTTP 64KB 上限小于 stdio 网关/核心对 relay/handoff（约 2.9MB）、finish acknowledgements（约 400KB）、preflight files（约 205KB）等合法载荷的宽度，大载荷必被 413 拒绝且“原样重放”承诺失效（复审实证）。修复：全部 MCP 工具路由统一以 18MB 上限读取（覆盖最坏 `\uXXXX` 转义），session bootstrap 与浏览器路由保持 64KB。
5. **P2 数据诚实**：probe 的 `headRelation` 把 merge-base exit 128（历史不可读）折叠为 `diverged`。修复：128 归类为 `unknown`，完成门禁保持 fail-closed，被替换仓库场景仍返回精确的 `WORKTREE_IDENTITY_CHANGED`；delivery-ops 两处同型 merge-base 不再接受 128 当拓扑答案。
6. **P2 可用性（delivery index 锁）**：acquire 写失败遗留半写锁文件，同进程（pid 存活）永远无法回收；release 抛错会掩盖 finally 之前的真实业务结果。修复：acquire 失败时清理自建工件（带 dev:ino 身份核对）；release 改为尽力而为、不抛错。
7. **P2 资源**：MCP 桥 401 重试路径在确认发起第二次请求后显式取消被弃响应体，避免 keep-alive 连接滞留至 GC。

2026-09-09 于本分支复验：`npm test` **449/449**（507.73 秒）、`npm run test:phase0` **97/97**，全部通过，无失败或跳过。独立审查线程（只读）按需求完整性、逻辑正确性、边界情况、代码质量、测试覆盖、实际运行六维复核；其提出的两项必须修复（delivery 前缀缺口、finish 路由上限）与 pushInsteadOf 绕过已修复并补测，一项“终轮 401 未消费”经核实为误报（两条响应路径都会读取 body）。版本保持 `0.1.0-alpha.39`，schema 不变。

返工轮（同日，复审第二轮回馈）：① 多推送地址漏检——`git remote get-url --push` 只返回首个 pushurl，仓库可在后续 pushurl 藏自授权自定义 helper（实测首个远端已收到提交、helper 已执行后 push 才报错）；修复为 `--push --all` 在任何推送前逐一校验全部实际目的地。② 合法相对路径远端被误拒——`isLocalPath` 以服务进程 cwd 判断裸相对路径，与 git 按 worktree 解析的行为不一致；修复为 `validateRemoteUrlSecurity`/`isLocalPath`/`normalizeRemoteIdentity`/`readDeliveryLocation` 全链路传入 worktree cwd。两项均按“回归先红后绿”执行，新增两条回归覆盖提交与集成双路径；返工后 `npm test` **451/451**（447.37 秒）、`npm run test:phase0` **97/97**、`git diff --check` 通过。

审计证实但记录为残留/后续项：push 超时只杀死直接 git 子进程，ssh 等孙进程可完成传输导致“报失败但远端已更新”（需进程组方案）；saveDelivery 复制→rename 覆盖 index 窗口内用户并发暂存可被静默回滚（工作区文件无损）；MCP 声明支持 2025-03-26 协议但拒绝批次数组（如需兼容须实现批处理分发）；stdio 行读取无单行长度上限；会话身份 (host, id) 由宿主元数据声明、本机进程可伪造，本地信任模型内为既有边界，跨信任域部署前必须重评；`web/src/assignment-copy-flow.mjs` 重试成功后旧失败提示未清理（既有 P3，未动）；`core.sshCommand=ssh` 会覆盖仓库本地自定义 ssh 命令（与既有中和全局配置的路线一致）。

审计同时证伪以下怀疑，不改代码：目标环境（Windows/Node 24.15）execFile 超时返回 `code=null/signal=SIGTERM`，与退出码 1 可区分；Git 2.50 中仓库本地 `url.*.insteadOf`/`pushInsteadOf` 不会劫持 fetch 校验层可见的 URL（push 侧已由 `--push` 校验覆盖）；`_meta.threadId` 非字符串硬失败是测试覆盖的显式 fail-closed 契约。

### 工作台反馈合并、部署与收束（2026-09-08）

阶段基线为本轮复审开始时 main 的 `990e231c40378e3ace68df27c08ae9fe8722378d`；复审及合并 HEAD 为 `b523b38602905d739c4540d0291b8466e66d74bb`。基线是 HEAD 祖先，增量为 5 个提交、32 个路径，涉及工作台界面、手动记录、工作线上下文、Git 工作副本操作、schema 26/27、恢复契约及回归测试。用户授权后 main 无冲突快进并普通推送，远端 SHA 一致。

新增项目归档及非主工作线手动关闭/重开，记录以事务、独立 revision 和幂等命令保存，不冒充 AI 交接或真实合流。上下文按工作线读取可信会话与代码观察，历史未知保持未知。工作副本复用/移除保留用户显式操作、干净状态和活动工作检查；schema 27 增加持久操作占用及代际检查，覆盖异步 Git 窗口。浏览器先保存完整原请求，刷新或服务中断后继续恢复，未知结果不清除恢复材料。

原审查两项阻塞已修复：操作检查后新会话抢入的并发窗口，以及操作已生效但页面丢失原请求后无法恢复。2026-09-08 主会话在固定 HEAD 的隔离副本执行 `npm test -- --test-concurrency=4` **442/442**（337.44 秒）、`npm run test:phase0` **97/97**（121.33 秒）、`npm run build:web` 与 `git diff --check`，全部通过，无失败或跳过。回归包含历史迁移、真实 Git 并发和真实进程终止后的原请求恢复。构建保留既有大包提示；本轮未扩展修复此前记录的 MCP stdin EOF 和刷新成功提示清理事项。

用户另行授权切换服务：停止经核验的分支服务，从主项目重新构建并启动，保留原数据目录。schema 26 升级到 27 前已完成一致性备份；31 张历史业务表原字段数据摘要一致，完整性与外键检查通过，7 个项目及全部详情正常。原 Codex 聊天保持 durable 绑定与继续能力。完整运维证据见 [本机服务恢复](LOCAL_SERVICE_RECOVERY.md)。回交说明 `note_b4c49d54fe04d47feabd67a6` 已标记 handled（revision 2）。

本次 closeout 从根 AGENTS/README 一跳发现当前阶段、恢复与时间线来源；`WORKBENCH_FEEDBACK.md` 的 9 月 6 日验收和旧阶段/迁移段落作为历史保留。Preflight 完整工作区暂存、未暂存及未跟踪均为 0，待修正项是当前 schema/部署状态和本轮功能记录缺失。收束仅由当前 Agent 修改 README、阶段记录、恢复契约、本机部署记录与工作线说明，不改生产代码、测试、依赖或 VERSION（仍为 0.1.0-alpha.39），不创建标签、Release 或终态 handoff。上述固定 SHA 代码证据仍适用于文档收束后的代码树，另运行收束后的必要检查。

收束验证：上述 5 份文档对齐后的 `npm test -- --test-concurrency=4` **442/442**（314.80 秒）通过，无失败或跳过；`node --test test/phase0/version.test.mjs` **1/1** 与 `git diff --check` 通过。测试执行期间最后调整的 README 和本台账仅为文字记录，版本检查另在这些调整后完成；生产与测试源码始终等于 `b523b386`。本段仅补记已经取得的验证结果。

### PR #6 审计修复合并与收束（2026-09-08）

本轮基线为审核开始时的 main `c6ec5deba2dfbf26a1764bf77ee6e37b8331d26d`。用户明确授权合并 PR #6、closeout、保存与普通 push；GitHub 合并提交为 `5058f0c1fa14e2e05ff72d9356c1681e5851132d`，本地 main 随后快进同步。阶段增量为 5 个 PR 提交及 1 个合并提交、22 个路径；合并提交与最终送审版本 `e542b91ce5c82db258cb819dcbe3bfbe89efe0d5` 的完整代码树一致，无冲突。

修复包含：送审内容经路径授权读取后以 stdin 写入 Git 对象，推送远端名及 SSH 主机检查，MCP 请求超时和结构化错误契约，时间线重复关联消除、一次 adopted 写入约束，工作流错误映射及 HTTP 异常处理，以及轮询、头像和接入消息复制反馈。MCP 的显式 close 回调已接入中止信号；宿主 stdin EOF 自动触发中止未在本轮完成，不将显式 close 测试描述成宿主退出验收。

独立复审提出的三项 P2 已于最终送审版本修复：relay/handoff 列表保持既有 100 项、每项 4000 字的边界，避免阻断历史请求原样重放；含 `@` 的合法本地远端不再被当成 SSH 主机；创建并复制接入指令成功后的详情刷新失败独立处理，重试只读取详情，不再创建任务。Windows 也支持含 `@` 的相对本地路径，PR 初版相反论述已更正。

2026-09-08 主会话在固定送审版本的隔离副本执行 `npm test -- --test-concurrency=4` **405/405**（329.75 秒）、`npm run test:phase0` **93/93**（117.48 秒）、`npm run build:web` 与 `git diff --check`，全部通过，无失败或跳过；构建保留既有大包提示。另用临时数据库确认 9 项/600 字的已持久化 relay 经新版 MCP 校验原样重放，取回同一接力码和 revision，记录仍为一条。Luna max 独立复核界面返工，主会话整合裁定可合并。完整树等价证明上述证据适用于合并提交；本次收束仅补文档，生产代码与测试源码继续保持该版本。

非阻塞 P3：`web/src/assignment-copy-flow.mjs` 的“重试刷新”成功后，顶部原失败提示尚未清除；刷新已完成，不重复创建任务，后续可补提示清理。该项记录为已知产品问题，不视为文档对齐失败。

Preflight 从根 AGENTS/README 发现并核对阶段记录、会话持久性、旧送审、时间线、路线图、语言规范和本机恢复要求；历史发布及迁移段落保留其原时点。合并后暂存、未暂存和未跟踪均为 0，收束只由当前会话修改 README 与本阶段记录。本轮不变更 `0.1.0-alpha.39` 版本或 schema 25，不重启服务、覆盖数据、创建标签/Release 或结束工作会话；代码已合并不代表运行中的服务与网页资源已经加载新实现。

### alpha.39 main 集成与阶段发布（2026-09-07）

用户随后明确授权合并 main、保存对齐、push、tag 和 Release。本轮集成基线为本地及远端 main `670fbfce1dafcb3121dfa1f0c703ca64b606fa35`；从 `codex/conversation-continuity` 快进到候选 `d2907c584c291f6525455c4180e0a392dcee017a`，保留 6 个提交、39 个路径的完整实现历史，无合并冲突。版本为 `0.1.0-alpha.39`，未修改生产代码、依赖或业务数据。

独立 readiness 审核未发现阻断项：版本四处一致，已测实现到候选只含版本/文档差异，无运行数据库或凭据纳入版本；发布条件为最终 main 门禁通过及发布提交与候选源码一致。main 候选完整复验 `npm test -- --test-concurrency=4` **389/389**（375.50 秒）、`npm run test:phase0` **93/93**（135.43 秒）、`npm run build:web`、`git diff --check` 全部通过，无失败或跳过；随后仅保存本发布记录，不改变被测源码。既有大包警告保留，不扩大为界面优化任务。

阶段标识为 `v0.1.0-alpha.39`，GitHub Release 按 prerelease 发布，指向 main 最终记录提交；发布说明包含 schema 25 回退边界、MCP/技能重载和 ZCode 用户现场反馈的准确范围，不附加安装器或二进制资产。发布是否成功以远端 main/tag SHA 与 GitHub Release 回执为准。保留原开发分支及其他工作副本，不创建终态 handoff、不重启用户正在使用的服务。后续从本节及会话持久性/本机恢复文档继续；不要因切分支重新 init 或覆盖运行中数据库。

### alpha.39 节点追溯与平台转交收束（2026-09-07）

实施基线 `c004dd56bc743ef63ee3e6e5cdb6b445545b83b7`；Preflight HEAD `d36e66ac687060249b6887f52263f465bf704c20`，两提交、32 路径，全部为本轮已授权实现与部署，工作区暂存/未暂存/未跟踪均 0。代码定版 `291648e983a6c11202161793428dcc4b7ce81793` 的全仓 `npm test -- --test-concurrency=4` 389/389、Phase 0 93/93、网页构建及隔离浏览器流程通过；到 Preflight HEAD 仅补部署文档，代码证据仍适用。本次仅递增开发版本、对齐当前入口和阶段记录、补记用户提供的原 ZCode 现场结果，不修改生产逻辑或依赖版本，不创建发布标签。

当前契约以 [会话身份与中断恢复](CONVERSATION_DURABILITY.md) 为准，需求与测试范围见 [节点与转交验收](CONVERSATION_NODE_TRANSFER_REQUIREMENTS.md)，部署/备份/技能切换及现场反馈见 [本机服务恢复](LOCAL_SERVICE_RECOVERY.md)。alpha.32 恢复计划和此前两步 takeover 记录为历史，不作为当前操作指令。此前收束只获授权普通 push 到 `codex/conversation-continuity`，当时未合并 main 或创建 release；后续明确授权的 main 集成与发布见上节。

收束验证对应 Preflight HEAD 加本次 8 文件版本/文档工作树：`node --test test/phase0/version.test.mjs` 1/1，`npm test -- --test-concurrency=4 --test-name-pattern='VERSION, package metadata'` 通过（仅匹配版本断言，其他文件加载不算全量业务复验），`npm run build:web` 与 `git diff --check` 通过。生产及测试源码未变，复用代码定版的 389/389 和 93/93 证据。版本文件改为 alpha.39；此次不重启用户已恢复使用的服务，运行进程的版本标识在下次正常重启时更新，已部署的 schema 25 业务逻辑不变。

### alpha.38 可靠性补强与合并验收（2026-09-07）

本轮基线为 PR #5 合并前的 `main`：`f362ebd3b4e951caf0ad0287d0329b00dd16f250`；合并后的 Preflight HEAD 为 `983b487ebbce5f00a9661bdec9b0241c66ffbdda`。阶段增量为已审核并合并的 PR #5：POSIX 临时目录下的送审缓存路径与路径授权保持一致；所有 prepared 合并重入在 Git 写入前重新核验送审和领取的当前状态及 revision；命令化回执重放复用稳定 receipt id；陈旧单实例锁以 `O_EXCL` 选举串行回收；浏览器 API 将代理错误页或服务崩溃产生的非 JSON 响应纳入既有连接错误契约。测试夹具同步使用真实临时路径，Windows 并发陈旧锁回归使用 `file://` ESM 模块地址。

PR head `20cdf771ca0755d134a46b6e476fb22d6c09fbc1` 已独立复审并通过 `npm test` 354/354、`npm run test:phase0` 93/93、`npm run build:web` 与 `git diff --check`；合并提交与该 head 的代码树一致，因此上述代码验证适用于合并 HEAD。本轮无数据库迁移、版本或依赖变更，不切换运行中的服务、不修改业务项目、不创建发布标签；文档收束与后续普通 push 单独记录。

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
- 本机 stdio MCP 的普通路径使用 `ugk_work_context`、`ugk_work_init`、`ugk_work_progress`、`ugk_work_relay`、`ugk_work_takeover`、`ugk_work_resume`、`ugk_work_submit_preflight`、`ugk_work_submit`、`ugk_work_handoff`；主项目审核提示词使用 `ugk_integration_begin`、`ugk_integration_review`、`ugk_integration_merge`。context 只读恢复权威会话信息；只有 `ugk_work_takeover` 在用户逐次确认后才能接管会话。阶段 closeout 以本地收束为主，具备条件时可选调用 `ugk_work_progress` 记录一个非终态检查点，不因 closeout commit 再额外触发通用 progress。`ugk_work_submit_note`、`ugk_submit_note_get`、`ugk_submit_note_update` 服务于轻量工作说明；`ugk_work_accept`、`ugk_work_begin`、`ugk_work_finish` 暂留作旧客户端兼容，共 18 个工具。服务端从一次性代码、接力码、session 或已授权送审来源解析项目和代码位置；查询及送审 cwd 只由 MCP bridge 注入，不允许 Agent 自填任意路径。
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
- 同一代码位置的第二个写入会话默认被拒绝；异常接管必须由用户在工作台授权，再由目标聊天消费一次性指令，不能在聊天内自批。
- 存在尚未交接的旧会话时，不得因 heartbeat、记录时间或 service 重启推断中断或完成；只展示最近确认节点，并通过显式 relay、handoff 或 takeover 转换。
- 错误仓库和同路径替换 100% 拒绝自动重绑。

## 进入实现前的依赖决策

推荐使用 React + Vite 构建产品界面，原因是后续会有文件夹授权、离线/恢复状态、Run Lite 和多项目筛选等持续交互；相比手写 DOM，它更容易维持可测试的状态边界。后端继续保持 Node 内置模块与 SQLite，不新增数据库依赖。

这是新增生产依赖，需要用户明确确认后再安装。若不希望引入依赖，也可以用原生 HTML/CSS/JavaScript 完成 0.1.0，但后续复杂交互的维护成本更高。


## 2026-09-05 会话持久绑定与中断恢复

本轮修复及兼容边界见 [会话身份与中断恢复](CONVERSATION_DURABILITY.md)。界面仍处于用户试用期。本轮新增 schema 22 聊天绑定表，schema 23 保留同一聊天的多任务绑定，并修复合并中断恢复和可证明归属的 Git 索引锁恢复；不重建已有运行记录。定版全量 `npm test` 338/338（exit 0，677.00 秒）、Phase 0 92/92（exit 0）、Web 构建通过；Relay 技能契约说明更新后定向 12/12 通过。构建保留既有主 bundle 大于 500 kB 的提示，本轮没有扩展界面性能优化。

12:32 首次迁移至 schema 22，26 张既有业务表内容摘要完全一致。12:47 最终服务通过已有启动器切换到 alpha.36 / schema 23（PID 50588），再次一致性备份后核对全部 27 张既有表，内容摘要完全一致；6 个项目、17 条运行、25 条任务、125 条进展、21 条接力保留（期间其他项目正常新增 1 条进展）。完整性与外键检查通过，项目列表及 Cockpit/手腕详情接口正常。

真实 Codex 原请求已核对包含原聊天的 `_meta.threadId`。停止旧 MCP PID 42164 后曾返回 `Transport closed`；随后原 Codex 聊天重新连接新版 MCP，context 成功返回 `bindingPersistence: durable`。用户明确确认继续原工作会话后，确认调用返回 `bindingEstablished: true`、`canContinue: true`、`status: active`；再次空参数查询仍为 `bound / durable`，revision 保持 49。此为原聊天重新连接、历史关联及后续读取的实际验收；首次绑定之后再次重启的恢复由独立真实进程重建夹具验证，不混同验收范围。

工程约束已写入 AGENTS.md；仓库与 Codex/共享安装副本的 cockpit-relay 仅更新绑定持久性的说明，保留原确认与接力成功判据。未修改产品仓库代码，未 push 或创建标签。

## 历史：2026-09-05 最终本地收束

基线 `9c50e0af76bb0587a1f85a14db88250fddb8a24a`，代码定版 `5db9dd17df57fa8789bb89b28877d5585e52fad4`。其间 4 个提交、41 个路径，覆盖工作台试用版本、本机认证和持久性改造；Preflight 完整工作区暂存、未暂存、未跟踪均为 0。2026-09-05 已执行的 npm test 338/338、npm run test:phase0 92/92、npm run build:web 和技能契约 12/12 对应该定版源码。本次收束仅更新 README、阶段及运维记录中的绑定措辞和原聊天验收结果，不改变被测源码，复用上述验证；文档另执行 git diff --check。平台检查点和 Relay 结果以随后 MCP 回执为准。
