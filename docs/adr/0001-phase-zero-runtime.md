# ADR-0001：Phase 0 使用 Node.js 24 内置能力验证

- 状态：Accepted for Phase 0
- 日期：2026-09-01

## 决策

Phase 0 先使用 Node.js 24.15 的内置 `node:sqlite`、`node:test`、HTTP、文件系统和子进程能力，不引入生产依赖。

这不是永久栈冻结。`node:sqlite` 在当前运行时仍为 Release Candidate；它已通过本项目 Phase 0 的并发、崩溃恢复、备份、Windows 路径与双重独立门禁，因此接受为 0.0.x/0.1.x 的固定基线。升级 Node 版本时必须重跑全部门禁。

## 理由

- 前后端未来可保持同一语言和单一运行时。
- 内置 SQLite 避免 native npm addon 的安装与打包风险。
- 内置 test runner 足以做 Phase 0 多进程竞争和恢复测试。
- 用户不需要管理数据库服务。

## 退出条件

若未来完整门禁失败、出现不可接受的同步阻塞，或 `node:sqlite` 的兼容性变化，则重新比较 Python stdlib SQLite 服务，不围绕失败栈堆补丁。
