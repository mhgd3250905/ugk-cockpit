# 简约界面分支审核与合并门禁

日期：2026-10-02。审核范围：`e0d7b03..ae8bf12`，分支 `codex/minimal-project-views`，版本 `0.1.0-alpha.64`。

## 审核结论

独立子代理完成代码与契约审核，未发现可定位的 P0/P1/P2 问题。审核覆盖总览双布局、显示偏好、官方平台标识、图标依赖、详情顶部、工作信息弹窗及文档。

- 详情标题入口与弹窗操作使用正确的工作线范围，关闭后回到实际触发按钮；键盘页签行为保留。
- 会话页切换保持组件挂载，未改原请求、CAS、幂等键、未确认结果恢复或授权确认流程。
- 代码记录关联会话与可操作会话分别显示，接入状态没有被解释为 AI 在线。
- 最后的详情局部提交保留原时间线实现和样式。分支早期总览视觉提交含时间线配色调整，发生在用户后续限定详情范围之前。
- 平台图片采用已有允许范围内的扁平资源路径；没有扩大后端资源授权范围，没有服务端或持久性协议变更。

独立定向审核：`node --test --test-concurrency=1 test/agent-platform.test.mjs test/project-view.test.mjs test/detail-work-context-ui.test.mjs test/conversation-control-ui.test.mjs test/conversation-control-state.test.mjs`，24 项通过，0 失败。`git diff --check e0d7b03 ae8bf12` 通过。

## 完整门禁

运行时代码候选为 `ae8bf12`。网页构建通过：CSS 317.47 KB（gzip 46.89 KB），JS 676.27 KB（gzip 216.58 KB）；保留既有的大 chunk 提醒。

完整门禁通过。环境为 Windows、Node.js `v24.15.0`、Git `2.50.0.windows.2`；运行时代码保持 `ae8bf12`。实际命令：

```powershell
npm test -- --import=./.data/design/merge-git-trace.mjs --test-reporter=tap
```

正常 pretest 确认发现 138 个测试文件。结果：892 项，885 通过、7 跳过、0 失败、0 取消，退出码 0，耗时约 42 分 36 秒。完整日志为 `.data/design/2026-10-02-merge-full-traced.log`，包含 Phase 0，没有另跑一遍 Phase 0。

临时诊断 hook 仅记录 Git 错误或超过 4 秒的命令类别、耗时和错误类别；保留原参数、超时、错误、ChildProcess 与 Promise.child，不重试。callback 和 custom promisify 的成功/超时行为已用独立临时夹具核对。脚本及 JSONL 只留在忽略目录 `.data/design/`，不随产品提交。前两次失败项本次均通过；本次通过不是旧偶发根因已修复的结论。

### 初次运行的拒绝与诊断

初次完整运行在 `test/audit-2026-09-24.test.mjs:284` 的夹具准备阶段返回 `SOURCE_WORKTREE_CHANGED`，日志为 `.data/design/2026-10-02-merge-full.log`。发现失败后结束该次运行，保留日志；它不是完整通过的证据。

该测试单独重跑通过，日志为 `.data/design/2026-10-02-merge-reproduce.log`。只读复核留下的临时夹具：目录身份与数据库一致，提交尝试表为空，尚未开始提交写入；当前探测 coherent。旧探测代码会把分支读取错误当作空分支，前后不一致时也会映射成位置变化，因此超时是候选解释；原日志没有底层探测细项，根因未确认。没有降低保护、提高全局超时或修改后端来获取绿灯。

上一轮开发诊断的旧过滤器夹具失败另见 [视觉验收记录](../design-qa.md)。本次单独运行 `test/audit-2026-09-11.test.mjs`，10 项通过，日志为 `.data/design/2026-10-02-merge-fixture.log`；单项通过不等于修复了偶发原因。

第二次运行在 `test/audit-2026-10-01-removal-reopen-fence.test.mjs:174` 的新建夹具校验阶段返回 `WORKTREE_RECOVERY_UNCERTAIN`，日志为 `.data/design/2026-10-02-merge-full-retry.log`。创建 Git 工作副本已成功，但创建后的路径、身份、分支、HEAD、coherence 或干净状态至少一项不符；未进入本测试的删除/重开操作。夹具正常清理后未留下具体 observation，不能认定是哪项不符。首次失败的并发测试在第二次完整运行中通过，但第二次整体仍失败。

## 合并判定

审核与门禁通过，可按用户授权快进合入本地 `main`。完整门禁后重新 fetch，`main` 与 `origin/main` 仍同为 `e0d7b03`；采用 fast-forward，保留开发分支。版本不变，不创建发布标签；本次只合入本地主干。

门禁之后仅收束本文、详情方案和视觉验收的文字；依据 [测试规则](TESTING.md) 运行文档快组，147 项中 146 通过、1 跳过、0 失败，退出码 0，日志为 `.data/design/2026-10-02-merge-docs-quick.log`。受影响的本地链接与 `git diff --check` 通过。复用明确绑定 `ae8bf12` 的完整测试与构建证据，不为纯文档收束再跑一套完整测试。

视觉与真实数据上的只读交互证据见 [design-qa.md](../design-qa.md)；详情范围与功能映射见 [详情优化方案](DETAIL_PAGE_REDESIGN_PLAN.md)。审核未在真实项目上执行授权、转交、归档或移除。
