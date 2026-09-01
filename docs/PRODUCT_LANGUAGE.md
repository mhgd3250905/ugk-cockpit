# 产品语言规范

普通用户界面隐藏实现术语，只在“技术详情”中显示原始名称。

| 内部术语 | 普通界面用语 |
| --- | --- |
| Repository | 代码位置 |
| Worktree | 工作副本 |
| Branch | 工作线 |
| HEAD / Commit | 代码保存点 |
| Dirty | 尚未保存到版本记录的本地改动 |
| Run | AI 工作会话 |
| Snapshot | 开始前状态 / 结束时状态 |
| HandoffReceipt | 接手记录 |
| Write lease | 当前有人正在编辑 |
| Heartbeat | 最近活动 |
| Stale | 可能已中断 |
| Drift | 上次记录后代码发生变化 |
| Takeover / Supersede | 接管旧会话 |
| Unattributed | 还不知道是谁产生的改动 |
| Foreign change | 工作期间来自其他地方的更新 |
| Incoherent snapshot | 检查时代码仍在变化 |
| Unknown | 暂时无法确认 |
| Recovery uncertain | 上次操作可能中断，需要确认 |
| Idempotency conflict | 这个操作编号已用于另一项操作 |

这些状态必须同时给出推荐动作：未归属改动可“登记 / 暂不登记”；外部更新可“查看变化 / 稍后处理”；检查中变化只能“刷新后重试”；恢复不确定只能“继续恢复 / 查看详情”，不得显示绿色完成。

错误信息必须依次表达：

1. 发生了什么。
2. 是否影响代码或记录。
3. 推荐的安全动作。

示例：

> 另一个 AI 正在编辑这份代码。你的代码没有被修改。建议先只读查看；如需接管，我们会再次确认。

API 和界面错误统一包含 `message`、`impact`、`required_action`、`next_command` 和 `warnings`。内部异常消息不能直接显示给用户。

