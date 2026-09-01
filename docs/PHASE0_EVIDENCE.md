# Phase 0 验证记录

- 版本：0.0.1
- 日期：2026-09-01
- 状态：Go；Luna-Max 与 Antigravity 最终独立门禁均通过
- 范围：仅 `E:\AII\ugk-cockpit` 和系统临时测试夹具

## 已验证事实

运行环境：

- Windows
- Git 2.50.0
- Node.js 24.15.0
- `node:sqlite` 无实验 flag 可加载
- 零第三方生产依赖

执行：

```powershell
npm test
```

最近一次全量结果：51 项通过，0 项失败，总耗时约 41 秒。

| 门禁 | 证据 |
| --- | --- |
| 同一工作副本唯一 writer | 100 个竞争 start：1 成功、99 确定性冲突；数据库只有 1 个 lease 和 active Run。 |
| Start 幂等 | 同一 command/digest 100 次重试只产生 1 个 Command、Run 和 lease。 |
| revision CAS | 100 个同 revision heartbeat 只有 1 个成功，revision 只增加一次。 |
| Finish 幂等 | 同一 finish 100 次并发/重试只产生 1 个不可变 receipt，全部返回同一 receipt。 |
| Finish 竞争 | 100 个不同 finish command 同时竞争只有 1 个成功，数据库只有 1 个 receipt。 |
| takeover fencing | 未经用户确认被拒绝；确认接管后 generation 递增，旧 writer 的 heartbeat/finish 被拒绝。 |
| 崩溃恢复 | 在 Run、Snapshot、lease、receipt、CAS、Command commit 和事务返回边界进行 100 次强制退出；另有真实 HTTP service 强杀/重启测试。没有 phantom receipt，原 command 可恢复。 |
| SQLite 完整性 | `integrity_check=ok`，`foreign_key_check` 为空。 |
| 备份恢复 | 使用 SQLite 在线备份生成独立数据库，恢复后数据、schema version 和完整性检查通过。 |
| 数据库迁移 | 新库按 v1→v2→v3 逐事务迁移；旧 v1 和缺 identity 列的旧 v2 可保留记录升级；未来版本原样拒绝。 |
| Git coherence | 探测前后 HEAD/branch、独立 index/worktree 指纹一致才为 coherent；中途修改被标记 incoherent。 |
| Git 拓扑 | multi-worktree 共享 Repository identity；nested repo 和 submodule 保持独立 identity。 |
| Git 授权边界 | 清除继承的 `GIT_*` 重定向；worktree/common dir/index/object dirs 均需授权；拒绝 `core.worktree` 越权和超大 `alternates`。 |
| Windows path | dot segment、盘符大小写、长路径可规范化；scope 外路径和 junction/symlink 逃逸被拒绝。 |
| 错误身份重绑 | 已存在 worktree identity 指向另一 path/repository 时事务回滚，不生成新 Run。 |
| 单实例 | 锁文件竞争中 8 个进程只有 1 个 owner；owner token 防止旧 owner 删除新锁；半写 live lock 不可被抢；相同 loopback port 是第二道 fence。 |
| 本地 HTTP 边界 | API 需要 token，拒绝外部 Origin；未知 Git fixture 可经 HTTP start→finish。 |
| 响应性 | 注入 2 秒异步 Git probe 时，`/health` 仍在 200ms 门槛内响应。 |
| SQLite 锁竞争 | 写锁被外部连接占用时约 150ms 后返回可重试人话错误，健康检查在 500ms 门槛内完成。 |

## 产品约束已物化

- API 的冲突和失败使用人话说明代码是否被影响。
- takeover 必须携带用户确认，默认不能抢占。
- incoherent final snapshot 不能标记为 completed。
- 同路径仓库替换、未声明外部提交、分支切换和未归属改动不能静默标记 completed。
- service、CLI 和未来 Web 共用 HTTP 边界；CLI 不允许直接写数据库。
- 所有测试仓库均在系统临时目录创建并删除，没有读取五个 UGK 产品仓库。

## 明确限制

- `node:sqlite` 在 Node 24.15 仍为 Release Candidate；通过 Phase 0 只代表当前固定运行时和已测试边界可用，升级 Node 时必须重跑门禁。
- 当前 path guard 防止静态逃逸并在 Git probe 前后重新验证；威胁模型不声称抵御已控制同一 Windows 用户账户的恶意进程在系统调用间隙实施 TOCTOU。
- Phase 0 没有面向用户的网页、项目注册流程或发行安装包；这些属于 0.1.x。
- UNC 路径和干净机器单目录分发尚未自动验收，进入首个可用版本前仍需补证据。
- 当前 HTTP 接口是技术切片，不是最终用户界面或稳定公共 API。

## Go / No-Go

**Go**：基础并发、恢复、路径、Git 和服务边界已经通过。

- Luna-Max 最终复核：`pass`，亲自重放 cross-run finalize、partial lock、legacy v2、`core.worktree` 越权和同路径 replacement，残余 P0 为 0。
- Antigravity 独立 `verify`：task `task-20260901-091506-1050a1`，结构化 `verdict: pass`，新 conversation，残余 P0 为 0。

Phase 0 可以提交基线并进入 0.1.x。已知 P1 是：启动后 active Run 自动 re-probe、probe 失败 Command 收束，以及锁文件极窄 TOCTOU 的进一步加固。
