# 路线图与版本门禁

## 产品承诺

用户不需要成为 Git 或 Agent 编排专家。系统内部可以严谨复杂，普通界面必须把复杂性翻译成可理解、可撤销、可继续的动作。

## 0.0.x — Phase 0：技术风险验证

交付：

- 无第三方生产依赖的 Node.js + SQLite spike。
- Project/Repository/Worktree/Run/Command/Snapshot/Handoff 最小 schema。
- write lease、幂等、CAS、唯一 receipt、崩溃恢复原型。
- Windows path/reparse 和单实例验证。

通过条件：

- 100 个竞争 start 请求最多一个取得 write lease。
- 100 个并发/重试 finish 只产生一个 receipt，重复请求得到同一结果。
- start/finish 持久化边界中断后没有 phantom completed，原命令可恢复。
- scope 外路径和 junction/symlink 逃逸被拒绝。
- 第二个 service 实例被拒绝，陈旧锁可安全恢复。
- Luna-Max 与 Antigravity 独立只读门禁均无 P0。

失败处理：任何一项失败都不进入 Phase 1；先修复或更换服务栈，不用 UI 掩盖基础问题。

## 0.1.x — Phase 1：首个可用垂直切片

交付顺序：

1. 首次打开和未知项目接入。
2. 项目首页和一个代码位置的只读状态。
3. Agent-first 工作闭环：已有 Agent 可通过一次性 init 指令把进行中的开发接入 session；新 Agent 可读取交接后等待或开工，两条路径最终都生成标准交接手册。
4. 未登记改动、中断会话、同时编辑和离线的人话恢复流程。
5. 手动版本化导出与恢复演练。

用户门禁：

- 添加未知项目不超过三个主要步骤，目标 60 秒内完成。
- 首页 10 秒内能回答“哪个项目需要处理、为什么、下一步是什么”。
- 开始/继续不要求输入 ID、绝对路径、worktree 或 JSON。
- 结束只选择“已完成 / 卡住 / 稍后继续”，摘要可选。
- 主路径和普通错误标题不出现 Git 内部术语。

## 0.2.x — Phase 2：多项目、多工作副本和恢复加固

接入五个 UGK 项目的只读声明式配置，验证多仓库、多 worktree、adopt、takeover、rebind、foreign/unattributed 和 handoff validity。仍不修改产品仓库。

## 0.3.x 及以后

逐步加入发布、上线、验证证据；远程 Agent 调度、外部连接器和任何外部写入独立立项并逐次授权。本机 MCP 生命周期已前移到 Phase 1，仍不直接启动 Agent 或修改用户级配置。
