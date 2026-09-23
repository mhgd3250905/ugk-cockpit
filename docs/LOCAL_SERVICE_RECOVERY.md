# 本机服务数据一致性与故障恢复

## 遗留的「半开工作会话」（work/begin 修复之前产生）

修复前 `POST /api/v1/mcp/work/begin` 先建 Run 并取写锁，之后才比对工作指派 revision；代理填入过期的 `expectedRevision` 时，请求以 `ASSIGNMENT_REVISION_CONFLICT` 失败，但写锁与 active Run 已经落库，工作指派仍停在 `accepted`。修复后不再产生新的这类记录，但**已在正式库中留下的行不会自动消失**，需要显式收束。

识别（只读，不修改任何数据）。该半状态的定义很窄：写锁被一个 active Run 持有，而这份**待命中（standby）**的工作指派仍停在 `accepted`——即从未被提升为 `active`。

```sql
SELECT l.worktree_id, l.run_id, a.status, a.revision
FROM write_leases l
JOIN runs r ON r.id = l.run_id AND r.lifecycle = 'active'
JOIN assignments a ON a.session_id = r.id
WHERE a.status = 'accepted'
  AND json_extract(a.scope_json, '$.mode') = 'standby';
```

`scope_json.mode` 这一条不能省：`task` 派发（`scope_json.mode` 为 `write`）在接入时就取锁并写入 Run，但要等第一次 progress 才离开 `accepted`，那是完全正常的进行中会话；少了这个条件就会把正在干活的代理误判成故障。也不要写成「状态不属于那几个正常值」，那会连 `cancelled`、`failed` 一起匹配上。上面这条查询在四类现场都验证过：健康 task 会话 0 行、已接入但从未开始的 standby 会话 0 行、成功开始的 standby 会话 0 行、被本缺陷卡住的会话 1 行。返回的每一行都是需要处理的记录；一条也没有，就说明没有被本缺陷卡住的记录。注意 `write` 会话在接入后、第一次 progress 前失联会留下相同形态，但不在这条查询的范围内，需要另按通用结束流程判断。

处理：让该会话本身显式结束，这是唯一受支持的出口——`ugk_work_finish`（或 `work/handoff`）带 `outcome: 'abandoned'` 和数据库里 `runs.revision` 一致的 `expectedRevision`。这会正常释放写锁，并留下一条可追溯的结束记录；不要用清理数据库行、重新接入或新建会话来代替。

不要用 `runs/release-lease`：工作指派仍存在时它会以 `RUN_LEASE_MANAGED_SESSION` 拒绝，这是设计如此。同一个 `clientRequestId` 改值重试会以 `COMMAND_CONFLICT` 拒绝（幂等键已冻结原始意图），换新 `clientRequestId` 则以 `WRITE_LEASE_CONFLICT` 拒绝且报出的正是该会话自己的 id——看到这两种返回时按上面的显式结束处理，不要继续重试。

## alpha.52 部署验收（2026-09-23）

PR #18（审计修复：归属凭据遮蔽、交付索引锁原子发布、改派幂等键、resume 契约退役参数、路径守卫与 schema 29 守卫）合并为 `1da1652` 并收束 `ca00fcb`（0.1.0-alpha.52）后，服务于 10:49:55 UTC 被外部重启（非验收会话执行，`node src/main.mjs --data-directory E:\AII\ugk-cockpit\.data\service`，PID 50972→26788）。重启时无 schema 迁移（schema 30 保持）。验收会话随后补齐核对：/health 确认 `0.1.0-alpha.52`；`verify-service-data` 核对 10 个可见项目及全部详情与数据库一致；`PRAGMA user_version` 30、integrity ok、外键错误 0；命令行核对进程使用本仓库源码与原数据目录，未重新 init、未覆盖数据库。因重启发生在验收会话之外，未留存部署前备份；已补做部署后基线快照 `.data/service/backups/after-alpha52-deploy-2026-09-23T15-07-36-779Z.db`（VACUUM INTO，schema 30、integrity ok、外键 0、10 条项目记录）。macOS 侧回归仍未在真机执行。

## alpha.52 源码合并（2026-09-23）

PR #18（审计修复：归属凭据遮蔽、交付索引锁原子发布、改派幂等键、resume 契约退役参数、路径守卫与 schema 29 守卫）经独立复审后合并为 `1da1652`，开发版本 `0.1.0-alpha.52`。本轮完成源码合并与文档对齐：未动正式数据库，无新增 schema 迁移（schema 30 不变），宿主插件与全局登记无需变更。部署验收见上方小节。macOS 侧回归仍未在真机执行。

## alpha.51 部署与 schema 30 迁移（2026-09-23）

用户明确授权部署。重启前运行版本 alpha.48 / schema 29，10 个可见项目。通过 SQLite backup API 创建 `cockpit-schema-29-before-30-2026-09-23T05-46-52-446Z.db`，完整性 `ok`、外键错误 0、10 条项目记录。既有启动器核验并停止旧 PID 23160，隐藏启动 PID 50972，继续使用 `E:/AII/ugk-cockpit/.data/service`。/health 确认 `0.1.0-alpha.51`；正式库完成 schema 29 → 30 迁移，user_version 30、integrity ok、外键 0；`verify-service-data` 核对 10 个项目及全部详情通过，未覆盖数据库、未重新 init。

本轮同机生效的改动：alpha.49（指纹去 device + schema 30 原地迁移）、alpha.50（setup:antigravity 安装命令）、alpha.51（接入指令即归属，declaredWorkspace 声明回退）。已知噪音：迁移扫描 folder: 项目时 git 在 stderr 留下「not a git repository」提示，已被同步安全门按预期捕获，不影响结果；后续版本可静默。Antigravity 全局 MCP 登记已恢复为唯一登记（alpha.51 机制下无需逐项目配置）；LSBK 按项目插件暂保留（播客活跃会话在用，现场验证全局+声明路径后可摘除）。macOS 侧回归仍未在真机执行，见下方 alpha.49 边界。

## 历史：alpha.49 源码合并与部署边界（2026-09-22）

PR #17 的最终返修提交 `30c3277c178fc3572df407bbe9e5d46b7fd5a49a` 已快进接入 main，开发版本为 `0.1.0-alpha.49`，源码引入 schema 30（目录指纹去 device + 存量原地迁移）与用户确认的代码位置重绑。本轮完成源码合并、独立复审与文档收束，未重启本机服务、未迁移正式数据库、未更新宿主插件；最近一次已记录的本机部署验收仍为下方 alpha.48，运行版本以现场核验为准。

部署 alpha.49 时注意：重启即对 `E:/AII/ugk-cockpit/.data/service` 正式库执行 schema 30 迁移，须先按既有规程以 SQLite backup API 备份并核对完整性；迁移只改写可按当前 stat 精确重算的旧格式指纹，真漂移行保持原样，由用户在工作台对受影响项目逐个确认代码位置。已知限制：漂移前已存在的 pending 接入任务会阻塞对应项目的位置确认（详见[会话身份与中断恢复](CONVERSATION_DURABILITY.md)）；macOS 侧回归尚未在真机执行，部署前建议在 macOS 补跑 `npm test`、`npm run test:phase0`、`npm run build:web`。

## alpha.48 部署与 Antigravity 用户验收（2026-09-20）

在源码 `aec2fedd7872eb33e302940d78fbc8bb48a5f983` 上，用户明确授权重启。重启前运行版本 alpha.47，10 个已有项目及全部详情与磁盘记录一致。通过 SQLite backup API 创建 `.data/service/backups/before-alpha48-1789913134480.db`，完整性 `ok`、外键错误 0。

既有启动器重新构建网页，核验并停止旧 PID 39268，隐藏启动 PID 42492，继续使用 `E:/AII/ugk-cockpit/.data/service`。14:05 UTC 的 `/health` 确认 `0.1.0-alpha.48`，重启后 10 个已有项目及全部详情核对通过；沿用 schema 29，未覆盖数据库或重新 init。用户随后重载 Antigravity MCP 并确认测试通过，这是原宿主现场验收反馈，未额外读取或推断其会话回执。

## 历史：alpha.47 普通文件夹支持部署（2026-09-19）

在源码 `531377316a701b766fa979175d758c473a8eb66c` 上按用户授权部署。备份 `.data/service/backups/before-alpha47-1789752764613.db` 完整性 `ok`、外键错误 0，含 8 条项目记录。启动器核验停止旧 PID 30804，隐藏启动 PID 38900，继续使用原 `.data/service`；健康检查确认 alpha.47，重启前后 7 个可见项目及全部详情正常。项目数量和 PID 均为当次验收时点事实。

## 历史：alpha.46 源码合并与部署边界（2026-09-16）

PR #16 的最终返修提交 `b8fe28add6822922662d525477cdc33739d59929` 已快进接入 main，开发版本为 `0.1.0-alpha.46`，沿用 schema 29。本轮完成审计修复的源码合并和文档收束，未重启本机服务、覆盖运行网页产物、迁移正式数据库或更新宿主插件。最近一次已记录的本机部署验收仍为下方 alpha.44；源码版本不能作为运行版本证明。复审与验证证据见[阶段记录](PHASE1_VERTICAL_SLICE.md)。

## 历史：alpha.45 源码合并与部署边界（2026-09-14）

PR #14 的返修提交 `c3d6bddfa567690b238076922b6420cec6988897` 已快进接入 main，源码新增 macOS 安装、数据目录和原生选择器支持，沿用 schema 29。本轮仅合并、验证和文档收束；未重启本机服务、覆盖运行网页产物、迁移正式数据库或更新宿主插件。最近一次已记录的本机部署验收为下方 alpha.44；运行版本应以现场核验为准。

macOS 启动器的数据目录优先级为显式 `UGK_COCKPIT_DATA`、程序目录 `.data/service-directory.txt`、`~/Library/Application Support/UGK Cockpit`。复用先检查健康状态与源码版本；复用和新启动都通过 `verify-service-data.mjs` 核对磁盘记录、项目列表和全部详情。数据核对失败不清库或重新添加项目，新启动失败时向刚启动的进程发送停止信号；这不能撤销服务此前可能完成的初始化或迁移。macOS 现场验收来源及未完成项见[安装说明](AGENT_INSTALL.md)。

## 历史：alpha.44 功能部署与用户验收（2026-09-12）

本轮先核对数据库与运行服务：7 个可见项目及全部详情一致，另 1 个已软移除项目仍保留在数据库。修正启动核验脚本按 removed_at 排除已移除项目，兼容旧 schema；不以重新添加修复展示。

使用 SQLite backup API 生成 `.data/service/backups/before-ui-service-1789184610393.db`，完整性检查 ok、外键错误 0，包含 8 个项目记录。既有启动器构建并核验后停止旧 PID 41016，以隐藏窗口启动 PID 57076，继续使用原 `.data/service`。03:43 UTC 状态接口返回运行中（当时版本仍为 alpha.43），7 个可见项目及详情复核通过；之后补充端口显示，仅重新构建网页。用户已确认本轮功能正常。数据库沿用 schema 29，未覆盖数据或更新宿主插件。

版本收束后使用同一启动器 `-SkipBuild -NoPause` 于 03:49 UTC 将 PID 57076 切换为 PID 32964；`/health` 确认 `0.1.0-alpha.44`，重启前后 7 个可见项目及全部详情核验通过。此次仅更新版本与页面，不迁移数据库。

以下段落是先前源码收束时的历史边界，不代表上述部署后的状态。

## 历史：alpha.43 源码与部署边界（2026-09-12）

项目操作页面反馈已在主线集成，源码支持 schema 29：保留 schema 28 的 `owner_started_at`，新增项目软移除标记 `removed_at`。已在独立历史数据库验证 28 → 29 升级及新进程重开，未迁移正式数据库。只有用户明确从工作台移除的项目才隐藏，显式重新添加可恢复；正常运行时发生的异常空列表仍按本文件排查，不能以重新添加代替数据恢复。

本轮没有重启正式服务、覆盖网页运行产物或更新宿主插件。后续升级需按既有规程备份，并核对已有项目列表和全部详情；schema 28 及更旧程序不能直接打开 schema 29 数据库。下方 alpha.42/alpha.41 记录保留其当时源码及未部署边界，不能据此推断当前运行服务版本。


## alpha.42 源码合并与部署边界（2026-09-11）

PR #10、#11 已在本地主分支合并，源码支持 schema 28；迁移新增工作空间操作预留行的 `owner_started_at`，保留历史行和已有聊天绑定。本轮只合并、验证和收束源码，没有重启正式服务、迁移正式数据库或更新宿主插件；最近一次完整本机部署验收仍是下方 alpha.40 的历史记录，运行版本须以现场核验为准。

后续升级继续按本文件既有规程备份、核对准确进程，并在启动后核对已有项目列表与全部详情；不得在服务运行时替换数据库，也不能用重新 init 或重新添加项目代替恢复。支持 schema 27 的旧程序不能直接打开升级后的 schema 28 数据库。

Windows 启动器将自身信息写入独立的 `launcher-<时间戳>.log`，服务输出分别进入 `service-<时间戳>.log` 和 `service-<时间戳>.err.log`，按运行时间戳保留最近 10 次启动的日志。启动器不再向正在重定向的文件追加内容，消除了默认 PowerShell 5.1 的文件占用错误。默认 CMD 入口的隔离服务替身测试已通过；空列表和不存在项目的 404 断言仅证明该启动流程，不构成正式项目数据恢复验收。

## alpha.41 源码发布与部署边界（2026-09-10）

本轮 PR #8、#9 已合并到 `e8df86ed646ee5bee5227aae8a1cd4e759297e90`，随后整理 alpha.41 发布版本。版本包含唯一随机临时名的 API token 原子写及恢复、保守的单实例进程身份校验；Linux 可比较进程启动标识，Windows/macOS 没有可靠标识时仍拒绝回收活 PID，不得用锁龄或心跳期限判定进程死亡。

本轮只整理源码与 GitHub 发布，未执行正式服务重启、数据库替换或宿主插件批量更新。最近一次完整本机升级验收是下方 alpha.40 记录；不要把新的仓库版本号当成运行服务已升级的证据。后续部署继续按本文件启动与维护要求备份、核对准确进程、确认已有项目及全部详情；沿用 schema 27，无新增迁移。

## alpha.40 本机升级验收（2026-09-09）

用户要求查看已发布的使用指南后，先核对旧服务返回 alpha.39，数据库与接口中的 7 个项目及全部详情一致。使用 SQLite backup API 创建 `backups/before-alpha40-2026-09-09T07-03-26-464Z.db`（相对本机 `.data/service`），备份包含 7 个项目，完整性检查 `ok`、外键错误 0。

在发布提交 `b31618c51dbc7752d0d6302ca6059dbe3539a9af` 上，使用既有启动器及已通过构建的网页资源：`scripts/launch-cockpit.ps1 -RepoDirectory E:/AII/ugk-cockpit -DataDirectory E:/AII/ugk-cockpit/.data/service -SkipBuild -NoPause`。启动器核验后停止旧 PID 26568，以隐藏窗口启动 PID 31868，继续使用原数据目录；本次沿用 schema 27，没有新增迁移、覆盖数据库、重新 init 或重新添加项目。

启动器再次核对 7 个已有项目及全部详情；07:03 UTC 的 `/health` 返回 `0.1.0-alpha.40`。已打开 `http://127.0.0.1:41737/#/guide`，用户随后确认页面正常。PID、时间及数量仅表示本次验收时点；没有据此声称所有 Agent 宿主已更新插件或重载技能。

## schema 27 主项目服务切换（2026-09-08）

用户授权合并并重启后，main 从 `990e231c40378e3ace68df27c08ae9fe8722378d` 快进到复审通过的 `b523b38602905d739c4540d0291b8466e66d74bb`，普通推送后远端 main SHA 一致。启动前核对分支服务 PID 39352 的命令行，入口为 `E:/AII-Bug-Fix/BUG-Cockpit/src/main.mjs`，数据仍在主项目 `.data/service`；7 个已有项目及全部详情正常。

先通过 SQLite backup API 创建并验证 `backups/before-b523b386-2026-09-08T07-04-18-900Z.db`（相对 `.data/service`）。启动器在主项目构建网页、核验并停止旧 PID，再从 `E:/AII/ugk-cockpit/src/main.mjs` 启动 PID 38464，继续使用原数据目录。迁移前还自动生成 `backups/cockpit-schema-26-before-27-2026-09-08T07-04-31-588Z.db`。

升级后 schema 为 27，完整性检查 `ok`、外键错误 0；按迁移前备份中的原字段核对 31 张历史业务表（排除迁移台账），逐行摘要全部一致。启动器核对 7 个项目及所有详情。当前 Codex 原聊天 `ugk_work_context({})` 返回原 session、revision 67、active、durable、`canContinue=true`；随后合并进展登记成功，revision 68。未重新 init、覆盖运行中数据库或重新添加项目，也未批量重启 MCP 宿主。

以上 PID、项目数量和 revision 是切换时验收事实。日常访问地址为 `http://127.0.0.1:41737/`；后续收束仅修改文档，不需要再次重启。

## schema 25 节点与平台转交部署（2026-09-07）

用户明确授权部署代码 `291648e` 并切换已安装技能。部署前旧 PID 25124 已不存在，端口 41737 未监听；保留的数据库为 schema 24、6 项目、19 运行、27 任务。使用 SQLite backup API 创建并验证 `.data/service/backups/before-node-transfer-2026-09-07T07-28-24-067Z.db`，包含 WAL 中已提交记录。

通过既有启动器构建网页、清理已证明失效的旧锁并启动 PID 45780，继续使用 `.data/service`。未覆盖运行中数据目录、清库或重新添加项目。升级至 schema 25 后完整性检查 `ok`、外键错误 0；对 27 张历史业务表逐行比较其升级前字段，摘要全部一致，新节点和转交表均为 0。启动器核对 6 个已有项目及全部详情；新增会话控制 API 在真实项目可读。

当前 Codex 原聊天调用 `ugk_work_context({})` 成功：原会话 `session_6ca84f6b88abea9e26dc204f33758878`、revision 61、durable/host、`canContinue=true`，持有人仍为原 Codex 聊天。此次只读验收未新增业务节点或推进 revision。

两处现存技能根目录 `.codex/skills` 与 `.agents/skills` 各六包已先备份至 `.data/backups/skills-pre-schema25-20260907-7b392fd8/{codex,agents}`。旧文件全部匹配仓库历史，无不明定制；使用仓库安装器升级后，24/24 文件 SHA-256 与源版本一致，文件集合无额外或缺失。实际内容变化为 progress 和 relay 技能。

部署时新启动的 stdio 进程公布 takeover 必填字段 `sessionId/clientRequestId/transferCode`，但当前宿主缓存仍显示旧工具定义。文件安装和服务升级不等于已运行 bridge 自动重载：旧聊天需重连 MCP 后再使用新版接手入口，技能在下一轮重新加载；未为此批量停止宿主或其他项目进程。

随后用户在本对话提供原 ZCode 聊天的现场结果并确认恢复正常：用户从工作台签发指令，ZCode 消费成功后查询同一手腕工作会话，revision 从 41 经授权/接手推进到 43，`canContinue=true`、`bound/host/durable`，持有人与 takeover 节点均指向该 ZCode 宿主会话。反馈明确未重新 init、未改代码、尚未补记成果。本记录来源是用户转述的原宿主结果，不是主会话另读业务仓库或重新执行转交；后续记录必须使用最新平台 revision，不沿用 41。

## 启动器数据目录修复（2026-09-06）

启动器现在把解析后的 `DataDirectory` 通过 `--data-directory` 传给服务，锁、日志和数据库使用同一目录。此前该参数未传给服务，服务始终读取 AppData。启动成功前，启动器通过浏览器会话核对磁盘与接口的项目 ID 集合，并验证每个已有项目详情；仅首页 HTTP 200 不再算验收通过。

本机原 AppData 可读数据库有 6 项目、19 运行，但监听服务返回空列表，锁记录与监听进程不一致。已生成并验证 SQLite 一致性备份，恢复到本仓库忽略目录 `.data/service`，保留原 AppData 数据；本机 `.data/service-directory.txt` 保存启动目录，显式 `-DataDirectory` 优先于此文件。该文件及服务数据不入 Git，不随代码推送到其他机器。不要删除 `.data`，它在本机承载正式服务数据。

重启后已核对 6 个项目的列表及详情。此修复明确服务数据位置并检测不一致，不宣称已查明 Windows 文件视图分离的底层原因。

验证：原 `.cmd` 入口再次重启后仍返回全部 6 个项目，当前聊天恢复原 session、revision 52、durable 绑定；`npm test` 339/339 通过（包含 Phase 0 与新增数据不一致/详情失败回归），无失败或跳过。

## 2026-09-05：项目列表突然为空

页面显示首次使用引导，但原数据库中仍有 6 个项目、17 条工作会话记录，SQLite 完整性检查通过。运行中的 `/api/v1/dashboard` 却返回 `projects: []`。

通过 Windows 文件句柄核对，服务进程打开的 `cockpit.db` 与该路径当前指向的文件具有不同文件 ID：前者主文件仅 4 KB，后者约 2.4 MB。`service.lock` 也出现同路径、不同文件 ID 的情况。主文件大小本身不能判断 SQLite 数据量，因为最新数据可能仍在 WAL 中；本次判断同时依据文件 ID、数据库查询和接口结果。

直接原因是运行进程持有旧文件，未读取路径当前指向的数据库。文件曾发生替换或重绑定；现有证据不能确定执行者、具体操作及时间，不应归因于某个 Agent，也不能当作已证实的数据库损坏或项目删除。

恢复时使用 SQLite backup API 创建包含已提交 WAL 数据的一致性备份，验证备份完整性及记录数量后，停止已核实身份的旧服务并重新启动。首次重启因旧锁获取失败而退出；确认进程退出及锁文件已不存在后再次启动成功，没有手工删除数据库或日志文件。

恢复后接口返回全部 6 个项目；浏览器项目列表、项目详情及 ugk-cockpit 的 46 个历史节点正常显示。原会话仍为 active，revision 49。此次没有修改业务代码或重新 init。

## 启动与维护要求

1. 服务返回 HTTP 200 或 `/health` 正常，只证明服务可响应。复用、启动或重启后，还应核对磁盘记录与 `/api/v1/dashboard` 的项目集合，并验证全部已有项目详情可加载；人工验收同时查看项目历史。已有项目的实例突然返回空列表时，不得报告启动验收成功。
2. 不得在服务运行时替换、恢复或同步覆盖实际所选数据目录中的数据库及其配套文件。默认目录为 Windows 的 `%LOCALAPPDATA%\UGK Cockpit`、macOS 的 `~/Library/Application Support/UGK Cockpit`、Linux 的 `$XDG_DATA_HOME/UGK Cockpit`（未设置时为 `~/.local/share/UGK Cockpit`）；本机保存的 `.data/service` 等自定义目录同样受保护。需要恢复或迁移数据时，先核实并停止占用服务，确认进程退出，再按 SQLite 一致性恢复流程处理。不要把运行中的目录当普通文件夹直接覆盖。
3. 备份使用 SQLite backup API（可复用 `src/core/backup.mjs` 的 `createConsistentBackup`），并验证备份可读；不要只复制 `cockpit.db` 而遗漏 WAL 中的已提交数据。
4. 不随意删除 `cockpit.db-wal`、`cockpit.db-shm`、`service.lock`，不以重新 init、重新添加项目或重置数据作为空列表的修复手段。
5. 不凭端口号批量杀进程。优先使用已有启动器；若监听进程与锁记录不一致，先检查进程命令行、文件句柄及接口身份。只有证明属于本项目服务后才可停止；证据不足时保留现场。

## 空列表排查顺序

1. 查看页面错误和列表接口响应，区分请求失败与成功返回空数组。
2. 核对服务使用的数据目录；只读查询其中的项目记录，并进行 SQLite 完整性检查。诊断输出不得包含 API token。
3. 若磁盘查询与服务接口不一致，核对监听 PID、锁 PID，以及服务已打开文件和当前路径的文件 ID。路径字符串相同不代表实际文件相同。
4. 对确认的旧文件句柄问题，先创建并验证一致性备份，再停止准确识别的旧服务，重新启动。若启动失败，先查看本次错误日志，不循环清锁或重置数据。
5. 刷新浏览器以更新服务重启后的会话凭据，验证项目列表、详情和历史记录。MCP 需要另行只读检查；若返回未绑定，遵循原有会话确认流程，不重新 init。

上述措施是操作约束与验收要求；当前服务尚未实现运行中文件替换的自动检测。文档不能保证外部程序不再替换文件，不能将本次记录描述为已部署自动防护。

后续发现的 ZCode MCP 认证故障及同路径不同凭据文件证据，见 [MCP 认证恢复记录](MCP_AUTH_RECOVERY.md)。认证恢复应在原聊天验收，不能仅以独立进程调用成功为准。


## alpha.36 升级验收（2026-09-05）

新增 schema 22 前使用一致性备份，停止经启动器核验的旧服务后迁移。26 张既有业务表前后内容摘要完全一致，6 项目/17 运行/25 任务/124 进展/21 接力保留，完整性和外键检查通过。备份位于 `%LOCALAPPDATA%\UGK Cockpit\backups\cockpit-before-durable-bindings-2026-09-05T04-32-17-497Z.db`。

服务升级不等于宿主已经加载新版 MCP 代码。原 Codex bridge 停止后曾返回 `Transport closed`；随后原聊天重连成功，经用户明确确认建立 `durable` 绑定，再次空参数 context 查询保持 `bound`、active、revision 49。不能用独立脚本调用成功代替原聊天验收。支持稳定宿主元数据的新版 bridge 使用数据库绑定，首次历史关联与不支持宿主的边界见 [会话身份与中断恢复](CONVERSATION_DURABILITY.md)。

12:47 最终迁移至 schema 23，先生成 `cockpit-schema-22-before-23-2026-09-05T04-47-06-404Z.db` 一致性备份；迁移前后 27 张既有表摘要完全一致，期间新增的进展也保留（125 条）。当前服务 PID 50588，项目列表与详情可读，完整性及外键检查通过。
