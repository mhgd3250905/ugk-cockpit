# UGK Cockpit

UGK Cockpit 是一个本机优先的个人 AI 开发控制台。它帮助用户在多个 Git 项目和多个 AI Agent 之间切换时，直接看见：现在谁在做什么、代码处于什么状态、哪里需要处理、下一步怎么继续。

## 当前版本

`0.1.0-alpha.2` — Project onboarding、晨间简报预览与浏览器会话自动恢复。

当前可以通过 Windows 文件夹选择器添加一个 Git 项目，并在本地网页查看人话状态。文件夹授权绑定路径和仓库身份，可在瞬时失败或 service 重启后安全恢复；浏览器会在写操作前安全续期，不重放写请求，也不会接触本地 API token。

Run Lite 的开始、继续和结束工作仍在下一小步，因此页面上的对应按钮会明确显示“即将开放”，不会伪装成已经可用。

Phase 0 已验证的基础能力继续保留：

- SQLite Command journal、幂等和 revision CAS。
- 同一工作副本唯一写入会话。
- 重复或并发结束只产生一个不可变接手记录。
- 崩溃边界恢复，不产生“幽灵完成”。
- Windows 路径授权、junction/symlink 逃逸拒绝。
- 本地服务单实例锁。

当前开发和测试不读取或修改五个 UGK 产品仓库，只使用系统临时目录中的夹具。用户只有通过系统文件夹选择器明确选择后，产品才会读取该项目的必要 Git 状态。

## 启动本地预览

要求 Node.js 24.15：

```powershell
npm install
npm run serve
```

然后打开 `http://127.0.0.1:41737`。数据保存在 `%LOCALAPPDATA%\UGK Cockpit`，项目代码不会被 Cockpit 自动清理、提交、上传或删除。

## 本地验证

要求 Node.js 24.15：

```powershell
npm test
npm run test:phase0
```

当前不需要安装任何第三方依赖。

## 面向用户的首版目标

Phase 1 会交付最小网页闭环：添加未知项目、查看首页、开始或继续 AI 工作、结束并生成接手记录、处理未登记改动和中断会话。普通路径不会要求用户填写项目 ID、worktree、JSON 或 Git 命令。

详见 [路线图](docs/ROADMAP.md) 和 [产品语言规范](docs/PRODUCT_LANGUAGE.md)。
