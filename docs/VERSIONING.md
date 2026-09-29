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

用户决定升级后，应先确认 Cockpit 程序目录、Git 来源和工作树状态；本地修改或来源不明时先保留并查清。再按目标版本的[安装说明](AGENT_INSTALL.md)与[本机服务恢复规程](LOCAL_SERVICE_RECOVERY.md)备份和升级服务，执行对应宿主的安装入口，检查服务版本、已有项目及详情，并由宿主重连或新聊天加载新版技能。不得用 `reset`、`clean`、重新 init、清库或重加项目代替升级。
