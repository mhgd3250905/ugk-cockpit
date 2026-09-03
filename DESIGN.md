# UGK Cockpit 前端设计系统规范

- **设计定位**：本机控制台 · Mission Control Product UI
- **视觉风格**：深色优先的暖中性控制台，强调真实状态、清晰行动和代码安全
- **基准标准**：WCAG 2.2 AA / Responsive Fluid Grid / Zero-Dependency Web
- **主题**：默认深色，提供亮色，并支持跟随系统；由用户手动选择并持久化

## 1. 信息架构

页面保持单向、可快速扫描的工作简报结构：

```text
Mission Control Shell
├── 顶部产品区：产品名、版本、本机服务状态、手动刷新、添加项目
├── 全局通知：发生了什么、影响、下一步和可用重试
├── 项目矩阵：待确认、工作会话、准备就绪、日常维护/暂时放下（按行动状态分组）
└── Focus Modal：添加项目、创建或重新生成接入指令
```

普通界面使用“项目、代码位置、AI 工作会话、接手记录”等自然语言。路径、内部 ID 和底层状态只在“技术详情”中出现。

## 2. 颜色与 Design Tokens

采用暖中性画布、单一安全橙强调。**深色为默认主题**，亮色主题通过 `<html data-theme="light">` 覆盖同名令牌。

组件一律**只引用语义令牌**，不出现硬编码色值——这是双主题能保持一致的前提。

```css
:root {
  /* 深色（默认） */
  --surface-app: #14120f;
  --surface-card: #1c1917;
  --surface-raised: #252220;
  --surface-sunken: #0f0e0c;
  --border-subtle: #322d29;
  --border-card: #3f3833;
  --border-control: #72685f;
  --ink-primary: #f2efe9;
  --ink-secondary: #d8d3cb;
  --ink-muted: #a8a29e;
  --ink-faint: #948d85;
  --accent: #f97316;
  --accent-hover: #fb923c;
  --accent-text: #fb923c;
  --accent-ink: #1c1105;
  --accent-soft: #2b1a0e;
  --accent-soft-border: #7c4a1d;
  --timeline-main-line: #f97316;
  --timeline-space-line: #62a6ad;
  --timeline-space-alt-line: #b18b9d;
  --timeline-space-third-line: #a3a36c;
  --timeline-unknown-line: #8d8880;
  --timeline-connector: #554d45;
  --state-attention-bg: #2b1a0e;  --state-attention-border: #7c4a1d;  --state-attention-text: #fb923c;
  --state-active-bg: #10241d;      --state-active-border: #2f6b52;      --state-active-text: #34d399;
  --state-ready-bg: #2a2410;       --state-ready-border: #6b5a1e;       --state-ready-text: #facc15;
  --state-paused-bg: #22201e;      --state-paused-border: #45403c;      --state-paused-text: #b8b2ab;
}

:root[data-theme="light"] {
  --surface-app: #f5f2ec;
  --surface-card: #fffdf9;
  --surface-raised: #ffffff;
  --surface-sunken: #f1ece4;
  --border-subtle: #e3dbce;
  --border-card: #d8cec0;
  --border-control: #8a8177;
  --ink-primary: #17202e;
  --ink-secondary: #374151;
  --ink-muted: #5b6472;
  --ink-faint: #6b7482;
  --accent: #c2410c;
  --accent-hover: #9a3412;
  --accent-text: #9a3412;
  --accent-ink: #ffffff;
  --accent-soft: #fff7ed;
  --accent-soft-border: #fdba74;
  --timeline-main-line: #c2410c;
  --timeline-space-line: #167982;
  --timeline-space-alt-line: #8f4f70;
  --timeline-space-third-line: #697029;
  --timeline-unknown-line: #77706a;
  --timeline-connector: #c6bbad;
  --state-attention-bg: #fff7ed;  --state-attention-border: #fdba74;  --state-attention-text: #9a3412;
  --state-active-bg: #ecfdf5;     --state-active-border: #6ee7b7;     --state-active-text: #065f46;
  --state-ready-bg: #fefce8;      --state-ready-border: #fde047;      --state-ready-text: #854d0e;
  --state-paused-bg: #f1ece4;     --state-paused-border: #d8cec0;     --state-paused-text: #55606e;
}
```

对比度（对卡片底色实算，均满足 AA）：

- 深色正文 15.24:1、次要 11.74:1、弱化 6.93:1、最弱 5.34:1。
- 深色强调按钮：`#1c1105` 文字 on `#f97316` 为 **6.62:1**；同底白字只有 2.80:1，**深色主题必须使用深字**。
- 亮色强调按钮：白字 on `#c2410c` 为 5.18:1。
- 四类状态徽标文字对其背景均 ≥ 5.44:1。

- **状态色不铺满卡片**：卡片一律 `--surface-card`，状态色只用于左侧色条（3px，待确认类加粗到 4px）与状态徽标。靠这个约束避免"便签墙"观感。
- 深色下阴影几乎不可见，层次由**背景差 + 1px 边框**承担，不靠投影。
- 正文、状态和动作必须同时用文字表达，颜色只作辅助编码。
- 不使用蓝紫渐变、玻璃拟态、纸张纹理或装饰性噪点；图标为内联 SVG，不使用字符字形。

## 2.1 主题切换

- 首绘前由 `web/public/assets/theme-boot.js` 读取 `localStorage['ugk-cockpit-theme']`（`light|dark|system`，缺省 `dark`），写入 `documentElement.dataset.theme`、`style.colorScheme` 以及单个 `theme-color` meta 元素（使 Windows 原生滚动条、表单与浏览器外框色彩同步跟随）。
- 该脚本位于 `assets/` 下并以经典同步脚本引入，因此**满足 CSP `script-src 'self'`，无需 nonce，也无需改动服务端静态资源白名单**。
- `prefers-color-scheme` 监听**在"跟随系统"模式下实时生效**，并在系统变化时同步更新 `dataset.theme`、`style.colorScheme` 与 `theme-color` meta 标签；手动选择亮色或暗色时不会被系统变化覆盖。
- 界面右上角提供「亮色 / 暗色 / 跟随系统」分段控件，用 `aria-pressed` 标注当前项。

## 2.2 排版基线（中文）

- 字重只允许 **400 / 600 / 700**：Windows 上的 Microsoft YaHei 只有 400 与 700，`650/740/760` 会被量化导致层级丢失。
- **中文禁用负字距**：正文 `letter-spacing: 0`，标题最多 `-0.01em`。
- 字号下限 **11px**；中文 `line-height` ≥ 1.5。
- 等宽字体族末尾补 `"Microsoft YaHei UI"`，否则中英混排会基线跳动。


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
- 卡片只使用轻微、低透明度的柔和阴影，避免厚重悬浮效果；深色主题下层次改由背景差与边框承担（深色阴影不可见）。
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

- Primary：深橙底、白字（深色主题下反转为深墨字）、1px 同色边框；hover 使用更深橙。
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

工作线时间线在左侧保留稳定多轨图带，主项目使用暖橙，开发空间使用低饱和区别色，状态色只表达事件状态。卡片共用同一左边界，节点到卡片使用淡连接段；卡片顶部依次突出工作副本、事件类型和时间，Agent、工作线名称与代码保存点作为次要证据。按 `worktreeId`/开发空间身份归轨，不按相邻事件、Agent 或分支名推断关系；来源未知时使用独立中性轨。点击任意轨道节点或卡片空白处突出整条工作线，其他卡片仍保持原位并保留可读正文；「显示全部」恢复默认。分支创建来源只在有平台来源记录时绘制，主项目接入只接受真实 `integrated` 回执；送审、审核通过和普通交接均不绘制合流。

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
