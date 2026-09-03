---
name: cockpit-closeout
description: 用户显式要求收束当前阶段时，先以可证明的 Preflight 发现并核对与阶段 delta 相关的 canonical 来源、完整工作区归属和验证证据，再有限修正、验证并形成本地 commit；在条件具备时可选登记指向本地 commit SHA 的非终态 Cockpit 检查点。
---

# UGK Cockpit 阶段收束

本 Skill 只能由用户显式调用（`$cockpit-closeout`），或作为用户明确选择 `outcome: "completed"` 的同一手动 handoff 工作流的伴随前置执行。它不后台或定时运行，不结束 Cockpit session，不自动 relay/handoff，也不把普通完成、commit 或测试通过当作收束授权。普通本地文档收束与 commit 独立成功；Cockpit progress 是可选登记，缺失或失败不阻断本地成果，也不阻断另行明确授权的普通 push。

## 硬门槛：两阶段且顺序不可交换

所有 closeout 必须严格经过：

```text
阶段一：Preflight（只读发现与证据绑定）
    ↓ 全部通过；任何本地事实缺失都 fail closed
阶段二：Alignment / Closeout（只修正确定问题、验证、形成或复用 HEAD）
    ↓ 本地收束与 commit 独立成功
可选平台登记：唯一一次非终态 ugk_work_progress（仅在具备有效 session、可信 revision 且工具可用时执行）
```

阶段一完成前禁止编辑、`git add`、commit、创建空提交或调用 `ugk_work_progress`。Preflight 可以发现确定的 alignment finding，但不能在发现阶段顺手修改；只有来源、范围、归属和证据都可证明时，才可进入阶段二。任一本地事实缺失、来源无法判定、状态输出被截断或改动无法归属，都必须停止，只作只读失败报告，不编辑、不暂存、不 commit、不 progress。Session 与 MCP 可用性不是本地硬门槛，缺条件跳过登记，不阻断本地阶段收束。

## 阶段一：Preflight

按下面顺序检查，并在成功报告中逐项列出实际结果。不要用“选中的文件里 grep 没有结果”代替来源发现或对齐结论。

### 1. 授权范围、收束 scope 与基线

- 通过当前已授权项目/工作副本和显式工作目录工作；不得读取、扫描或修改其他项目/仓库。先以 `git rev-parse --show-toplevel` 确认当前仓库边界。
- 把 session 和 MCP 可用性从本地硬门槛移走：本地 Preflight 与 Alignment 不以 active session 或 MCP 可用为前提，缺条件仅在阶段二完成后跳过平台登记，不阻断本地收束。确有本地事实缺失仍仅针对本地门槛停止。
- 明确一句 `收束 scope`：本阶段要收束的用户目标、代码/配置/文档/发布记录范围，以及明确不纳入的事项。scope 无法从用户请求、当前任务上下文或项目入口可靠确定时 fail closed。
- 还必须能明确说明本阶段基线、canonical 文档/配置/记录、收束范围和改动归属；任一项不明时只作只读失败报告。
- 明确 `baseline` 的完整 SHA、可核对的 ref（若有）和选择依据：基线可来自用户指定、当前任务已记录起点或项目明确阶段/版本记录（若已有 session/init 记录也可使用）。用 `git rev-parse --verify <ref>^{commit}` 核对引用；确认 baseline 是当前 `HEAD` 的祖先。不能用“最近一个看起来像基线的 commit”替代依据，不凭空选 SHA，也不把 remote 领先点自动当阶段基线。
- 明确当前 `HEAD` 的完整 SHA，并以同一 baseline 计算有限的 `stage delta`（当前阶段 delta），例如 `git log --oneline <baseline>..HEAD`、`git diff --name-status <baseline>..HEAD`；记录提交、路径类别和范围，不把整个历史当作本阶段 delta。baseline 不可核对、不是祖先或 delta 关系不清时 fail closed。

### 2. Canonical discovery：一跳、有界、区分当前与历史

canonical discovery 必须从当前授权项目自身的入口开始，不能从 Agent 预设文件名开始：

1. 先读取仓库根目录的适用 `AGENTS.md`，以及受影响路径上最近且实际适用的项目级 `AGENTS.md`；再读取根 `README.md`，若根 README 不存在，只能使用这些入口明确指定的等价入口。只读入口中明确声明的项目约定，不能借此扩大任务范围。
2. 只从这些入口中提取与本阶段 delta 相关的明确声明，例如“当前事实源”“唯一事实源”“版本台账”“发布记录”“配置说明”或同义表述，以及它们直接指向的路径。沿明确声明只追踪一跳，解析实际路径后读取该文件；不要递归跟随二级链接，也不要要求全仓扫描。
3. 对每个实际检查的路径记录 `current` 或 `archive/history` 及判定依据。archive/history 只能作为背景，不能冒充当前 canonical；同一主题同时有多个候选且入口没有消歧时 fail closed。缺失、不可读、链接无法解析、没有与 delta 相关的 canonical 声明，或无法判定哪一个是当前来源时，均 fail closed。
4. 将 stage delta 的每个可能改变当前事实的主题（代码行为、配置、版本、发布/运维记录等）映射到已发现的 canonical source，并实际核对当前事实。成功时列出所有实际检查过的 canonical 相对路径、类别、current/archive 判定和核对结果；不能因为某个候选文件没有匹配文本，就推断“全部 canonical 已对齐”。

不得为完成 discovery 扫描全仓、读取 secrets、凭据、API token、浏览器 profile、日志或构建产物，也不得把某个具体业务项目文件名硬编码成通用规则。

### 3. 完整工作区状态与改动归属

- 必须执行一次完整的 `git status --porcelain=v1 --untracked-files=all`。不得先过滤 `??`、只看 tracked 文件、截取前 N 行或以输出截断后的子集宣称“全部已核对”；命令输出若超过安全上限或无法解析完整，立即 fail closed。
- 对每一条 tracked/staged/unstaged/deleted/renamed/untracked 状态按路径做类别和数量统计，并标注归属：本次 Agent、已由阶段前明确记录的用户改动、或其他已明确授权来源。只使用路径/类别/数量核对归属，不读取文件内容；敏感或不明路径保持不读。
- 每一条改动都必须有可证明的归属和处理方式（保留、只修正、明确不纳入等）。任何无法归属、当前检查未覆盖、状态检查期间新增或无法解释的项都 fail closed；不得猜测为当前 Agent，也不得清理、覆盖或为了得到干净状态而 reset/checkout/stash。

### 4. 验证证据绑定到 source state

为每项测试、静态检查、构建或发布核对记录：命令（含必要参数）、结果、执行时间/来源，以及它对应的 source state（完整 commit SHA 或明确的工作树状态）。不默认运行昂贵的全量检查，只运行与本次确定性对齐直接相关的必要验证。

复用父提交或早先的证据时，必须证明证据仍适用于当前 `HEAD`：核对证据对应 SHA，检查其到当前 `HEAD` 的有限 delta，并说明这些变化不影响该验证；无法证明就重新运行相关验证。存在证据之后的未提交改动时，除非能证明验证覆盖同一工作树状态，否则不能复用。已有构建产物、远程截图或发布页面只能按其实际强度作为外部观察，不能写成当前 HEAD 的测试/构建证明。

### 5. Preflight 成功报告

Preflight 报告必须包含以下字段，缺任一字段不得进入阶段二：`baseline`（SHA、ref、选择依据）、`HEAD`、`stage delta`、`收束 scope`、`改动归属`、实际检查过的 canonical source 路径及 current/archive 判定、完整 tracked/untracked 分类与数量、验证证据及 source state（命令、结果、适用性），以及待处理的 alignment findings。只报告实际检查过的路径和证据，不用概括性“已全部核对”掩盖遗漏。

## 阶段二：Alignment / Closeout

1. 只处理由已核对的 baseline、canonical source 和当前事实共同确定的 alignment finding（确定的 canonical 对齐问题）。可确定的文档、配置或记录修正可以修改；不确定的语义、缺少来源或需要重构/升级依赖/补建台账的事项不得顺手处理，记录为未解决并停止。
2. 修改后重新核对受影响 canonical source、相关验证和完整工作区状态。任何新出现且未解释的路径、归属变化、验证失败或预期之外的 HEAD 变化都要停止；不要把“测试通过”当作文档已对齐的证据。
3. 有确定且已归属的改动时，只用明确文件路径暂存并创建本地 commit，提交后用 `git rev-parse HEAD` 核对完整 SHA；不得全量暂存。若本阶段没有改动且当前 `HEAD` 已有仍有效的验证证据，仅当证据绑定到该 SHA 时复用它，不得创建空提交。
4. 本地收束与 commit 独立成功：只要 alignment findings 已清零、必要验证成功、工作区状态与归属重新核对、且已形成或复用有效 `commit SHA`，本地文档收束与 commit 即告成功并独立确认。
5. 远端推送与保护：用户显式授权 push 时核对远端/分支并普通 push，不能被跳过或失败的 progress 阻塞；push 失败报本地已保存/远端未确认，不撤销本地 commit。没有 push 授权不上传，不 checkout/merge/stash/tag/release/force/reset/rebase/清理。

## 唯一一次非终态 progress

只有阶段二完成并核对有效 `commit SHA` 且具备活跃会话与 MCP 条件时，才调用一次 `ugk_work_progress`，这是 closeout 唯一的 progress 记录。不要因为 closeout 创建或复用的 commit 再额外触发通用 `$cockpit-progress`。如果环境已经对同一 closeout commit 记录了可信进展，直接复用该记录及其最新 `revision`，不再调用 progress、不要重复记录，也不得猜 revision。

本地成功后，只有同时具备已有 `active` Cockpit session、掌握最近一次成功 MCP 返回的可信 `sessionId` 和 `revision`、且工具可用时，才登记一次非终态 progress。缺少任一条件时安全跳过登记，向用户明确说明本地收束已成功、未登记平台检查点及具体跳过原因（无 active 会话 / 缺少可信 sessionId/revision / MCP 不可用；不把当前上下文缺信息推断为平台没有 active session）；不得扫描 DB、翻查旧消息或拼凑凭据，也不得要求用户执行 init/relay 来完成本地保存。

具备登记条件时，请求必须使用最近成功 MCP 返回的值，不得自行递增 `expectedRevision`，不得为绕过失败创建 session，并生成新的非空唯一 `clientRequestId`：

```json
{
  "sessionId": "<最近成功 MCP 返回的 sessionId>",
  "clientRequestId": "<本次请求唯一 ID>",
  "expectedRevision": <最近成功 MCP 返回的 revision>,
  "status": "working",
  "summary": "阶段收束检查点 commit:<已核对的完整 SHA>",
  "details": [
    "baseline/HEAD/stage delta/scope：<Preflight 结果>",
    "canonical sources 与 current/archive 判定：<实际相对路径和结果>",
    "完整 tracked/untracked 分类与归属：<路径类别/数量摘要>",
    "验证证据及 source state：<命令、结果、适用性>",
    "Agent-reported alignment：<修正或确认无 finding>"
  ]
}
```

请求的 `details` 只能提交 Agent 已完成的 Preflight/Alignment 事实，不得预填、猜测或声称任何尚未返回的 MCP-verified 值。

本地成功与平台登记分开汇报：

- 本地收束成果独立有效，先向用户报告本地成功与已核对的 `commit SHA`。
- 平台登记结果须明确区分未调用而跳过、MCP 明确拒绝/失败、已调用但回执缺失或传输不确定三种情况：未调用而跳过时如实说明未登记平台检查点及具体跳过原因。
- MCP 明确拒绝/失败：MCP 返回失败、revision 冲突等明确拒绝时，不得宣称成功；只向用户报告平台登记失败（说明原因与当前代码状态），绝不回滚、reset 或重做 Git 本地成果；不得自增 revision，也不得为绕过失败重新创建 session。
- 已调用但回执缺失或传输不确定：已调用但回执缺失、字段缺失或传输不确定时，只能报告结果未确认/不确定，不能断言失败或未登记，也不能声称已成功；传输结果不确定时，只能用同一个 `clientRequestId` 重试完全相同的 payload；重试后仍不确定时须如实标明结果未确认/不确定，绝不回滚、reset 或重做 Git 本地成果，本地成果不受影响。
- 工具成功返回后，用户报告才把两类事实分开：`Agent-reported alignment` 只描述 Agent 实际发现、修正和验证的内容；`MCP-verified Git/session` 只描述 `ugk_work_progress` 实际返回的 session/revision/status/服务端 Git 事实，不能让 MCP 响应替 Agent 证明文档语义对齐。`status` 只能是 `working` 或 `in_progress`，不得伪造终态。

向用户展示成功结果时使用两个独立小节：

## Agent-reported alignment

列出实际核对的 canonical 路径、alignment finding 的修正或“无 finding”结论、验证证据及 source state；不要把 MCP 返回当作文档语义证据。

## MCP-verified Git/session

只列工具实际返回的 `sessionId`、`revision`、非终态 `status` 及服务端 HEAD/coherence 等 Git/session 事实；跳过登记时如实说明未登记，MCP 明确失败时说明登记失败，已调用但回执缺失或传输不确定时只能说明结果未确认/不确定（不得断言失败或未登记，也不得声称已成功），不得伪造或推断已记录。

## 失败报告与边界

fail closed 时说明：发生了什么、代码是否受影响、哪个门槛或事实无法证明、已发现的路径/数量范围，以及推荐的安全下一步。

- 本地门槛失败：canonical 无法判定、完整状态未覆盖、归属不明、必要验证未通过或证据失效时，只向用户报告，不编辑、暂存、commit 或 progress。确有本地事实缺失仍仅针对本地门槛停止。
- 平台登记跳过或失败：缺少 active session、缺少可信 sessionId/revision、MCP 不可用、revision 冲突或工具报错时，只作为平台登记未完成/失败报告，不否定本地已完成成果，不撤销或回滚本地 commit。
- 保持安全底线：保留所有既有改动；不读/存 secrets、凭据、API token、浏览器 profile、日志或构建产物；不后台扫描，不跨授权仓库，不自动 relay 或 handoff；没有显式 push 授权不上传，不 checkout/merge/stash/tag/release/force/reset/rebase/清理。
