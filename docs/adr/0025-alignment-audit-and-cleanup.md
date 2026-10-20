# 对齐审查：视觉以 `research-studio` 为准 + 死类、脚手架与测试数据清理

> 本轮由用户裁定两件事：**`research-studio` 是唯一视觉/版式/动效标准**（不是「MASTER 规定之外才参考」），
> 以及**清理测试数据与 smoke 数据**。ADR 0023 已经把动效拉回参考，这一次把**版式与视觉效果**也拉回去，
> 并处理三项长期没被清理的东西：参考目录里的 AI Studio 脚手架、产品代码里的死类、磁盘上的运行残留。

## 方法

逐面 diff（`research-studio/src/**` ↔ `src/renderer/**`），每个差异必须落到三类之一，并在下面写清依据：

1. **无意漂移** —— 没有任何规范或注释声明过它，直接改回参考；
2. **有意保留** —— 参考的做法会破坏契约、可访问性或数据真实性，保留现状并把理由写在这里；
3. **本仓自己的面** —— 参考里不存在（阶段、闸门已在 ADR 0024 处理；守卫/子代理/审批块等富块属于此类），
   只对齐它们的**外观**（半径、字号、间距、色相），不动结构。

机械核对过、**无需改动**的部分（避免后来者重新查一遍）：无硬编码 hex（只有终端读 CSS 变量的 fallback）、
无 `cursor: pointer`、无 emoji 图标、无裸 `text-xs/sm`（全部走 `--font-*` token）、字号角色映射与参考一致
（12px 正文 / 11px 元信息）、动效预设逐条对得上、无假数据填充空态。

## 决定

### 1. 圆角回到参考的四档：6 / 8 / 12 / 16

参考没有自创刻度，它用 Tailwind 的：`rounded-md` 6px（40 处，胶囊与轨道内按钮）、`rounded-lg` 8px（222 处，
控件 / 输入 / 列表行）、`rounded-xl` 12px（63 处，卡片 / 弹出层 / 抽屉）、`rounded-2xl` 16px（13 处，模态面板）。

MASTER v2 §1.4 曾把它收紧成 6 / 8 / 10 作为 v1→v2 修正 —— **该条作废**。`tokens.css` 改为
`--r-chip` 6 / `--r-control` 8 / `--r-card` 12 / `--r-window` 16，并按参考的**层级归属**（不是只改数值）
把控件类元素从 `rounded-card` 降到 `rounded-control`：窗口壳按钮、画布 tab、左栏与文献中心的 tab 轨道
（轨道 `--r-control`、内按钮 `--r-chip`，与参考的 8 / 6 完全一致）、助手头部的模型 pill 与其重置按钮。

### 2. 三个死动效工具类删除（ADR 0023 的「原样搬回」一条作废）

`index.css` 里 `animate-fadeIn` / `animate-scaleIn` / `animate-slideInRight` 在**本仓从未被使用**：参考里唯一
活着的调用点是项目门户的三个表单模态（它的 `animate-in …` 类因为没装 `tailwindcss-animate` 全是死类），
而这里的每个浮层都是 `ModalShell`，用 `shared/motion.ts` 的变体实现了同样的两个入场（还补上了出场）。

结论：动效真身只有 `shared/motion.ts`（JS）与 `::details-content`（唯一必须由 CSS 承担的那条）。
保留一份永远不运行的 CSS 词汇表等于第二套规范，删掉；依据写在 `index.css` 的注释里。

### 3. 画布与 chrome 的选中态是单色，`--accent` 只留给主操作与焦点

参考画布 tab 的指示条是 `bg-zinc-200`（深色下近白的墨线），左栏与文献中心的 tab 轨道是**抬起的单色 chip**，
管理抽屉的 tab 也是。整条 chrome 没有第二个颜色 —— 颜色只出现在**类别图标**上。

本仓原来把画布 tab 指示条写成 `--accent`，那是这条 shell 里唯一一处彩色 chrome。改回单色 `bg-ink`
（深色近白、浅色近黑，两套主题都清晰）。

### 4. 类别色相按参考逐面重排

- `--icon-file` 从 sky 改为 **amber**：参考的左栏「文件」tab 是 `FolderTree ... text-amber-400`，
  文件树里的目录与 `.tex` 行共用这个色相。
- 新增 `--icon-code`（参考 `text-blue-400`）：文件树按文件类型分色，目录/LaTeX = amber、`.bib` = 文献天空蓝、
  源码 = 蓝、其余 = 灰。

### 5. 助手转录的几何按参考重排

参考：消息行 `px-4`、消息之间 24px（`space-y-6`）、一轮助手内部块间距 12px（`space-y-3`）、
用户气泡 `max-w-[85%] rounded-2xl rounded-br-sm px-4 py-3 text-[13px]`、活动块标题行 `px-3 py-2`（13px 图标、
13px chevron）、块内容 `px-3 py-2.5`、输入区是**一张卡片**（`rounded-2xl p-3 shadow-md`，控制行在卡片内）。

本仓原来是行 `px-3 py-1.5`、块间距 4px、活动块 `px-2 py-1.5` 且自带 `my-1`（与父级 gap 叠成双份间距）、
输入区没有卡片感。全部改回参考口径；`ReasoningBlock` 的自定义 body 包装换成共享的 `ActivityBlockBody`，
顺手去掉一处重复。

另外：助手列背景从 `--bg-soft` 改回 `--bg`。参考三列都是 `bg-zinc-950`，只用 hairline 分隔；它的转录区
`bg-zinc-950/40` 叠在同色上等于不可见。本仓此前只有助手列被染淡一层，是漂移。

### 6. 栏序改为参考的 左栏 | 助手 | 画布

参考的 `App` 渲染顺序是 `LeftSidebar → divider → agent → divider → WorkspaceCanvas`：助手夹在左栏与画布之间，
画布占右边缘。MASTER v2 §5 画的是 左栏 | 画布 | 助手 —— **该条作废**（AGENTS.md 与 CONTEXT.md 的对应句同步改）。

同时按参考的 `handleAgentResize` 把 `growAssistant` 的符号反过来：分隔条在助手**右**侧，向右拖是变宽。
宽度上下限与「画布至少保留 360px」不变，所以画布仍是三列里最宽的一面。

### 7. 项目门户按参考重排

容器 `max-w-6xl` + `px-4 sm:px-6 lg:px-8 py-8 gap-6`；标题 `text-xl sm:text-2xl font-semibold tracking-tight` +
计数徽标（真数字，来自 `research.projects.list`）+ 底部 hairline；网格 `grid-cols-1 md:grid-cols-2 lg:grid-cols-3
gap-3.5`（替换 MASTER v2 §4 的 `auto-fill, minmax(240px, 1fr)`）；卡片内边距 `p-4`、标题 14px `line-clamp-2`、
底部动作行 `px-3 py-2`。

键盘方向键的列数仍然**从布局读**（`getComputedStyle(grid).gridTemplateColumns`），所以换成固定断点列数之后
上下移动依然落准。

### 8. `research-studio/` 降级为只读设计参照（并修正 ADR 0022 的现状）

ADR 0022 决定「删掉整个目录」，但 `b0c01e7a` 又把它恢复了（本轮的逐面 diff 也说明它有用）。现状与决定记录
不一致，按**事实**重写：

- **保留**：`src/App.tsx`、`src/components/**`、`src/index.css`、`src/types/research.ts`、`src/main.tsx`；
- **删除**：AI Studio 导出物（`.aistudio/artifacts/brain/**` 的 AI 过程稿、`metadata.json`、`.env.example`、
  AI Studio 版 README、`bun.lock`）、构建脚手架（`package.json`、`vite.config.ts`、`tsconfig.json`、
  `index.html`、`.gitignore`）、演示数据（`src/data/mockProjects.ts`、`src/data/mockResearchData.ts`）、
  模拟管线（`src/utils/mineruParser.ts` 含 `mineru_demo_token_ak8291`、`src/utils/ragEngine.ts`）。

代价说清楚：删掉之后本目录**不再可构建**，`App.tsx` 与部分视图对 `../data/*`、`../utils/*` 的 import 是
悬空的。这是刻意的截取边界，写进了 `research-studio/README.md`；完整可运行快照仍在 Git 历史里
（`f6814e44` 纳入、`b0c01e7a` 恢复）。

### 9. `ROC_SMOKE` 测试 seam 保留并登记（清理的是别的东西）

产品代码里有五个 `ROC_SMOKE` 分支（`files-ipc` 的固定文件路径、`shell-ipc` 的自动确认、
`chromium-runtime-flags` 的调试端口、`macos-environment` 跳过登录 shell、`main-kernel-bootstrap` 的
`mode='smoke'`）。它们是**八个闸门 + smoke 套件唯一的原生对话框替身**：删掉会让验证整体变红，而替换成
测试注入需要同时改七个脚本 —— 收益是注释整洁，代价是验收能力。所以**保留**，并在每处补上「这是什么、
为什么存在、名册在哪」的注释，名册进 `docs/README.md`。

本轮真正清理的是：

- `AppShell` 的 `app-shell--smoke` —— 一个**没有 CSS 定义**的死类（模式仍由 `data-mode` 暴露）；
- 三个死动效工具类（§2）；
- **磁盘上的运行残留**：`.artifacts/*`（十个闸门 / 审查目录，8.8 MB）与 `.runtime/{tmp,mac-smoke,perf-seed.mjs}`。
  模型、工具链、pnpm/npm 缓存**没有动**（.runtime 里那 8 GB 是它们）。

## 有意保留（不照抄参考的地方）

| 参考的做法 | 这里不做，因为 |
| --- | --- |
| 自绘三个假红绿灯；文件预览也自绘一组（关闭/上一个/下一个） | 本窗口是 `titleBarStyle: 'hiddenInset'` + 真实 `trafficLightPosition`，照抄会多出六个灯；而预览里那三个彩色圆点用颜色承担了三个动作，违反「状态不只靠颜色」 |
| 助手头部的**模型下拉**（含「设置模型与服务」最后一行） | `settings.save` 是**整文档**保存；设置中心持有脏草稿，助手再开一个写入口就是整文档资源的第二个写者。pill 仍按参考做，尾随图标改成 `Settings2` |
| 折叠块用 `AnimatePresence` + `height: 0 → auto` | 这里的折叠块是原生 `<details>`（键盘、读屏、流式可用都来自它），改成 button + region 会丢掉这些性质 |
| 空会话的「欢迎英雄区」+ 三条示例提示词 | 示例提示词是演示数据；空态直接进输入框（MASTER v2 §10「不放欢迎英雄区，不用示意数据填充」） |
| 工具状态是「彩色小字 + 时长」 | 这里是**带文字的状态 pill**：颜色之外还有标签与图标，两套主题都能分辨 |
| 模型 pill 在头部最左 | 参考的 pill 是主控件（开下拉）；这里的 pill 是跳设置的只读显示，头部的主信息是「当前项目 · 当前阶段」，所以 pill 留在右侧 |
| 设置浮层 `max-w-[800px]` | 12 个分区、每区多行表单，800px 会把字段挤成两行以上；沿用 `min(1100px, 92vw)`（P8 实测） |
| 管理抽屉 `max-w-2xl`（672px） | 四个分区里有 markdown 编辑器 + 大纲、文件浏览器 + 预览，672px 会把编辑器和它的上下文分成两次滚动（P9 实测改到 720px） |
| 左栏文件 tab 是 `FolderTree` amber，但整条左栏 tab 轨道用 `rounded-lg`/`rounded-md` | 已照抄（§1、§4） |
| LaTeX tab 的工具栏 + 分屏/源码/预览三态 | 本仓的文稿面板是「工作区文件列表 + 卡片式编辑器」，它编辑的是真实工作区文件、写走 `files.writeText` 并留 recovery point；参考那套是单文件的演示编辑器，没有写入路径，结构照抄会让真实文件的保存动作无处安放 |
| 文件预览自建全屏模态（`z-[100]`） | 预览浮层由文件面板持有（`?file=` 仍是唯一选中状态），宿主在左栏；参考的自绘标题栏与之冲突 |
| 终端是「标题行 + 卡片式终端体」 | 这里的终端是真实 xterm，铺满画布后在**底部**给 cwd / 状态 / 尺寸 / 重启 / RTK 一行；参考那份是模拟输出，多一条头部只会吃掉终端行数 |
| 项目门户的搜索框在页内工具条（不在标题行内），且多一排状态筛选 | 筛选（进行中 / 已归档 / 全部）是 P2 的真功能，参考没有；关键词搜索与筛选要同屏才有意义，拆到标题行会把筛选孤立 |

## 理由

1. **「参考是设计权威」这句话只有在它能推翻别的东西时才有内容。** 之前它只推翻了动效（ADR 0023）与阶段面
   （ADR 0024），版式上仍以 MASTER v2 为准，于是同一个界面里存在两套半径刻度与两种选中态语言。本轮把
   版式也交出去，规范才真正只有一个来源。
2. **无意漂移的成本是持续的。** 「4px 块间距 + `my-1` 双份间距」「助手列单独染淡一层」「文件 tab 是 sky
   而目录树是 accent」都不是决定，是历次改动留下的残差；它们让「按规范做」和「按参考做」给出不同答案。
3. **清理与对齐是同一件事的两面。** 假数据（`mockProjects` / `mineru_demo_token`）、AI 过程稿、无 CSS 的
   `app-shell--smoke` 都属于「看起来还在用、实际没有消费者」的东西，和没人用的动效工具类是同一类缺陷。

## 代价

- **栏序变了**：助手从右列移到左栏与画布之间（本仓第一次与 AGENTS.md 的措辞不一致 —— AGENTS.md 已同步改）。
  这是本轮影响最大的一处，若产品判断相反，回退只需交换 `WorkspaceLayout` 里两个 block 并把
  `growAssistant` 的符号改回来。
- **圆角整体变圆一档**：6→8 / 8→12 / 10→16。卡片与浮层是主要受益面；`rounded-chip` 是新增 token，
  组件里今后写 `rounded-chip` 而不是 `rounded-md`。
- **助手转录更松**：块间距 4→12px、消息间距约 10→24px，同样内容占的竖向空间更多（虚拟化窗口的条数
  断言不受影响，P4 实测 52/52 仍然通过）。
- **`research-studio/` 不再可构建**：想再跑一次原型只能从 Git 历史取完整快照，取回来的那份**不要**提交回来。
- **`.artifacts/` 被清空**：十个目录里的历史报告与截图（含 `wave1`、`mac-package`）不再存在，需要时重跑
  `pnpm audit:layout` / `pnpm verify:p3…p9` 重新生成。
- **`docs/README.md` 里的 `design-system/MASTER.md` 链接是坏的**：那份文档在 `1da2e0e9` 已被删除。本轮把
  链接改成指向本 ADR；**不**恢复 MASTER.md（它的 §1.4 / §5 / §11 已被 ADR 0023/0024/0025 连续作废，恢复一份
  需要逐节重写的文档比重写一份还贵）。
