# UX 与动效采样协议

生产构建与独立采样沿用 [现有性能协议](../research-performance.md)。本协议补充短动作窗口；RAF、合成帧和实际屏显分别报告。

## 固定条件

- 普通 `pnpm build` 的 `dist`，拒绝 `.vite/profiling-build.json`。Profiler 构建只用于定位，不能混入成绩。
- 记录源码 commit、lockfile SHA256、完整 dist SHA256、采样器/夹具摘要与工作树状态。
- 记录 macOS、芯片、内存、Electron/Node、显示尺寸/缩放、可获取的物理刷新率、当前电源设置与供电状态。读不到的字段保留 `null`，不得用 RAF 频率猜物理刷新率。
- 原生内容区固定 1440×900；缩放 1 为宽布局，缩放 2 为 720×450 CSS 抽屉布局。记录每个场景实际 CSS viewport 和 `devicePixelRatio`。
- 每轮新 Electron 进程、隔离数据根、克隆夹具；串行五轮。保持电源、显示设置与并发负载一致，不清 OS 文件缓存，不改系统节能配置。
- 本地 scripted provider 只验证真实 IPC/流式状态，不能推导外部模型、搜索或文献服务延迟。

## 最小动作集

| 场景 | 动作与观察 | 功能约束 |
| --- | --- | --- |
| `project-reorder` | 100 项夹具过滤至约 11 项，列表置顶/取消五次 | 大集合筛选场景；P3 直接更新，记录实际 mounted 行数。≤20 完整集合的动画另用 Renderer 回归验证 |
| `project-menu` | 项目菜单打开/关闭五次，60ms 间隔 | 第二次操作约在 120–200ms 过渡的 30–50% 位置 |
| `sidebar-reverse` | 窄 CSS 窗左抽屉打开/关闭五次 | 触发器可达，退出后不保留交互；观测第一处可见样式变化 |
| `assistant-reverse` | 窄 CSS 窗助手打开/关闭五次 | 同一身份反向操作；不得把进入完成当下一次点击前提 |
| `assistant-reverse-keyboard` | 同一窄窗，真实 ⌘L 打开/关闭五次 | 独立键盘路径；不能补齐被阻断的鼠标样本 |
| `divider-drag` | 20 个真实 pointermove，朝合法范围内移动 60px，逐帧推进，释放 | 宽度直接跟手；记录拖动区间内与总偏好写入次数 |
| `divider-escape` | 相同的 20 点轨迹，方向随起点校准，Escape 后释放 | `aria-valuenow` 精确回到起点；不把已到边界的无变化输入当缺反馈 |
| `stream-completion` | 已有 500/5000 条历史，真实 Enter 提交，500 个本地 SSE chunk 后完成 | 终态必须来自 `run_completed`；一轮一个请求；DOM 消息行数 <100 |

这些断言确认采样路径有效；P0 的存储次数、帧耗时和长任务是观测值。P3 起补录
主进程 `process.versions`，运行中的 Chromium 版本以该字段为准；不改变帧/输入仪器。
项目菜单、侧栏、助手开关及准备阶段的关闭操作共用 `clickPointer`：先在 CSS 坐标核验按钮中心，再聚焦真实 BrowserWindow，用 `getContentBounds().width / CSS viewport.width` 得到 `effectiveScale`，将 CSS 中心乘该比例并取整，通过 Electron `webContents.sendInputEvent` 发送 `mouseMove`、左键 `mouseDown` / `mouseUp`（`clickCount=1`）。每次读取 `webContents.getZoomFactor()` 仅作为 `reportedZoom` 记录。

菜单/抽屉场景保留每次 CSS 命中几何、`reportedZoom`、`effectiveScale`、`nativeContentSize` 和原生整数坐标，以及 probe 捕获的可信 `pointerdown` 目标与 CSS 坐标；要求次数、目标一致，坐标偏差≤1 CSS px，以容纳取整误差。助手按钮中心不可达时保留命中几何，将鼠标场景记为 `blocked`，整个系列不提供部分成绩，继续独立键盘和其他场景。`divider-drag` / `divider-escape` 在 zoom=1 下沿用 Playwright `page.mouse` 拖拽；项目列表与流式准备仍用原有 Playwright 操作。禁止强制点击。

## 命令与交付

从仓库根 `/Users/Apple_501/Desktop/Roc/Roc` 执行：

```sh
pnpm build
node scripts/performance/bench-ui-motion.mjs docs/ux-motion/baseline-2026-11-24.json --samples 5
```

后续阶段使用新文件名，同一普通构建模式、硬件和夹具：

```sh
node scripts/performance/bench-ui-motion.mjs docs/ux-motion/after-p3.json --samples 5
node scripts/performance/bench-ui-motion.mjs docs/ux-motion/after-p4-history-5000.json --samples 5 --history-messages 5000 --stream-chunks 500
node scripts/performance/bench-ui-motion.mjs docs/ux-motion/reduced-motion.json --samples 5 --reduced-motion
```

脚本不 build，不覆盖已有报告。启动环境复用 `benchmarkChildEnvironment`，清理开发 Renderer URL、Electron Node 模式与旧 `ROC_PERF_*` 标记。只保留指定正式 JSON；短 CDP trace 在内存聚合，临时数据根、模块 bundle 和诊断文件在 `finally` 清理。不得并发运行采样、布局审计或另一套 Electron 测试。已有长内容/长期资源采样按需使用 `bench-ui-workloads.mjs`、`bench-repeated-workloads.mjs`，不在每个低风险阶段全量重复。

## 指标解释与门槛

- `rafP95Ms` / `rafP99Ms` / `rafOver50Ms`：动作窗口 RAF 间隔。60Hz 起始目标 P95≤20ms、P99≤34ms，>50ms 每次解释；不是实际显示 FPS。高刷另按真实刷新率建立预算。
- `feedbackP95Ms`：可信输入到目标 DOM/样式发生变化后的首个 RAF。属于可绘制机会代理；目标≤100ms。`feedbackMissing` 必须单列，缺样本不视作通过。实际输入到屏幕呈现需录屏/CDP 展示事件或 Instruments 独立核验。
- `longTaskCount` / `longestTaskMs`：现有 CDP `CrRendererMain` 顶层任务；不能仅凭增长归因到动画。嵌套 Layout/Paint 单列。
- `duringDragWrites`：pointerdown 至 pointerup/cancel/Escape 期间 `roc.ui.workspace.layouts` 写入；P3 后要求 0。`workspaceWrites` 给出含释放在内的总次数。
- Heap、DOM 和 Electron process metrics 是点采样；五轮无增长不能证明长时无泄漏。流式与虚拟列表的 mounted 行数是功能门禁。
- 每场景每轮一个汇总样本；五轮的跨轮 nearest-rank P95 即最大值。报告保留全部五轮和缺样本，不能将数百个内部 RAF 当数百次独立运行。
- 每场景分别报告 `completedRuns`、`blockedRuns`、`missingRuns`。完成五轮但仍有阻断时，总状态为 `complete_with_blocked_scenarios`，不表示全场景通过。P3 必须用同一鼠标路径消除阻断，键盘成绩不能替代。
- 鼠标助手系列的初始命中检查与系列中不可达时的命中检查分别保留；记录开关状态、两次几何和系列已尝试/已完成输入。只有 CSS 命中检查明确不可达时记录 blocked；原生输入目标或坐标核对失败、状态断言及其他错误继续失败退出。

## 2026-11-24 校准记录

初次采样器在首轮完成了项目重排、项目菜单、左抽屉三类动作，尚未形成五轮基线。720×450 CSS 窗口下，Playwright 第二次 `locator.click` 报告搜索按钮拦截助手按钮。最小生产构建复现纠正了初次 **F17** 判断：助手按钮 CSS 矩形为 `(680, 4.75, 28, 28)`，中心 `(694, 18.75)` 的 DOM 命中与 Playwright 边框均正常，未证实产品重叠。直接发送未缩放的 CDP 坐标 `(694, 18.75)`，实际可信事件为 `clientX=347, clientY=9.375`，命中搜索；Playwright/CDP 坐标统一乘 2 的后续复跑仍不稳定，不能据此宣称输入校准完成，也不能把自动化点击错误当成用户按钮被遮挡。

原始失败信号为 `TimeoutError: locator.click: Timeout 2000ms exceeded`，其中 `titlebar-search ... intercepts pointer events`。后续失败包括系列中途点击与按钮中心缺少 DOM 命中；这些保留为仪器校准失败证据，不证明真实产品重叠。初次部分 JSON 和一次性复现资料根属于临时产物，核验后清理，完整五轮须按校准后的同一仪器重跑。

真实窗口的早期最小原生校准通过连续四次、60ms 间隔点击：zoom=2，侧栏 CSS 中心 `(100, 19)`、助手中心 `(694, 19)`，两组 `aria-pressed` 均正确反向，可信 `pointerdown` 的 CSS 落点与目标正确。随后按正式准备顺序先点击项目菜单十次、关闭助手、切换 zoom=2、关闭侧栏，再分别点击侧栏和助手，复现了 zoom getter 与 Renderer 实际缩放不一致：助手第二次操作前，CSS viewport 仍为 720×450、原生内容区为 1440×900，但 `getZoomFactor()` 返回 1。按 getter 发送原生 `(694, 19)` 后，可信 `pointerdown/up` 落在 CSS `(347, 9.5)` 并命中搜索。由此确认原生坐标比例错误；未证实产品按钮重叠。

改用原生内容区宽度与 CSS viewport 宽度的实测比例后，相同准备顺序下，项目菜单、侧栏和助手三个系列各十次全部完成，60ms 间隔；每次可信 `pointerdown`、`pointerup`、`click` 都命中目标，CSS 落点距中心≤1px，抽屉状态逐次正确反向。助手系列的 `reportedZoom` 在 2 与 1 之间变化，`effectiveScale` 始终为 2。十次助手操作结束后，助手关闭、getter 为 2，直接 `setZoomFactor(1)` 成功恢复 CSS 1440×900，可继续宽窗拖拽。打开且 getter 为 1 时的直接恢复尚未单独验证。正式采样器按实测比例发送输入并逐场景核对可信事件；隔离诊断资料已清理。

2026-11-25 的[正式基线](baseline-2026-11-24.json)完成八场景各五轮，无阻断、缺反馈或 ≥50ms 主线程任务。普通构建和源码起点未变；AC 供电、低功耗关闭，Electron 报告显示刷新率约 120Hz。动作窗口 RAF P95 最大 9.4ms，输入反馈代理跨轮 P95 最大 9.0ms；这仍不证明实际 120Hz 屏显达标。分栏每轮拖动区间写偏好 20 次，Escape 路径 21 次，作为 P3 的存储整改基线。物理鼠标与其他实机验收另行完成。

校准同时修正了启动环境和拖拽轨迹：使用现有 child-environment 清理开发/profiling 标记；第二次拖动按 `aria-valuemin/max` 选择向内方向，避免合法 clamp 造成后段 no-op 输入而误报缺反馈。Electron 生命周期 helper 在关闭前捕获 owned child，解决 Playwright 已关闭后再读 `app.process()` 的清理错误。以上仪器变化必须重跑全部场景，以新 source/dist 摘要建立正式基线。

正式采样前还修正了目标校验：点击按钮内带 `data-testid` 的标题属于该按钮，按最近按钮归属核验；可信输入分别绑定 `pointerdown`、拖动的 `pointermove` 与快捷键/提交的 `keydown`，悬停不消耗点击反馈样本。

## 实机验收缺口

P0 只能确认当前可用机器与供电状态。60Hz/120Hz、低功耗以及另一代 Mac 分别建立报告；没有硬件或明确授权的系统状态切换时标记待验证。物理触控板、中文 IME、VoiceOver、真人任务感知与录屏需独立完成。禁止以布局测试全绿、普通 RAF 达标或旧版启动基线替代这些结果。
