# 简约界面分支审核与合并门禁

日期：2026-10-02。审核范围：`e0d7b03..ae8bf12`，分支 `codex/minimal-project-views`，版本 `0.1.0-alpha.64`。

## 审核结论

独立子代理完成代码与契约审核，未发现可定位的 P0/P1/P2 问题。审核覆盖总览双布局、显示偏好、官方平台标识、图标依赖、详情顶部、工作信息弹窗及文档。

- 详情标题入口与弹窗操作使用正确的工作线范围，关闭后回到实际触发按钮；键盘页签行为保留。
- 会话页切换保持组件挂载，未改原请求、CAS、幂等键、未确认结果恢复或授权确认流程。
- 代码记录关联会话与可操作会话分别显示，接入状态没有被解释为 AI 在线。
- 最后的详情局部提交保留原时间线实现和样式。分支早期总览视觉提交含时间线样式调整，发生在用户后续限定详情范围之前。
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

## 合并结果与后续收束授权

审核与门禁通过后，按用户授权将本地 `main` 从 `e0d7b03` 快进至 `67e54f867ffca80626935f8388d02718de959487`，工作区干净，开发分支保留。合并前重新 fetch，确认当时本地主干与 `origin/main` 同为 `e0d7b03`；当次只合入本地主干，尚未推送。用户随后明确授权本阶段文档对齐、保存提交及普通 push。版本保持 alpha.64，不创建发布标签。

门禁之后仅收束本文、详情方案和视觉验收的文字；依据 [测试规则](TESTING.md) 运行文档快组，147 项中 146 通过、1 跳过、0 失败，退出码 0，日志为 `.data/design/2026-10-02-merge-docs-quick.log`。受影响的本地链接与 `git diff --check` 通过。复用明确绑定 `ae8bf12` 的完整测试与构建证据，不为纯文档收束再跑一套完整测试。

视觉与真实数据上的只读交互证据见 [design-qa.md](../design-qa.md)；详情范围与功能映射见 [详情优化方案](DETAIL_PAGE_REDESIGN_PLAN.md)。审核未在真实项目上执行授权、转交、归档或移除。

## 文档 closeout Preflight（2026-10-02）

- baseline：`e0d7b038b020258be535976a3d448223bf8b52aa`，可核对提交引用 `e0d7b03`，选择依据为本阶段已记录的前轮 alpha.64 收尾起点；已验证为 HEAD 的祖先。
- Preflight HEAD：`67e54f867ffca80626935f8388d02718de959487`，本地 `main`。
- stage delta：6 个提交、25 个文件，5 个文档、2 个依赖清单、4 个测试、14 个前端源码或资产文件；没有后端、数据库迁移或持久协议变更。
- 收束 scope：总览双布局、主题与显示偏好、平台标签、统一图标、详情顶部及工作信息弹窗的现行描述、审核和合并事实。本次只修改与这些 delta 相关的文档；版本策略和路线图核对后保留。
- 改动归属：上述已提交 delta 为本会话已记录、审核并获授权合入的阶段成果。完整 `git status --porcelain=v1 --untracked-files=all` 无输出：tracked/staged/unstaged/deleted/renamed/untracked 待处理项均为 0；无不明归属项。

### 来源发现与实际核对

从本仓库根 `AGENTS.md`、`README.md` 出发，沿其明确声明检查相关一跳来源；不递归追踪二级链接。阶段内的设计、方案、资产说明和验收记录由 Git delta 及同一会话记录核对。

| 实际检查路径 | current / archive 判定与结果 |
| --- | --- |
| `AGENTS.md`、`README.md` | 当前项目入口；README 当前版本段漏记界面更新，旧版本段为历史。补充当前界面及现行设计、验收入口。 |
| `VERSION`、`package.json`、`package-lock.json` 根元数据、`src/version.mjs` | 当前版本/配置事实；alpha.64 一致，运行时读取 VERSION，Lucide 锁定为 1.49.0。保留元数据。 |
| `docs/VERSIONING.md` | 当前版本与发布策略；源码提交、运行部署和 Release 分开，保留原政策。 |
| `docs/PHASE1_VERTICAL_SLICE.md` | 当前实施状态与产品/首日流程；新增本阶段及合并事实，修正单一行布局与右侧信息区描述。旧日期审计和测试记录保留；实现前依赖比较明确标为历史。 |
| `docs/ROADMAP.md` | 当前阶段目标；本次仍属 Phase 1，不增列新承诺。 |
| `docs/TESTING.md` | 当前验证策略；纯文档收口执行快组和相关检查，复用绑定源码的完整门禁。 |
| `docs/PRODUCT_LANGUAGE.md`、`docs/WORK_LINE_TIMELINE.md` | 当前界面用语与时间线契约；补齐弹窗分组、按需高级详情和所选工作线范围，保留原时间线语义和日期历史。 |
| `docs/LOCAL_SERVICE_RECOVERY.md` | 当前部署事实入口；原 alpha.64 备份、重启、PID 和 schema 是 2026-10-01 时点事实。本次添加网页验收与源码收束边界，不新增部署主张。 |
| `DESIGN.md`、`docs/AGENT_LOGO_SOURCES.md` | 阶段现行视觉和本地资产说明；明确详情局部范围与早期总览调整，补齐标签也用于详情标题。 |
| `docs/DETAIL_PAGE_REDESIGN_PLAN.md`、`design-qa.md`、本文 | 本阶段当前范围、验收与合并记录；旧初稿及 2026-10-01 验收时未合并/未推送的说明按历史保留，最新段落补实际 main 合入事实。 |

### 验证证据及适用性

2026-10-02 同一会话实际执行的完整 `npm test -- --import=./.data/design/merge-git-trace.mjs --test-reporter=tap`、独立 24 项定向审核和 `npm run build:web` 均对应完整源码 SHA `ae8bf1228ed7c86bb26188c0baae5dbcfb8e28cf`，结果见本文上方。`git diff --name-status ae8bf12 HEAD` 证明到 Preflight HEAD 只变更 `design-qa.md`、详情方案和本文 3 个文档；运行时代码、测试、依赖与构建配置不变，因此这些证据仍适用。后续对齐也仅为文档，不新增完整候选，不重复运行全量或 Phase 0。

Preflight 确定的 alignment findings 为 README 漏记界面、阶段现行布局过期、合并记录仍是待执行口吻，以及局部范围/标签/高级信息/部署边界说明不一致。Alignment 已按以上来源和实际源码修正；收束提交前再核对完整工作区、快组、版本一致性和受影响的本地链接。普通 push 目标已核对为 `github.com/mhgd3250905/ugk-cockpit.git` 的 `refs/heads/main`，推送后以远端引用确认结果。

### Alignment 验证与改动归属

本次基于 Preflight HEAD 对齐 10 个文档：`README.md`、`DESIGN.md`、`design-qa.md`、`docs/AGENT_LOGO_SOURCES.md`、`docs/DETAIL_PAGE_REDESIGN_PLAN.md`、`docs/LOCAL_SERVICE_RECOVERY.md`、本文、`docs/PHASE1_VERTICAL_SLICE.md`、`docs/PRODUCT_LANGUAGE.md`、`docs/WORK_LINE_TIMELINE.md`。全部为本次 Agent 在干净工作区中作出的已授权文档修正；没有新增、删除、重命名或不明归属项，Preflight HEAD 未发生预期外变化。

2026-10-02 的 `npm run test:quick`：147 项，146 通过、1 平台跳过、0 失败，退出码 0；`node --test test/phase0/version.test.mjs`：1 项通过，退出码 0。105 个仓库内文档路径链接及 `git diff --check` 通过。验证对应 `67e54f8` 加上述文档修正的工作树；收束记录随后补入验证事实，不改变运行时代码、测试、版本或依赖。独立子代理复核这 10 个文件的文档 diff，未发现阻塞收束的矛盾；确定的 alignment findings 已清零。此次没有重跑完整套件或网页构建，继续复用上方明确绑定源码 SHA 的证据。

本次没有可信的最新 Cockpit `sessionId/revision` 回执，跳过可选平台检查点；不据此推断平台不存在 active session。本地文档成果及用户已授权的普通 push 独立有效。
