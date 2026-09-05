# UGK Cockpit

UGK Cockpit 是一个本机优先的个人 AI 开发控制台。它帮助用户在多个 Git 项目和多个 AI Agent 之间切换时，直接看见：现在谁在做什么、代码处于什么状态、哪里需要处理、下一步怎么继续。

## 当前版本

`0.1.0-alpha.36` — 本地开发版本新增持久聊天绑定与中断恢复：支持身份元数据的原聊天在 MCP/服务重建后恢复绑定，接力后旧聊天继续失效；已有项目和运行历史保留。同步修复合并中断恢复和可核验归属的 Git 索引锁恢复，详见[会话身份与中断恢复](docs/CONVERSATION_DURABILITY.md)及[阶段记录](docs/PHASE1_VERTICAL_SLICE.md)。工作台界面仍处于用户试用期，按实际反馈继续优化；此前界面与认证修复记录见[工作台重构](docs/WORKBENCH_REDESIGN.md)和[MCP 认证恢复](docs/MCP_AUTH_RECOVERY.md)。未创建发布标签或推送远端。

保留轻量 Submit 工作说明：向所属项目发布说明，可以引用 PR、本地提交或其他分支的审核结果，不再默认保存上传或创建代码审核对象。说明发布不冻结分支，不结束会话，已有 progress 与 relay 照常推进。2026-09-03 的实现、切换及历史验收见 [Submit 工作说明](docs/SUBMIT_NOTES.md)。

保留 `alpha.34` 的审核长期保留与恢复修复：旧代码审核领取不因时间流逝失效，固定版本和审核状态变化仍须重新确认。历史实现与验收见 [统一送审](docs/UNIFIED_SUBMIT.md)。

保留 `alpha.33` 的独立项目详情页与多工作线时间线：真实接入回执才显示合流，点击节点或卡片可突出整条工作线。完整语义与验收边界见 [工作线时间线](docs/WORK_LINE_TIMELINE.md)。

保留 `alpha.31` 的本地收束与可选平台登记分离：没有会话信息或 MCP 不可用时，仍可整理文档、保存提交，并执行用户明确授权的普通 push。正式 handoff 仍须用户明确结束并通过平台校验。

当前开发版本以 `VERSION` 为准；版本与阶段验收的当前事实源是 [阶段记录](docs/PHASE1_VERTICAL_SLICE.md)。

会话恢复的契约、实施计划和验收边界见 [会话信息恢复](docs/SESSION_CONTEXT_RECOVERY.md)。升级后，运行中的本地服务及 Agent MCP 连接需加载新版；工具列表出现 `ugk_work_context` 才表示客户端已加载新接口。重新连接不等于重新 init，也不会结束平台已有会话。

保留 `alpha.30` 的送审内容范围修复：只送审已提交代码时，不读取无关工作文件内容；保存改动时仅对选中文件做内容检查。主项目里的截图、视频和未选中文件不再因体积过大阻塞送审，无需清理 build。用户确认的分支成果可以包含其他会话的提交，不冒称已验收，也不因换过会话拒绝接纳。

旧代码送审接口继续保留：不要求提前 init 或由平台创建分支，核对已登记项目、当前代码权限、本次文件范围及最新远端 main，再保存必要提交、普通推送并生成代码审核待办。其代码版本去重与旧审核失效规则只适用于旧审核对象，不适用于新的工作说明。

首次使用外部代码目录需在系统选择器中授权。审核可在隔离副本中进行，不占用正在开发的主项目；实际接入仍需用户授权，并满足原有干净工作区与 `ff-only` 门禁。远程 Agent 必须能连接本机 MCP 才能直接登记；不可连接时只能返回待接入交付信息，不共享本机 token。需求、阶段计划及验收记录见 [统一送审](docs/UNIFIED_SUBMIT.md)。

当前通过置顶的 Windows 系统选择器逐个手动选择项目文件夹，不扫描工作区，也不自动导入项目。文件夹授权绑定路径和仓库身份，可在瞬时失败或 service 重启后安全恢复；浏览器会在写操作前安全续期，不重放写请求，也不会接触本地 API token。选择器由独立交互 helper 承载并保留硬超时，不会再让页面无限等待。

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

要求 Node.js 24.15：

```powershell
npm install
npm run serve
```

然后打开 `http://127.0.0.1:41737`。数据保存在 `%LOCALAPPDATA%\UGK Cockpit`，项目代码不会被 Cockpit 自动清理、提交、上传或删除。

启动验收还需确认已有项目列表及详情正常，不能仅检查 HTTP 200。不得在服务运行时覆盖数据目录；遇到项目突然消失，先按[本机服务数据一致性与故障恢复](docs/LOCAL_SERVICE_RECOVERY.md)排查，不要重新 init 或重新添加项目。

## 本机 MCP

MCP server 通过 loopback service 使用同一数据库事实源，不直接接触业务项目文件。可先手工验证：

stdio 入口通过服务已有的本机 MCP 认证通道获取凭据，不读取客户端 AppData 的服务私有凭据；认证失效后有限续期，原样保留业务请求和会话绑定。支持稳定聊天元数据的宿主在桥接进程重载后自动恢复持久绑定；旧会话首次关联和未适配的宿主仍按明确确认流程处理，详见[会话身份与中断恢复](docs/CONVERSATION_DURABILITY.md)。

```powershell
npm run mcp
```

Codex、ZCode 或 Antigravity 的 stdio 配置应执行 `node <仓库绝对路径>\src\mcp\main.mjs`（例如 `node E:\AII\ugk-cockpit\src\mcp\main.mjs`）。本仓库只提供配置片段，不会自动修改用户级 Agent 配置。

## 配套 Skills

仓库内置六个面向用户动作的 Skill：`$cockpit-init`、`$cockpit-progress`、`$cockpit-relay`、`$cockpit-submit`、`$cockpit-closeout`、`$cockpit-handoff`。它们把 session、revision、幂等请求号、接力上下文和标准交接字段留在 Agent 与 MCP 之间，用户不需要记忆原始工具参数。聊天上下文遗失 session 信息时，新的只读 MCP 工具 `ugk_work_context` 会按当前代码目录重新核对平台状态；同目录候选不会自动接管，只有用户明确确认后才在当前 bridge 进程内建立临时绑定。查询不会改变平台会话、写入归属、租约、心跳或 revision；旧 bridge 被新接力代际超越时会安全标为 stale。`submit`、`closeout`、`relay`、`handoff` 都只能在用户显式动作中触发；closeout 聚焦本地收束与独立 commit 并可选登记检查点；`completed` handoff 的选择可伴随执行本地 closeout；`progress` 是唯一允许在有效检查点后自动触发的动作。主项目审核不另设 Skill，由项目页复制的标准提示词驱动 `ugk_integration_begin`、`ugk_integration_review`、`ugk_integration_merge`，确保平台收到规范回执。

安装到当前用户的 Codex：

```powershell
npm run install:skills:codex
```

安装器发现同名 Skill 时默认拒绝覆盖；确认这些目录可以更新后可执行 `npm run install:skills:codex -- --force`。其他兼容 `SKILL.md` 的 Agent 可运行 `node scripts/install-cockpit-skills.mjs --target <技能目录>` 指定自己的技能根目录；首版不会猜测或自动修改其他 Agent 的用户配置。

## 本地验证

要求 Node.js 24.15：

```powershell
npm test
npm run test:phase0
```

MCP 后端未新增生产依赖。

## 面向用户的首版目标

Phase 1 会交付最小网页闭环：添加项目、查看首页、开始或继续 AI 工作、创建独立功能开发空间、发布工作说明供主项目按需处理、显式结束并生成接手记录、处理未登记改动。旧代码审核与规范接入保留为独立能力，不是每条说明必须走的流程。普通路径不会要求用户填写项目 ID、worktree、分支、JSON 或 Git 命令。

详见 [路线图](docs/ROADMAP.md) 和 [产品语言规范](docs/PRODUCT_LANGUAGE.md)。
