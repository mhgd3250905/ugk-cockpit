# Agent 平台标志来源

2026-10-01 收集，用于项目总览和详情标题的「Logo + 平台名」标签。两处共用本地资产与平台匹配规则；标题标签取自主项目记录，会话弹窗按所选工作线显示实际平台。只标明工作会话来源，不表示平台为 Cockpit 背书或 AI 进程在线。

| 展示平台 | 仓库资产 | 官方来源 | 原始尺寸 |
| --- | --- | --- | --- |
| Codex | `web/public/assets/agent-openai.png` | [OpenAI Developers favicon](https://developers.openai.com/favicon.png)，由 [Codex 官方文档页面](https://developers.openai.com/codex/)的 `rel=icon` 引用 | 48×48 PNG |
| ZCode | `web/public/assets/agent-zcode.png` | [ZCode 官方 favicon](https://zcode.z.ai/favicon-192x192.png?v=20260707-transparent)，由 [ZCode 官网](https://zcode.z.ai/cn)的 `rel=icon` 引用 | 192×192 PNG |

Codex 标签使用 OpenAI 官方平台标志，不把它描述为单独的 Codex 产品专用图标。图像原样本地保存，展示时保持比例，不改色、重绘或增加图形元素。标志与商标属于相应平台；OpenAI 标志使用约束见[官方品牌说明](https://openai.com/brand/)。

平台名来自既有项目工作记录；仅匹配明确的 `Codex`、`ZCode`（忽略大小写与首尾空白）使用相应图标。未知平台保留原名、不借用其他平台标志；无平台记录显示「平台未记录」。图像加载失败时保留文字，页面仍可使用。

运行时请求只访问本地静态资产，不热链官网，不增加外部连接或改变 CSP。资产采用静态服务允许的 `/assets/<文件名>` 扁平路径。
