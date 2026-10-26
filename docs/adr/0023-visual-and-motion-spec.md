# 视觉与动效口径

本仓库的视觉、版式与动效规格只有一处实现真身：

- [`src/renderer/styles/tokens.css`](../../src/renderer/styles/tokens.css) —— 颜色、半径、字号、间距、阴影与状态刻度。
- [`src/renderer/shared/motion.ts`](../../src/renderer/shared/motion.ts) —— 动效预设（时长、缓动、变体）。
- [`src/renderer/styles/index.css`](../../src/renderer/styles/index.css) —— 把 token 映射成 Tailwind 工具类。

文档不再单独维护一份视觉规范；实现即规范。本 ADR 只记录**不能从代码直接读出的取舍理由**。

## 决定

### 1. Token 链只有一条

Tailwind 4 `@theme` → CSS 变量 → 组件类名。组件里禁止写死 hex，也禁止并行引入第二套样式入口。颜色一律走语义 token（`--ink` / `--surface` / `--line` / `--accent` / `--st-*`），不直接用调色板变量。

### 2. 圆角四档：6 / 8 / 12 / 16

`--r-chip` 6（胶囊、分段轨道的内按钮）/ `--r-control` 8（控件、输入、列表行）/ `--r-card` 12（卡片、弹出层、抽屉）/ `--r-window` 16（模态面板）。层级归属跟着刻度走：控件类元素用 `rounded-control`，不要一律用 `rounded-card`。

### 3. 字号角色

界面正文 13px（`--font-body-size`）、chrome 与元信息 12px（`--font-meta-size`）、微信息 11px（`--font-micro-size`）、阅读区 14px（`--font-read-size`，可切 16px 大号）。标题 24 / 18 / 14。正文对比度 ≥ 4.5:1；`--subtle` 是最弱一档，低于正文尺寸时不能只靠颜色表达状态。

### 4. 栏序：左栏 | 助手 | 画布

助手夹在左栏与画布之间，画布占右边缘。列宽由分隔条调整（分隔条在助手**右**侧，向右拖是变宽），画布至少保留 360px。`≤ 1099px` 时左栏与助手都改为抽屉。

### 5. chrome 的选中态是单色，`--accent` 只留给主操作与焦点

画布 tab 指示条、左栏与文献中心的 tab 轨道、管理抽屉的 tab 都用单色（深色主题近白、浅色近黑）。整条 chrome 没有第二个颜色；颜色只出现在**类别图标**上。

### 6. 类别色相是 token

`--icon-file` / `--icon-code` / `--icon-literature` / `--icon-latex` / `--icon-terminal` / `--icon-git` / `--icon-agent` / `--icon-manage` / `--icon-rag` / `--icon-wiki` / `--icon-graph` / `--icon-memory` / `--icon-skill` / `--icon-mcp` / `--icon-task`。深色主题用 400 档，浅色主题降到 600 档，保证同一色相在两套主题下都 ≥ 3:1。组件不得写颜色字面量。

### 7. 动效

- 引擎统一用 `motion/react`，`main.tsx` 挂 `MotionConfig reducedMotion="user"`。
- 画布模块就绪后直接切换，冷加载期间保留当前画布；已访问视图在同一项目内保留挂载、滚动与编辑状态，切换项目清空。画布 tab 指示器继续使用共享 `layoutId` 弹簧滑动。
- 浮层有进有出：模态 180ms 缩放、抽屉 200ms 右侧滑入、遮罩淡入淡出。
- 折叠块用原生 `<details>` + `::details-content` + `interpolate-size: allow-keywords`，两端都是真动画，语义不动（键盘、读屏、流式期间可用都来自原生元素）。
- 不为动效保留死代码：没有调用点的工具类删掉，不养第二套词汇表。
- **动效额度由闸门守，不由注释守**：`pnpm check:renderer-chunks` 的 `1,700,000 B` eager 预算是唯一额度真身。

### 8. 助手转录与门户的几何

- 消息行 `px-4`，消息间距 24px，一轮助手内部块间距 12px；用户气泡 `max-w-[85%]`、圆角 12px、`rounded-br-sm`、`px-4 py-3`、13px。
- 活动块标题行 `px-3 py-2`（13px 图标与 chevron），块内容 `px-3 py-2.5`。
- 输入区是**一张卡片**（圆角 16px、`p-3`、有阴影），控制行在卡片内。
- 三列背景同色，只用 hairline 分隔；只有终端主题固定为深色。
- 项目门户：容器 `max-w-6xl` + `px-4 sm:px-6 lg:px-8 py-8 gap-6`；标题 `text-xl sm:text-2xl font-semibold tracking-tight` + 计数徽标 + 底部 hairline；网格 `grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5`；卡片内边距 `p-4`。键盘方向键的列数从布局读（`getComputedStyle`），所以改断点不会让上下移动落错。

## 有意为之的取舍

| 做法 | 因为 |
| --- | --- |
| 不画假红绿灯 | 窗口是 `titleBarStyle: 'hiddenInset'` + 真实 `trafficLightPosition`，自绘会多出六个灯 |
| 助手头部不做模型下拉 | `settings.save` 是**整文档**保存，设置中心持有脏草稿；助手再开一个写入口就是整文档资源的第二个写者。pill 指向设置中心，尾随图标用 `Settings2` |
| 空会话不放欢迎英雄区与示例提示词 | 示例提示词是演示数据；空态直接进输入框 |
| 工具状态是**带文字的状态 pill** | 颜色之外还有标签与图标，两套主题都能分辨 |
| 客户端不校验模型 pill 显示名 | 显示名来自设置文档，渲染层不复制一份 |
| 设置浮层宽 `min(1100px, 92vw)` | 12 个分区、每区多行表单，更窄会把字段挤成两行以上 |
| 管理抽屉宽 720px | 四个分区里有 markdown 编辑器 + 大纲、文件浏览器 + 预览，更窄会把编辑器和上下文分成两次滚动 |
| 文件预览由文件面板持有 | `?file=` 是唯一选中状态，宿主在左栏；预览不另建全屏模态 |
| 终端铺满画布，只在底部留一行 cwd / 状态 / 尺寸 / 重启 / RTK | 头部会吃掉终端行数 |

## 代价

- **栏序不能随手改回去**：助手在左栏与画布之间，改回右列要同时改 `WorkspaceLayout` 的渲染顺序与分隔条符号。
- **`--r-chip` 是新增 token**：组件今后写 `rounded-chip` 而不是 `rounded-md`；`--r-xs` / `--r-sm` / `--r-md` / `--r-lg` 是旧拼写别名，不要在新代码里用。
- **助手转录偏松**：块间距 12px、消息间距 24px，同样内容占的竖向空间更多。
- **动效有实打实的字节成本**：eager 体积约 1.32 MB（预算 1.7 MB）。再加 markdown 或编辑器类依赖前要先量。
