# UGK Cockpit 项目约定

## 产品对象

UGK Cockpit 首先是给项目所有者每天使用的产品，不是只给平台开发者看的 Git 管理后台。

- 普通界面使用“项目、代码位置、工作副本、AI 工作会话、接手记录”等人话。
- `repository`、`worktree`、`HEAD`、`lease`、`receipt` 等术语只出现在高级详情、API 和代码中。
- 每个异常必须回答：发生了什么、代码是否受影响、推荐下一步是什么。
- 默认动作必须保守：不清理、不覆盖、不 checkout、不 merge、不删除产品仓库内容。

## 当前阶段

- `0.0.x`：Phase 0 技术 spike，只在本仓库和独立临时夹具中验证。
- `0.1.x`：Phase 1 首个可用垂直切片。
- 五个现有 UGK 产品仓库只可作为后续只读验收样本，未经逐次授权不得修改。

## 工程规则

- Node.js 最低版本暂定 `24.15.0`，Phase 0 仅使用内置模块，不引入生产依赖。
- 数据库迁移必须可重复执行；状态转换使用事务、幂等键和 revision CAS。
- 无法证明修改归属时必须返回 `unattributed`，不得猜测 Agent。
- 同一 worktree 最多一个 active write lease；takeover 必须由用户确认。
- Git 和文件系统探测使用 argv、显式 cwd、超时和输出上限，不拼接 shell 命令。
- 修改后运行 `npm test`；Phase 0 门禁运行 `npm run test:phase0`。

## 版本与提交

- 使用 SemVer；`VERSION` 是当前开发版本。
- 每个阶段门禁通过后形成一个可回退 Git commit；发布标签在独立 readiness 审核通过后创建。
- 不把 `.antigravity-help-me/` 提交到仓库；只加入本地 `.git/info/exclude`。

