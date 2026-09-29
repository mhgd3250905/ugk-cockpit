# 版本与更新管理

## 版本事实源

根目录 `VERSION` 是 Cockpit 开发与发布版本的唯一事实源。`package.json`、`package-lock.json` 和 `src/version.mjs` 必须与它一致；`test/phase0/version.test.mjs` 会检查版本元数据及当前产品文档。Codex/ZCode 插件构建器从 `VERSION` 写入实际插件清单并附加宿主与内容摘要，`packaging/ugk-cockpit` 中的 `0.1.0` 只是清单模板值，不应单独手改。

README 的“当前开发版本”描述当前代码候选，阶段记录保存对应范围与验证证据。已发布版本以 GitHub Release/tag 为准；README 中较早版本的记录是历史，不能据此判断最新已发布版本。

## 准备版本与发布

1. 按 SemVer 选择下一个版本，在同一变更中更新 `VERSION`、`package.json` 和 `package-lock.json`。同步 README 的当前开发版本、阶段记录中的版本条目、技能总表、宿主清单和受影响的测试。
2. 候选代码通过 `npm run test:quick`、受影响的定向测试、完整 `npm test` 与 `npm run build:web`；完整候选的 Windows CI 两个分片都通过后，记录对应提交和 CI 结果。
3. 按项目阶段门禁完成独立 readiness 审核。审核通过后，才创建 `v<VERSION>` 标签并发布 GitHub Release；Release 说明与 README 对应版本记录保持一致。审核前不创建标签或正式 Release。
4. 不自动推送更新。发布说明是所有用户可查看的更新渠道；只在新版本加入 `$cockpit-update` 后，用户才能在已更新的插件中检查后续 Release。首次加入该技能的版本需要在 Release 说明中特别告知旧版用户。

## 用户手动更新

`$cockpit-update` 只比较已安装插件携带的 `VERSION` 与 GitHub 上已发布的 Release（含预发布版，不含草稿），并整理 Release 说明。它不检查 `main` 上未发布的提交，不下载代码、不切换版本、不安装插件，也不停止或启动服务；网络或 API 异常必须显示为“暂时无法确认”。

尚未包含 `cockpit-update` 的旧插件无法运行这个技能；用户需先从 [GitHub Releases](https://github.com/mhgd3250905/ugk-cockpit/releases) 手动获知首次加入该技能的版本。升级到该版本后，之后可在项目聊天中调用 `$cockpit-update` 查询后续已发布版本。

更新对象是 Cockpit 程序目录和宿主插件。用户的业务项目仓库不需要 checkout、pull 或重装；服务数据位于独立数据目录，升级时继续使用原目录。建议按以下顺序进行：

1. 从 GitHub Releases 确认目标版本已经正式发布，并阅读该版本说明。找到 Cockpit 程序目录后检查 `git status --short --branch` 与 `git remote -v`。只有确认来源正确且工作树干净时才继续；有本地改动、来源不明或不是 Git 检出时，先保留现场并查清，不覆盖原目录。
2. 按[本机服务恢复规程](LOCAL_SERVICE_RECOVERY.md)确认实际数据目录，使用 SQLite backup API 制作并验证一致性备份；不能在服务运行时直接复制或替换数据库文件。服务启动时若目标版本需要 schema 迁移，也会在迁移前自动创建并验证备份，但这不能代替升级前的备份。
3. 在 Cockpit 程序目录获取已发布标签并切到精确版本：

   ```sh
   git fetch --tags origin
   git switch --detach v<VERSION>
   npm ci
   ```

   将 `v<VERSION>` 替换为 Release 页面上的精确标签。不得切到未发布的分支提交，也不得用 `reset`、`clean` 或强制覆盖解决工作树冲突。
4. 切换服务代码。Windows 在程序目录的 PowerShell 中运行新版仓库的启动器：

   ```powershell
   .\scripts\launch-cockpit.ps1 -RepoDirectory $PWD.Path -NoPause
   ```

   它会先构建网页，只在监听 PID、该数据目录中的锁 PID 与 `/health` 身份核对通过后，才停止旧服务并从当前程序目录启动新版。默认读取程序目录中保存的数据目录；自定义数据目录需明确传入 `-DataDirectory`。macOS 没有对应的自动重启脚本；按恢复规程核验数据目录、锁 PID、监听端口、健康响应和进程命令行后，只停止准确识别的旧服务，再执行宿主安装入口启动新版。两平台都不得仅凭端口号结束进程。
5. 在同一 Cockpit 程序目录运行宿主入口：Codex 执行 `npm run setup:codex`，ZCode 执行 `npm run setup:zcode`。若服务版本与这份程序目录不同，安装流程会报错停止，不会自行替换运行中的服务；先完成上一步的服务切换，再重试安装。
6. 核对 `/health` 返回目标版本，并确认原数据目录中的项目列表和每个项目详情正常；然后让 Codex/ZCode 重连或开启新聊天，确认新版 MCP 工具和 Skills 已加载。恢复已有工作会话时遵循原接力流程，不重新 init。

完整安装器可能会启动或复用本机服务，但不会在发现版本不匹配时自动重启它。不得用清库、重新 init 或重加项目代替升级。回退程序版本前，还必须确认旧程序支持当前数据库 schema；恢复旧数据库备份会丢弃备份之后新增的记录，不能视为无损回退。
