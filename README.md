# UGK Cockpit

UGK Cockpit 是一个本机优先的个人 AI 开发控制台。它帮助用户在多个 Git 项目和多个 AI Agent 之间切换时，直接看见：现在谁在做什么、代码处于什么状态、哪里需要处理、下一步怎么继续。

## 当前版本

`0.1.0-alpha.19` — Windows 系统文件夹选择器由旧版 WinForms FolderBrowserDialog 升级为原生 COM `IFileOpenDialog`（开启 `FOS_PICKFOLDERS`、`FOS_FORCEFILESYSTEM` 与 `FOS_PATHMUSTEXIST` 模式），提供标准文件资源管理器导航体验，支持稳定 Client GUID 位置记忆，并通过纯 ASCII Unicode 转义根除 Windows PowerShell 5.1 环境下的中文字符乱码问题；保持置顶宿主窗口、非错误取消与标准输出契约不变。

当前通过置顶的 Windows 系统选择器逐个手动选择项目文件夹，不扫描工作区，也不自动导入项目。文件夹授权绑定路径和仓库身份，可在瞬时失败或 service 重启后安全恢复；浏览器会在写操作前安全续期，不重放写请求，也不会接触本地 API token。选择器由独立交互 helper 承载并保留硬超时，不会再让页面无限等待。

项目卡片现在统一通过 init 指令“交给 AI”：空项目、刚派发的新任务和已经开发到一半的项目使用同一入口。Agent 调用 `$cockpit-init` 后，Skill 通过 MCP 建立 active session；Cockpit 将调用时的代码状态作为接入基线，保留全部已有改动，并在存在标准交接手册时一并返回最近上下文。接入前的改动不会被自动归属给 Agent。

工作中的 AI 可通过 `$cockpit-progress` 主动记录进展；成功 commit、改变 `HEAD` 的 merge/rebase/cherry-pick、发布 tag 等有效 Git 检查点也会尽量自动记录，`status`、`diff`、`log`、`add` 和失败命令不会制造噪声。需要换聊天但继续同一阶段时，用户显式调用 `$cockpit-relay`；只有用户显式要求结束阶段时，才调用 `$cockpit-handoff` 生成标准交接手册。功能完成、测试通过、Git commit 或上下文堆积都不会自动结束阶段。Cockpit 生成的短期接入与接力消息不含本地路径和 API token。

Phase 0 已验证的基础能力继续保留：

- SQLite Command journal、幂等和 revision CAS。
- 同一工作副本唯一写入会话。
- 重复或并发结束只产生一个不可变接手记录。
- 崩溃边界恢复，不产生“幽灵完成”。
- Windows 路径授权、junction/symlink 逃逸拒绝。
- 本地服务单实例锁。

自动化测试只使用系统临时目录中的夹具。用户明确打开项目文件夹后，产品读取必要的 Git 状态；用户确认后才登记到工作简报。产品不会修改、提交、上传或删除项目文件。

## 启动本地预览

要求 Node.js 24.15：

```powershell
npm install
npm run serve
```

然后打开 `http://127.0.0.1:41737`。数据保存在 `%LOCALAPPDATA%\UGK Cockpit`，项目代码不会被 Cockpit 自动清理、提交、上传或删除。

## 本机 MCP

MCP server 通过 loopback service 使用同一数据库事实源，不直接接触业务项目文件。可先手工验证：

```powershell
npm run mcp
```

Codex、ZCode 或 Antigravity 的 stdio 配置应执行 `node E:\AII\ugk-cockpit\src\mcp\main.mjs`。本仓库只提供配置片段，不会自动修改用户级 Agent 配置。

## 配套 Skills

仓库内置四个面向用户动作的 Skill：`$cockpit-init`、`$cockpit-progress`、`$cockpit-relay`、`$cockpit-handoff`。它们把 session、revision、幂等请求号、接力上下文和标准交接字段留在 Agent 与 MCP 之间，用户不需要记忆原始工具参数。`init`、`relay`、`handoff` 都必须由用户显式调用；`progress` 是唯一允许在有效检查点后自动触发的动作。

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

Phase 1 会交付最小网页闭环：添加未知项目、查看首页、开始或继续 AI 工作、结束并生成接手记录、处理未登记改动。普通路径不会要求用户填写项目 ID、worktree、JSON 或 Git 命令。

详见 [路线图](docs/ROADMAP.md) 和 [产品语言规范](docs/PRODUCT_LANGUAGE.md)。
