# UGK Cockpit

UGK Cockpit 是一个本机优先的个人 AI 开发控制台。它帮助用户在多个 Git 项目和多个 AI Agent 之间切换时，直接看见：现在谁在做什么、代码处于什么状态、哪里需要处理、下一步怎么继续。

## 当前版本

`0.1.0-alpha.6` — handoff-first AI 连续工作流：标准交接手册、只读等待与明确任务后开工。

当前通过置顶的 Windows 系统选择器逐个手动选择项目文件夹，不扫描工作区，也不自动导入项目。文件夹授权绑定路径和仓库身份，可在瞬时失败或 service 重启后安全恢复；浏览器会在写操作前安全续期，不重放写请求，也不会接触本地 API token。选择器由独立交互 helper 承载并保留硬超时，不会再让页面无限等待。

项目卡片现在可以“交给 AI”：默认让 AI 读取最后一次标准交接手册并等待用户安排，此时不取得写入权限；用户给出明确任务后，AI 才通过 MCP 开始可写工作。Cockpit 生成的短期接手消息不含本地路径和 API token；AI 可回传进度，并在结束时生成下一次可直接读取的标准交接手册。

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

## 本地验证

要求 Node.js 24.15：

```powershell
npm test
npm run test:phase0
```

MCP 后端未新增生产依赖。

## 面向用户的首版目标

Phase 1 会交付最小网页闭环：添加未知项目、查看首页、开始或继续 AI 工作、结束并生成接手记录、处理未登记改动和中断会话。普通路径不会要求用户填写项目 ID、worktree、JSON 或 Git 命令。

详见 [路线图](docs/ROADMAP.md) 和 [产品语言规范](docs/PRODUCT_LANGUAGE.md)。
