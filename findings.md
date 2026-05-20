# Roc Performance Findings

## Context

- 当前项目是 Electron + React + TypeScript 桌面端，`package.json` 显示主入口为 `dist/main/index.js`，构建脚本为 `pnpm build`，端到端入口为 `pnpm smoke:electron`。
- `native-feel-cross-platform-desktop` 决策树更偏向原生 shell + system WebView 架构；Roc 当前是 Electron。性能计划按现架构治理，不把“重写成 native shell”作为第一阶段优化。
- 技能原则采用：
  - T4: 性能是感知属性，优先测用户能感觉到的启动、首帧、输入、滚动、streaming 延迟。
  - T6: 跨边界调用要有意图，IPC 高频调用需要批处理、缓存和观测。
  - T8: 区分 Electron/WebView/Node baseline cost 与 Roc 自己造成的 margin cost。

## Startup Findings

- `src/main/index.ts` 在 `createWindow()` 中先构建所有服务，调用 `services.appService.initialize()`，之后才创建 `BrowserWindow` 并 `loadRenderer()`。
- `AppService.initialize()` 同步执行 `paths.ensureTree()`、`configService.initialize()`、`mcpService.ensureExaPreset()`、`databaseService.initialize()`、`logService.initialize()`、`memoryService.initialize()`。
- `MemoryService.initialize()` 会确保多份 Markdown 文件，并同步 Deep Agents store projection；这属于冷启动可疑阻塞点。
- `src/renderer/App.tsx` 初始 load 并发拉取 app/task/agent/workspace/rtk/window/settings，随后再 `await loadTaskSurfaceData()`，增加首屏等待面。
- `startup-load-policy.ts` 已有按 view 懒加载 workspace/memory/operations 的基础，可继续扩展到首屏基础状态。

## Renderer / Interaction Findings

- `use-chat-run.ts` 已用 `requestAnimationFrame` 合并 chat run events，这是正向实现。
- `stream-consumers.ts` 对每个 visible delta 都会 emit runtime event，且 task run 场景还会逐 delta 写 `task_events`，DB 写放大风险高。
- `chat-transcript-panel.tsx` 搜索显示 `scrollTo({ behavior: 'smooth' })`，和 native-feel 技能建议的 native instant scroll 存在冲突，可能影响长消息流跟随体验。
- `motion` 被用于 chat row、modal、drawer；需要增加 reduced-motion 行为和性能预算测试，不应全局删除动画。

## Database Findings

- `DatabaseService.initialize()` 已启用 WAL 和 foreign_keys，但没有看到 `busy_timeout`、`synchronous`、核心查询 index。
- `TaskService.getSnapshot()` 按 `updated_at`、`created_at/rowid` 取最近线程和事件；大数据量时需要 index。
- `task_events` 高频写入路径来自 `DeepAgentRuntimeService.consumeSessionStreams()`。
- `performance_samples` 表已存在，但当前 `DiagnosticsService.samplePerformance()` 只记录 Node process RSS/heap，不覆盖 renderer paint、IPC、DB query latency。

## IO Findings

- `FileService` 使用同步 `readdirSync/statSync/readFileSync/writeFileSync`。在 main process 中运行，会阻塞 IPC handler。
- `readPreview()` 对图片直接整文件 base64；对大图会造成内存和 IPC payload 放大。
- `search()` 递归同步遍历工作区并读文件；虽然跳过 `node_modules/.git/dist/release/.artifacts`，仍可能卡住大仓库。
- `GitService` 和 `ShellExecutionService` 使用同步 child process 调用，交互期间可能阻塞 main process。

## Network / Provider Findings

- `LangChainModelFactory` 已使用 streaming 和固定 timeout，`llama_cpp` 自动启用 `cache_prompt = true`。
- `ProviderRuntimeService.testProvider()` 使用非 streaming invoke，适合设置页测试，但需要避免和主聊天运行争抢 UI 主链路。
- 网络层缺少用户感知指标：first token latency、stream gap、retry count、cache hit ratio。`logProviderUsage()` 已记录 token/cache 但不进入可观测性能面板。

## Verification Findings

- 现有验证入口：
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm build`
  - `pnpm smoke:electron`
- 现有 targeted tests：
  - `tests/main/startup-load-policy.test.ts`
  - `tests/renderer/use-lazy-startup-resource.test.ts`
  - `tests/main/app-services.test.ts`
  - `tests/main/deep-agent-runtime-service.test.ts`
  - `tests/main/file-service.test.ts`
- `pnpm smoke:electron` 是 renderer contract 变更最强验证。


## Implementation Findings 2026-05-20

- Task 1 实现中发现 `AppService` 构造参数插入 `performanceObserverService` 后必须保持参数顺序；错位会让 `LogService` 调用落到其他 service 上，表现为 `this.logService.initialize is not a function`。
- IPC instrumentation 的最小可测点是 `registerIpc()` 注册后的 handler 调用；测试通过 `tasksDeleteThread` 验证 `performanceObserverService` 记录 `phase: ipc_call`、`channel`、`ok`，不记录 payload。
- Task 2 启动拆分后，critical 初始化覆盖路径、配置、Exa preset、SQLite 和日志；memory Markdown 文件延迟到 `ready-to-show` 后的 deferred init。审查发现 Exa preset 不能 deferred，否则首帧 `settings.get()` / `mcp.listServers()` 可能看不到 `exa-hosted`。
- Task 3 实现确认 `App.tsx` 首屏最大的不必要串行点是 `Promise.all(...)` 之后的 `await loadTaskSurfaceData()`；它会等待 `tasks.listBackgroundTasks()` 与 `lifecycle.getTraySummary()`，但 chat/quick 首屏不需要完整 task surface。
- `startup-load-policy.ts` 已扩展 `taskSurface` 目标，`tasks` 与 `tray` view 会触发 lazy task surface 加载；chat base startup 不加载。
- 空 task surface 的安全形状是 `backgroundTask: null`、`backgroundTasks: []`、`traySummary` 零计数；这让历史侧栏、quick/tray/task surface 在 lazy 数据返回前仍有稳定状态。
- Task 4 实现确认 renderer `use-chat-run.ts` 已按 `requestAnimationFrame` 批量应用 run events，不需要重复优化 UI state path。
- Task 4 真正的 streaming 写放大来自 main process：`stream-consumers.consumeMessageStream()` 原先对每个 assistant delta 写一条 `task_events.message_delta`。当前修复把 assistant delta 聚合器生命周期提升到整个 `messages` iterable，UI delta 粒度保持不变，SQLite event granularity 降为 chunk-level。
- Task 4 新暴露出的失败模式是 provider 把输出拆成 many tiny LangChain messages，而不是一个 message 内的 many tokens。若 assistant delta recorder 只在单个 message 内 flush，`task_events.message_delta` 仍会退化成每条消息一行。当前回归测试已覆盖这一点。
- Task 4 当前持久化合同：task runs 中 assistant delta 按 `512` 字符上限分块写入 `task_events.message_delta`，最终 `completeRunWithProviderResult()` 仍写权威 `message` 事件保存完整 assistant answer。
- Task 4 实现确认 renderer `use-chat-run.ts` 已按 `requestAnimationFrame` 批量应用 run events，不需要重复优化 UI state path。
- 真正的 streaming 写放大来自 main process：`stream-consumers.consumeMessageStream()` 原先对每个 assistant delta 写一条 `task_events.message_delta`。合并持久化后，UI delta 粒度保持不变，SQLite event granularity 降为 chunk-level，最终 `message` event 仍保存权威 assistant answer。
- Task 5 索引基于当前真实 SQL，而非预设表面：`task_threads(archived_at, updated_at DESC)` 覆盖 snapshot thread lookup；`task_events(thread_id, type, created_at ASC)` 覆盖 thread message history；`task_events(thread_id, created_at DESC)` 覆盖 recent events；memory/session/LangGraph 索引覆盖 fallback rows 和 namespace prefix lookup 的过滤前缀。
- `task-service-threads.test.ts` 中已有工作区改动引入 `recordEvents()` 批量插入语义；当前任务未回退这组改动，并把它纳入 Task 5 verification。
- Task 6 preview guardrail 不改变 `FilePreviewResult` union：大图仍可用现有 `binary` 分支表达“不可 inline”，并通过 `mediaType` 保留图片类型；renderer 现有 binary/preview copy 可消费该状态。
- Task 6 search guardrail 使用内部固定上限而不是新 IPC contract：`maxResults` 继续只控制返回结果数量，内部 `visitedFiles`/`scannedBytes` 控制主进程扫描成本，命中上限时 `truncated: true`。
- Task 7 的高风险点是 shell/agent command 与 RTK/HITL 审计绑定较深；本轮只把 visible Git workbench 读路径异步化，保留 `stage/commit/push/checkout` 和 shell execute 同步语义，避免扩大行为面。
- Task 8 streaming 热路径的根因是 `chat-transcript-panel.tsx` 的 auto-follow effect 在每次 `liveSignal/messages` 变化后排队 `scrollTo({ behavior: 'smooth' })`；修复后该路径只传 `{ top }`，显式按钮点击仍可 smooth。
- Task 8 reduced-motion 覆盖分两层：CSS `@media (prefers-reduced-motion: reduce)` 继续兜底原生动画和滚动；React motion 组件由 renderer root 的 `MotionConfig reducedMotion="user"` 跟随系统偏好。
- Task 8 动画属性审计未发现需要大范围 CSS 改写的 layout-heavy streaming 动画：当前热路径相关动画以 `opacity` / `transform` 为主。
- Task 9 provider 延迟指标的最小稳定采样点是 Deep Agent stream lifecycle：`provider_first_token` 由首次 visible output 标记，`provider_completed` 由 `completeRun()` 标记；两者进入 bounded `PerformanceObserverService`，不进入 SQLite 明细表。
- Task 9 diagnostics 面板继续以 RSS/Heap 为主，但 `PerformanceSample.timing` 会携带 startup/IPC/provider timing snapshot，renderer 只展示最近 provider 首 token 和完成耗时。
- Task 9 当前 retryCount 表示 first visible output 之前已消耗的 provider retry 次数；一旦有 visible output，后续错误不再由 provider retry wrapper 重试。
- Task 10 bundle 证据显示当前最大收益在 JS chunk split：原 renderer 只有一个约 2.43 MB 的 `index-*.js`；懒加载非首屏视图和 Workbench 后，初始 JS 降到约 1.76 MB，Workbench 独立约 582 KB。
- Task 10 没有执行多 HTML entry：quick/tray 仍共用 renderer entry，但 chat/quick/tray 入口不再静态导入非首屏 ViewContent 视图和 Workbench heavy JS。多 entry 需要额外构建和 smoke 覆盖，当前证据下不是最低风险路径。
- Task 11 内存诊断应按 native-feel T8 区分 baseline 与 margin：Electron/Chromium/Node RSS 低于 Roc 预算时只说明在基线内，不等于 Roc 自身没有内存增长；超过预算时才提示 `超过 Roc 预算`。
- Task 11 `useChatRun()` 的 pending event buffer 内存卫生边界是：unmount 与 reset 都必须取消已排队 RAF，并丢弃尚未 flush 的 events。当前实现已抽出 `clearPendingChatRunEvents()` 并有纯函数回归测试覆盖。
- Task 12 专用 smoke gate 最终形态：`tests/smoke/performance-smoke.mjs` 只做最小性能契约验证，采样 `window.roc.diagnostics.samplePerformance()`、打开 quick/tray 浮动入口、写 `.artifacts/wave1/performance-smoke.json`；`scripts/smoke-performance.mjs` 负责切换/恢复 `better-sqlite3` Electron 与 Node ABI。
- 当前 fresh baseline：`performance-smoke.json` 显示 main `ready_to_show` 约 `344.7 ms`、`renderer_loaded` 约 `200.9 ms`、quick open `281 ms`、tray open `249 ms`、RSS `214.5 -> 219 MB`；这组数值更接近“当前架构基线 + 已完成优化后的 margin”。
