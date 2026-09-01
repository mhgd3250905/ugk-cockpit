# UGK Cockpit

UGK Cockpit 是一个本机优先的个人 AI 开发控制台。它帮助用户在多个 Git 项目和多个 AI Agent 之间切换时，直接看见：现在谁在做什么、代码处于什么状态、哪里需要处理、下一步怎么继续。

## 当前版本

`0.0.1` — Phase 0 技术验证。

此版本还不是可日常使用的产品。它只验证最容易导致返工的基础能力：

- SQLite Command journal、幂等和 revision CAS。
- 同一工作副本唯一写入会话。
- 重复或并发结束只产生一个不可变接手记录。
- 崩溃边界恢复，不产生“幽灵完成”。
- Windows 路径授权、junction/symlink 逃逸拒绝。
- 本地服务单实例锁。

Phase 0 不读取或修改五个 UGK 产品仓库，测试只使用系统临时目录中的夹具。

## 本地验证

要求 Node.js 24.15 或更高版本：

```powershell
npm test
npm run test:phase0
```

当前不需要安装任何第三方依赖。

## 面向用户的首版目标

Phase 1 会交付最小网页闭环：添加未知项目、查看首页、开始或继续 AI 工作、结束并生成接手记录、处理未登记改动和中断会话。普通路径不会要求用户填写项目 ID、worktree、JSON 或 Git 命令。

详见 [路线图](docs/ROADMAP.md) 和 [产品语言规范](docs/PRODUCT_LANGUAGE.md)。

