---
name: cockpit-closeout
description: 用户显式要求收束当前 Cockpit 阶段时，对已知阶段 delta 做有限对齐、验证并记录指向本地 commit SHA 的非终态检查点。
---

# UGK Cockpit 阶段收束

本 Skill 只能由用户显式调用（`$cockpit-closeout`），或作为用户明确选择 `outcome: "completed"` 的同一手动 handoff 工作流的伴随前置执行。它负责把当前阶段的事实收束到一个可核对的本地 `commit SHA`，但不结束 Cockpit session，也不自动触发交接；不后台或定时运行。

## 前置条件

只在已有 `active` Cockpit session 且掌握最近一次成功 MCP 返回的可信 `sessionId` 和 `revision` 时工作。`sessionId` 与 `revision` 不得猜测、从旧消息拼接或自行递增；缺任一项时停止实际收束，只向用户报告需要先接入或恢复会话。

还必须能明确说明本阶段基线、canonical 文档/配置/记录、收束范围和改动归属。任一项不明，或当前工作区含无法归属的用户改动时，停止实际收束并给出只读报告；不替用户猜测、不覆盖或清理这些改动。

## 收束流程

1. 只核对当前阶段 delta 和已知事实。使用显式工作目录、有界输出的 Git/文件检查，确认当前 `HEAD`、已知改动和目标 canonical 文件；只在当前已授权项目/工作副本内工作，不得扫描或修改当前项目之外的其他项目/仓库。
2. 只修正可由基线、canonical 来源和当前事实确定的对齐问题，例如已知的文档、配置或记录不一致。不要顺手重构、升级依赖、补建台账，或修改实现来迎合不确定的记录。secrets、凭据、API token、日志/构建产物和不明用户改动不得读取、暂存或提交。
3. 仅运行与本次确定性改动直接相关的必要验证。验证失败、范围扩大、归属不明或发现新的未解释变化时停止，不把阶段说成已收束。
4. 若有确定且已归属的改动，只用明确文件路径暂存并创建本地 commit；不得使用全量暂存。提交后读取并核对 `HEAD` 的完整 SHA。不要 `reset`、`checkout`、`stash`、清理、merge、tag、push 或发布到远端。
5. 若本阶段没有改动且当前 `HEAD` 已有仍有效的验证证据，直接复用该 `HEAD`，不得创建空提交。若没有有效证据，只补做必要验证；验证仍不成立时停止。

## 记录非终态检查点

只有已经得到并核对有效 `commit SHA` 后，才调用一次 `ugk_work_progress` 记录收束检查点；这是 closeout 唯一的 progress 记录。不要因为 closeout 创建或复用的 commit 再额外触发通用 `$cockpit-progress`。若环境已对同一 closeout commit 记录了可信进展，直接复用该记录及其最新 `revision`，不再调用 progress、不要重复记录，也不得猜 revision。请求使用最近成功 MCP 返回的 `revision` 作为 `expectedRevision`，不得自行递增；生成新的非空 `clientRequestId`，并保持以下非终态字段：

```json
{
  "sessionId": "<最近成功 MCP 返回的 sessionId>",
  "clientRequestId": "<本次请求唯一 ID>",
  "expectedRevision": <最近成功 MCP 返回的 revision>,
  "status": "working",
  "summary": "阶段收束检查点 commit:<已核对的完整 SHA>",
  "details": [
    "<本次核对或必要验证的事实>",
    "<复用 HEAD 或修正的 canonical 对齐项>"
  ]
}
```

`status` 只能是 `working` 或 `in_progress`，不得用它伪造终态。MCP 返回失败、revision 冲突、结果不确定或未形成 `commit SHA` 时，不得记录成功，也不得向用户声称完整收束；传输结果不确定时用同一个 `clientRequestId` 重试完全相同的请求，不要再次提交。成功后仅报告 commit SHA、验证事实和新的 revision，等待用户另行选择下一步。

阶段完成、commit 成功、测试通过或上下文堆积都不能隐式触发本 Skill；本 Skill 成功后保持 session active，不自动 relay 或 handoff。它不创建或强制台账仓库，不管理账号或秘密，也不执行外部写入。

## 失败报告

停止时说明：发生了什么、代码是否受影响、哪些事实或范围无法证明，以及推荐的安全下一步。MCP 报错或不可用时，明确说明无法连接或启用 `ugk-cockpit` 本地 MCP，并不要声称已记录检查点。保留所有现有改动；不要为了得到 SHA 而创建空提交、猜测归属或放宽边界。
