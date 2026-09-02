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
- 当前小步：Agent-first 工作闭环。空项目、新派发任务和已经开发到一半的项目都用 `ugk_work_init` 统一建立 active session；最近交接存在时随 init 返回。只有 progress 可隐式记录；relay 与 handoff 分别只在用户显式要求换聊天或结束阶段时调用。

## 产品方向：晨间工作简报

首页不是工程监控大盘，而是一张每天早上可以直接照着行动的简报。

首屏只回答三件事：

1. 哪个项目最需要我处理？
2. 为什么？
3. 我现在按哪个按钮？

视觉采用温暖纸张、深墨色和单一安全橙强调，避免企业后台常见的蓝紫渐变和密集表格。状态颜色不能单独承载含义，必须同时有文字与动作。

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

- `需要你处理`：中断、身份变化、未归属改动、同时编辑或状态读取失败；
- `正在工作`：存在可确认的 AI 工作会话；
- `可以继续`：没有阻断，可开始下一段工作；
- `暂时放下`：用户主动暂停。

每张卡片最多显示：项目名、阶段、人话状态、最后更新时间、推荐下一步、一个主按钮。路径、工作线、代码保存点和原始错误只在 `技术详情` 中显示。

### 4. 交给 AI 与继续

主按钮为 `交给 AI` 或 `继续工作`。用户选择 Agent，也可以填写一句当前目标。Cockpit 创建短期一次性 initCode，并生成调用 `$cockpit-init` 的可复制消息。系统先做只读预检：

- 有本地改动：默认保留并标记为“开始前已有改动”；
- 另一个 AI 正在编辑：默认只读，不自动接管；
- 上次未正常结束：显示“可能已中断”，提供继续或整理记录；
- 代码位置身份变化：停止，要求用户重新选择，绝不自动重绑。

消息复制后页面只显示“等待 AI 接入”。AI 在当前项目目录调用 `ugk_work_init`，校验项目绑定并保留现有改动后直接显示“正在工作”；最近交接存在时在 init 结果中返回。工作中通过 `$cockpit-progress` 报告里程碑。上下文堆积时，用户可显式调用 `$cockpit-relay`：旧聊天调用 `ugk_work_relay` 生成一次性接力消息，新聊天调用 `ugk_work_resume` 继续同一工作会话。只有用户显式要求结束阶段时，才通过 `$cockpit-handoff` 收束。普通用户不需要理解 MCP、heartbeat、lease、revision 或 snapshot。

### 5. 结束工作

用户明确要求结束当前阶段后，AI 才通过 `ugk_work_handoff` 选择：`已完成`、`卡住了`、`稍后继续`，提交标准交接字段、建议技能和文件引用。系统重新只读采集代码状态并保存可供下一次直接读取的交接手册；网页并列显示“Agent 报告”和 Cockpit 验证结果，最终确认与接管仍由用户完成。

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
- 本机 stdio MCP 的普通路径使用 `ugk_work_init`、`ugk_work_progress`、`ugk_work_relay`、`ugk_work_resume`、`ugk_work_handoff`；`ugk_work_accept`、`ugk_work_begin`、`ugk_work_finish` 暂留作旧客户端兼容。服务端从一次性代码、接力码或 session 解析项目和代码位置；
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
- 上次工作中断后两步内可以继续或整理记录，不能自动标成完成。
- 错误仓库和同路径替换 100% 拒绝自动重绑。

## 进入实现前的依赖决策

推荐使用 React + Vite 构建产品界面，原因是后续会有文件夹授权、离线/恢复状态、Run Lite 和多项目筛选等持续交互；相比手写 DOM，它更容易维持可测试的状态边界。后端继续保持 Node 内置模块与 SQLite，不新增数据库依赖。

这是新增生产依赖，需要用户明确确认后再安装。若不希望引入依赖，也可以用原生 HTML/CSS/JavaScript 完成 0.1.0，但后续复杂交互的维护成本更高。
