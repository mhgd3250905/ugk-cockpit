# UGK Cockpit 前端设计系统规范

- **设计定位**：本机控制台 · Mission Control Product UI
- **视觉风格**：温暖克制的本地工具界面，强调真实状态、清晰行动和代码安全
- **基准标准**：WCAG 2.2 AA / Responsive Fluid Grid / Zero-Dependency Web

## 1. 信息架构

页面保持单向、可快速扫描的工作简报结构：

```text
Mission Control Shell
├── 顶部产品区：产品名、版本、本机服务状态、手动刷新、添加项目
├── 全局通知：发生了什么、影响、下一步和可用重试
├── 首要关注：最需要决策的项目、真实原因、唯一主动作或只读引导
├── 项目分组：待确认、推进中、准备就绪、维护/暂时放下
└── Focus Modal：添加项目、创建或重新生成接入指令
```

普通界面使用“项目、代码位置、AI 工作会话、接手记录”等自然语言。路径、内部 ID 和底层状态只在“技术详情”中出现。

## 2. 颜色与 Design Tokens

采用暖中性画布、深墨蓝文字与深橙关键动作。深色首要关注卡用于形成明确层级，但不扩展成暗黑主题。

```css
:root {
  --bg-app: #f5f2ec;
  --bg-card: #fffdf9;
  --bg-subtle: #f1ece4;
  --bg-muted: #e7e0d5;
  --border-subtle: #e1d8ca;
  --border-strong: #cbbdab;
  --ink-primary: #172033;
  --ink-secondary: #374151;
  --ink-muted: #5f6875;
  --accent-primary: #c2410c;
  --accent-hover: #9a3412;
  --accent-focus: rgba(194, 65, 12, 0.35);
  --hero-bg: #172033;
  --state-attention-bg: #fff7ed;
  --state-active-bg: #ecfdf5;
  --state-ready-bg: #f0fdf4;
  --state-paused-bg: #f1ece4;
}
```

- `#c2410c` 上的白色文字对比度约为 **5.18:1**，满足普通字号 WCAG AA。
- 正文、状态和动作必须同时用文字表达，颜色只作辅助编码。
- 不使用蓝紫渐变、玻璃拟态、纸张纹理或装饰性噪点。

## 3. 字体与排版

产品界面统一使用系统中文 Sans，提高 Windows 本地工具的清晰度与稳定性：

```css
font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
  "Hiragino Sans GB", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif;
```

- 产品标题：20–24px，700–800 字重。
- 页面与分组标题：17–24px，700–800 字重。
- 卡片标题：18–24px，700–800 字重。
- 正文与状态说明：13–15px，行高 1.45–1.6。
- 元信息与徽标：11–12px，但仍须满足文字对比度。
- 接入指令、路径和哈希使用系统等宽字体。

不使用装饰性标题字体或超大展示文字。

## 4. 形状、边框与阴影

- 主要卡片和模态框使用 **8–12px** 圆角。
- 按钮、输入框与紧凑信息块可使用 **4–8px** 圆角，以保持清晰密度。
- 实体组件使用 1px 中性边框。
- 卡片只使用轻微、低透明度的柔和阴影，避免厚重悬浮效果。
- 间距使用 4 / 8 / 12 / 16 / 20 / 24 / 32 / 48 / 64px 比例。

## 5. 状态与动作

所有项目状态必须映射为真实展示和真实动作：

| 状态 | 展示与动作原则 |
| --- | --- |
| `ready_to_start` | 可创建新的 AI 接手任务 |
| `preexisting_changes` | 明确已有改动会保留，再允许继续 |
| `status_check_incomplete` | 只执行 dashboard 重新检查 |
| `assignment_waiting` | 显示原 Agent/目标，只重新生成一次性接入指令 |
| `active_work` | 展示 Agent、目标和最近进展，不重复分配 |
| `relay_waiting` | 展示接力摘要，不创建新 assignment |
| `agent_waiting` | 提示回到已接入的 Agent 会话安排任务，不重复分配 |
| `user_paused` | 强制暂停视图，不创建 assignment |

后端未提供的动作不得伪装成可点击按钮。只读状态使用说明标签，不使用虚假 CTA。
`active_work` 只表示工作会话已经接入且尚未交接，不表示 Agent 进程当前在线；heartbeat、活动时间和 service 重启不得改变这一普通界面状态。

## 6. 组件与反馈

### 按钮

- Primary：深橙底、白字、1px 同色边框；hover 使用更深橙。
- Secondary：暖白底、深墨蓝字、中性边框。
- Disabled 只用于确有控件语义但暂不可用的动作；纯状态说明使用非交互标签。
- `:focus-visible` 使用 3px 深橙轮廓和 3px offset。

### 通知

所有错误通知使用 `role="alert"`，分别展示：

1. `message`：发生了什么；
2. `impact`：代码与记录是否受影响；
3. `required_action`：用户下一步；
4. 仅在存在真实动作时显示重试按钮。

### 模态框

- 使用 `role="dialog"`、`aria-modal="true"`、`aria-labelledby`。
- 打开后焦点进入并约束在 modal 内；关闭后回到原触发元素。
- 轮询或内容刷新不得抢走当前输入焦点。
- 写操作进行中禁止按钮、背景点击和 Escape 关闭。
- reissue 模式只读展示原任务目标，并明确只更新接入码和 Agent。

## 7. 响应式

| 区间 | 布局 |
| --- | --- |
| `>= 1180px` | 最大宽度约 1200px；项目卡两列 |
| `769–1179px` | 保持弹性两列，缩减间距 |
| `<= 768px` | 顶部操作纵向、项目卡单列、主动作满宽、modal 接近满宽 |

移动端活跃进展摘要最多显示两行，避免长文本挤压主动作；完整信息仍可在后续详情中读取。

## 8. 动效与无障碍

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

- 正常正文文字对比度至少 4.5:1；大字和非文字控件至少 3:1。
- 状态始终包含文字徽标、标题和说明，不只依赖颜色。
- 使用语义化 `main`、`header`、`section`、`article`、`details`。
- loading、stale 和失败状态都必须诚实反映最后已确认的数据时间。
