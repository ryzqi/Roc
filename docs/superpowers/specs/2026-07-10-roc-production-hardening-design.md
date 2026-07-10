# Roc 生产加固设计

日期：2026-07-10
状态：书面规格已复核批准

## 1. 背景

生产审计确认 Roc 已具备迁移、IPC 校验、事件批处理、reduced-motion 和 SQLite 基础治理，但仍存在一条 Critical 安全路径、七条 High 风险路径，以及启动、长历史、动画和键盘交互方面的 Medium 问题。

本设计把修复拆成五批：

1. 安全边界
2. 数据一致性
3. 数据库生命周期
4. Renderer 性能
5. 动画与交互

每批都必须按以下顺序闭环：

`失败测试 -> 实现 -> review -> 修复 -> 验证 -> commit`

全批次完成后，再对当前工作树执行一次全仓 completion audit。之前通过的测试只作为基线，不作为修复完成证据。

## 2. 目标

- 阻止远端页面进入持有 Roc preload bridge 的主窗口。
- 保证 task 风险字段和 HITL 决策在 main 边界被真实 schema 校验。
- 恢复 LangGraph checkpointer 的原生删除契约。
- 让跨 task/agent 两库的完整历史删除可恢复、可重试、幂等。
- 把 retention、完整健康检查、backup 和 restore 接入可运行的生命周期。
- 让聊天历史从数据库查询到 DOM 渲染都具备明确边界。
- 降低无消息首屏的静态 JS、根组件无效渲染和串行 loader 等待。
- 修复 persisted history 动画、Settings exit、dialog 焦点和历史菜单可达性。

## 3. 非目标

- 不更换 Electron、React、LangGraph、DeepAgents 或 SQLite。
- 不修改现有业务字段、任务工作流或历史会话展示含义。
- 不通过删除数据目录、重建用户数据库或忽略旧记录完成修复。
- 不新增兼容别名、双协议、迁移胶水、用户配置项或未来扩展点。
- 不做无关模块拆分、样式重构、依赖升级或命名清理。
- 不把 DeepAgents `/workspace/` 虚拟路由当成 Windows shell cwd。

## 4. 设计原则

### 4.1 所有权

- renderer 只提交用户可编辑的原始输入。
- main 校验合同并推导安全字段。
- checkpointer 只拥有 checkpoints 和 checkpoint writes。
- task 插件拥有“删除一个 Roc thread 的全部应用数据”这一业务操作。
- database maintenance 只处理明确列出的基础设施表和固定保留策略。

### 4.2 显式失败

- 关键字段缺失、cursor 非法、schema 不匹配、恢复状态未知时直接失败。
- 不用默认值掩盖破坏的合同。
- 不用宽泛 `try/catch` 吞掉业务错误；只在 IPC、任务、进程和 CLI 边界转换输出。

### 4.3 无损兼容

- schema migration 只新增本设计需要的表、索引或字段。
- 现有 thread、run、message、task、interrupt、tool effect 和 artifact 不做批量改写。
- retention 不删除 `session_messages`、`agent_threads`、`agent_runs` 或后台任务投影。
- restore 在验证 staging generation 成功前不触碰当前 data generation。

## 5. 批次一：安全边界

### 5.1 主窗口导航策略

新增统一的 top-level navigation policy，并在创建主窗口后同时绑定：

- `webContents.setWindowOpenHandler`
- `webContents.on('will-navigate', ...)`

规则如下：

1. 所有用户或页面触发的 top-level navigation 先 `preventDefault()`。
2. `http:` 和 `https:` URL 经过同一 URL parser 与 scheme allowlist 后交给 `shell.openExternal()`。
3. 当前 Roc renderer 的精确 app URL 可被识别，但 React 页面切换不依赖 top-level navigation，因此不会为相对路径或任意同源路径新增放行。
4. `file:`、`javascript:`、`data:`、`roc-preview:` 和其他 scheme 不交给 OS，也不进入主窗口；记录不含敏感 query 的结构化 warning。
5. policy 只处理 main frame；preview resource、iframe 或受控内部资源继续走各自现有边界。

这样即使 renderer 的 anchor、第三方 Markdown renderer 或未来 UI 忘记拦截，main 仍是最终安全边界。

### 5.2 受控 Markdown Link

`MarkdownView` 覆盖 React Markdown 的 `a` component：

- 仅把绝对 `http:`/`https:` URL 渲染为可交互外链。
- 点击时阻止默认导航，通过 `window.open(..., '_blank')` 进入现有 main window-open policy。
- 增加 `rel="noreferrer noopener"`，但不依赖该属性承担 Electron 边界。
- 相对 URL、空 URL 和非 allowlist scheme 不触发导航；仍保留可读文本。
- streaming Markdown 与 completed Markdown 复用同一 link component，不能出现两套策略。

不新增 renderer 到 main 的第二条“打开外链”IPC，因为现有 window-open policy 已经是单一入口。

### 5.3 BackgroundTask 合同

为以下合同建立真实 Zod schema：

- `BackgroundTaskTrigger`
- `EnabledCapabilities`
- `BackgroundTaskPreviewRequest`
- `BackgroundTaskPreview`
- `BackgroundTask`
- `UpdateBackgroundTaskRequest`
- 相关 capability 的输入和输出

创建链路改为：

`renderer raw request -> main schema -> createBackgroundTaskPreview() -> main derived fields -> persist`

具体约束：

- `task.background.create` 不再接收 `BackgroundTaskPreview`，改为接收 `BackgroundTaskPreviewRequest`。
- renderer 可调用 preview capability 展示 `scheduled`、`riskLevel` 和 `requiresConfirmation`，但 create 时必须重新提交原始 request。
- main 在 create 时重新调用 `createBackgroundTaskPreview()`；不信任 renderer preview。
- update 继续只接收允许编辑的 patch，main 从已持久化 task 与 patch 重建 request 后重新推导风险。
- `scheduled`、`nextRunAt`、`cronExpression`、`riskLevel`、`requiresConfirmation` 只在 main 产生。
- create/update 请求出现派生字段时由 strict schema 拒绝，不静默 strip 后继续。

不引入 preview token、preview cache 或兼容旧 create payload。main/preload/renderer 在同一版本内原子更新合同。

### 5.4 HITL decision 合同

按当前 LangChain `HITLResponse` 定义建立判别联合：

- `{ type: 'approve' }`
- `{ type: 'reject', message?: string }`
- `{ type: 'edit', editedAction: { name: string, args: Record<string, unknown> } }`

`agent.run.resume` 的 approval 分支要求：

- `decisions` 至少一项。
- 每项必须匹配上述联合，未知字段和未知 decision type 被拒绝。
- runtime 继续校验 interrupt id、run id、thread id 和 pending interrupt 的对应关系。
- decision 数量和 allowed decisions 的业务检查保留在 runtime 边界，不塞进静态 schema。

### 5.5 安全批验收

- Markdown `https://example.com` 不改变主窗口 URL，只调用一次 OS shell。
- 直接触发 `will-navigate` 到远端、`file:`、`javascript:` 和 `roc-preview:` 均被阻止。
- renderer 伪造 `riskLevel: 'low'` 或 `requiresConfirmation: false` 无法进入 create handler。
- create 与 update 的持久化风险字段等于 main 推导结果。
- 无效 approve/reject/edit payload 在 capability handler 前失败。

## 6. 批次二：数据一致性

### 6.1 恢复 checkpointer 原生契约

`SqliteCheckpointer.deleteThread(threadId)` 只在一个 agent DB transaction 内删除：

- `langgraph_checkpoint_writes`
- `langgraph_checkpoints`

它不得删除：

- `agent_threads`
- `agent_runs`
- `agent_events`
- `session_messages`
- `agent_pending_interrupts`
- `agent_run_events`
- `agent_tool_effects`
- `context_artifacts`

完整历史删除继续使用应用级 `deleteAgentThreadHistory()`，但只允许由 task-owned deletion workflow 调用。

### 6.2 Task-owned deletion journal

task DB 新增 `thread_deletion_journal`，最少包含：

- `thread_id` 主键
- `state`: `pending | agent_deleted | complete`
- `attempt_count`
- `last_error`
- `created_at`
- `updated_at`
- `completed_at`

不建立第二套 deletion queue，也不把 journal 放到 agent DB。task 插件是业务删除的唯一 owner。

### 6.3 删除状态机

一次删除按以下顺序推进：

1. 在 task DB transaction 中插入或读取 `pending` journal。
2. 所有 task/history 查询立即过滤任何已存在 journal 的目标 thread，使其从 UI 和 scheduler 视图隐藏。
3. 在 agent DB transaction 中幂等执行完整 thread history 删除。
4. 在 task DB 把 journal 更新为 `agent_deleted`。
5. 在同一个 task DB transaction 中删除 `scheduled_task_runs`、`background_tasks` 等 thread projection，并把 journal 更新为 `complete`。
6. capability 只在状态到达 `complete` 后返回 `{ deleted: true, threadId }`。

`complete` journal 保留为删除审计和幂等依据；以后同一 thread id 的重复请求直接返回成功，不创建兼容路径。

### 6.4 失败恢复

- agent 删除前失败：journal 保持 `pending`，目标已隐藏，task projection 仍在，后续重试继续第 3 步。
- agent 删除成功、task 状态更新失败：agent 删除是幂等操作，重试后进入 `agent_deleted`。
- task projection 删除失败：journal 保持 `agent_deleted`，重试只完成 task DB transaction。
- 进程在任意步骤退出：task 插件 initialize 时，在 scheduler start 和 task 注册之前恢复全部非 `complete` journal。
- 单次恢复失败：记录 `attempt_count`、`last_error` 和结构化日志；插件继续启动，但相关 thread 保持隐藏且不会重新调度。
- 同一 thread 的并发删除：依靠 journal 主键串行化为同一个操作。

删除请求不通过“把两个 SQLite transaction 当成一个 transaction”制造伪原子性。

### 6.5 数据一致性批验收

- checkpointer contract test 证明只删 checkpoint 两表。
- 应用级删除 test 证明完整历史和 task projection 最终全部删除。
- 在 agent 删除前、agent 删除后、task 删除前分别注入失败，重建 repository/plugin 后都能恢复到 `complete`。
- pending deletion 不出现在 history、task board、active task 和 scheduler registration 中。
- 重复删除和启动恢复不会报 foreign key 错误，也不会产生第二条 journal。

## 7. 批次三：数据库生命周期

### 7.1 启动 fast probe 与后台 full check

`KernelRuntime.start()` 只保留启动必需的 fast probe：

- 打开数据库并应用 migration。
- 读取 `schema_metadata.current_version`。
- 验证每个数据库的 required tables/view 存在。
- 执行最小读取探测，并用 `BEGIN IMMEDIATE` 后立即 `ROLLBACK` 验证写锁可取得；不写用户业务行。

启动不再同步执行六次 `PRAGMA quick_check`，也不在首窗前写入六条完整 health rows。

完整检查改为后台 maintenance job：

- 首次在应用 ready 后延迟 2 分钟执行。
- 此后每 24 小时最多执行一次。
- 对六个数据库执行 `PRAGMA quick_check` 并持久化现有 health report。
- 失败或 unhealthy 结果记录到 diagnostics 和结构化日志，不在后台直接终止已运行的应用。
- 下一次冷启动的 fast probe 若发现 migration、required table 或基本读写失败，仍阻止启动。

### 7.2 Retention job

复用现有 `runDatabaseRetention()`，固定生产策略为：

- terminal run payload：保留 90 天。
- checkpoints：每个 thread 最多保留最近 100 个。
- automatic memory audit：保留 180 天。

保护条件保持强制：

- `running`
- `recovering`
- `waiting_user`
- 存在 pending interrupt 的 run/thread

Retention 不删除 thread、run、session message、background task 或 recovery continuity 所需状态。

调度规则：

- 首次在应用 ready 后延迟 5 分钟执行。
- 此后每 24 小时最多执行一次。
- 同一进程内不允许重入。
- 每次记录开始时间、完成时间、状态、删除计数和错误信息。
- job 失败不阻止应用继续运行，下一周期重试。

core DB 新增单一 `database_maintenance_runs` 表记录 `retention` 和 `full_health_check`，不新增用户配置。

Kernel bootstrap 只创建一个 maintenance service。main window ready 后启动 timer；shutdown 时先停止 timer 并等待正在运行的 job 结束，再关闭 plugin 和 database pool。

### 7.3 Backup

提供可达的停机维护命令：

- `pnpm database:backup -- --data-root <path> --backup-root <path> --id <id>`
- `pnpm database:restore -- --data-root <path> --backup-dir <path>`

package script 负责 native ABI 准备与恢复，CLI 逻辑只保留一份。

Backup 规则：

1. Roc main 进程在打开 data root 后创建并持有同一 maintenance lease，clean shutdown 时释放。
2. CLI 用原子 create-exclusive 方式获取 lease；owner PID 存活或无法证明已退出时显式失败。
3. lease 文件存在但 owner PID 可证明不存在时，CLI 把它判定为 stale，删除后只重试一次。
4. 对六个数据库使用 `better-sqlite3`/SQLite backup API 生成一致副本，不再 `wal_checkpoint(TRUNCATE)` 后直接复制活动文件。
5. 对每个副本记录 logical database name、schema version、size 和 SHA-256。
6. manifest 写入临时文件并原子 rename；全部数据库成功后才把 backup 标记为 complete。
7. 任一数据库失败时 backup 目录保留为 failed artifact，不写入成功 manifest。

独占 maintenance lock 构成明确的写入静默期。Backup/restore 不通过 renderer IPC 暴露，避免运行中误触。

### 7.4 Staging restore

Restore 必须在 Roc 停止且取得同一 maintenance lock 后执行：

1. 读取并严格校验 manifest 完整性、数据库集合、路径边界、hash 和 schema version。
2. 把 backup 恢复到 data root 旁的 staging generation，不接触当前 `data`。
3. 在 staging generation 上运行 migration compatibility probe、required table check 和六库 `PRAGMA quick_check`。
4. staging 全部通过后，把当前 `data` rename 为 rollback generation，再把 staging rename 为 `data`。
5. 对新 current generation 再执行 fast probe。
6. 若切换或最终 probe 失败，立即 rename 回 rollback generation并返回失败。
7. 成功后保留 rollback generation 和 restore receipt，供显式人工回滚；不自动删除用户旧 generation。

不引入长期 data pointer、双路径读取或运行时兼容层。正常启动路径仍只读取 `data`。

### 7.5 数据库批验收

- kernel 启动测试证明首窗前不调用 `PRAGMA quick_check`。
- 后台 full check 的首次延迟、24 小时间隔、不重入和失败记录有 fake timer 测试。
- retention runtime integration test 证明 job 实际运行并记录删除计数。
- active/recovering/waiting-user/pending-interrupt 数据在 runtime job 中仍被保护。
- backup 在 WAL 数据存在时恢复出一致内容。
- restore 的 hash、schema、quick-check、staging、directory switch 和 rollback failure injection 全部有测试。
- CLI 在 app lock 存在、路径越界或参数缺失时显式失败。

## 8. 批次四：Renderer 性能

### 8.1 AppShell 只消费 task run

AppShell 保留 task surface 所需的 live state，但不再把普通 chat event 写入根状态：

- 用 ref 维护已知 task run id 集合。
- 集合由 task snapshot/background task 的 run id 初始化。
- 收到 `run_started` 且 `mode === 'task'` 时加入集合。
- 其他 event 只有 `runId` 已在集合中才进入 `applyChatRunEvent()`。
- `run_completed` / `run_failed` 应用完成后从集合移除，再刷新 task state；`run_interrupted` 保留 run id 以继续接收同一 run 的 `run_resumed`，同时刷新 task state。
- 普通 chat 继续只由 `useChatRun()` 的 RAF batching 路径消费。

不为过滤事件增加跨进程 IPC 或第二条 event bus。

### 8.2 Sequence cursor 分页合同

把 `task.thread.messages.list` 从全量数组改为 page contract。

请求：

```ts
type TaskMessageHistoryRequest = {
  threadId: string;
  limit: number;
  cursor:
    | null
    | { direction: 'before'; sequence: number }
    | { direction: 'after'; sequence: number };
};
```

响应：

```ts
type TaskMessageHistoryPage = {
  items: PersistedTaskEvent[];
  oldestSequence: number | null;
  newestSequence: number | null;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
};
```

其中 `PersistedTaskEvent` 要求 `sequence: number`，不能沿用 live event 的可选 sequence。

合同规则：

- `limit` 必填，范围 `1..200`；renderer 默认 `100`。
- `cursor: null` 返回最新尾页。
- `before` 使用严格 `< sequence`，返回更旧页。
- `after` 使用严格 `> sequence`，返回新持久化事件。
- 所有响应 items 按 sequence 升序。
- agent DB migration v2 新增 `(thread_id, sequence)` 索引并支持查询计划；现有 `(thread_id, run_id, sequence)` 索引不能替代跨 run 的 sequence cursor 索引。
- renderer 用 sequence 和 id 去重；缺失、重复冲突或非单调 sequence 显式失败。

### 8.3 历史加载和虚拟化

新增直接依赖 `react-virtuoso`，不自研变量高度虚拟列表。

加载行为：

- 打开 thread 只取最新 100 个 persisted events。
- 滚动到顶部时用 `before` cursor 加载一页并 prepend。
- task snapshot 表明有新 persisted event 时，用 `after` cursor 增量补齐，不重新拉取全历史。
- thread 切换取消旧请求并清空旧 page state，旧响应不得覆盖新 thread。
- live message 继续实时追加；对应 persisted event 到达后按稳定 key 去重。

渲染行为：

- Virtuoso 负责 message row 的变量高度测量、prepend scroll anchoring 和尾部跟随。
- persisted event replay 只在 page state 变化时运行，不在每个 streaming token 上重放。
- `ResizeObserver` 不再观察包含全部历史的单一巨大 transcript 节点。
- DOM 中只保留 viewport、overscan 和必要 live rows；10k 历史不能生成 10k message nodes。

### 8.4 Lazy boundaries 与首屏 JS

以下模块从无消息 chat 首屏移出：

- completed Markdown renderer
- streaming Markdown/Streamdown
- syntax highlighting core 与语言模块
- Settings feature 和 modal 内容
- 非 chat 页面与重型 workbench 页面

具体规则：

- 无 assistant Markdown 时不请求 Markdown chunk。
- syntax highlighting 使用 `highlight.js/lib/core` 和按语言动态导入；不在 renderer entry 导入全局 highlight package/CSS。
- 支持的首批语言只覆盖现有主要场景：JavaScript、TypeScript、JSON、Bash、PowerShell、Python、Markdown、SQL、XML/HTML 和 CSS。
- 未识别语言以 plaintext 渲染，不加载全部语言注册表。
- Settings 的 lazy boundary 位于 presence owner 内，不能破坏 exit animation。
- route lazy fallback 使用现有 loading surface，不新增说明型页面。

Build gate：

- 无消息首屏 initial static JS 和 modulepreload 合计不超过 `1.5 MB` 未压缩。
- initial modulepreload 不得包含 Markdown、Streamdown、highlight 或 Settings chunk。
- chunk budget 由脚本读取 Vite manifest/build output 自动检查，不靠人工观察日志。

### 8.5 Loader 并发

`loadWorkspaceData()`：

- file tree 链与 git status 链同时启动。
- file preview 只等待 file tree。
- git branches 和 selected diff 只等待 git status 与选择计算。
- PDF preview 只等待其实际 file preview 依赖。

`loadOperationsData()`：

- background tasks、performance sample、diagnostic checks 同时启动。
- diagnostic package 只等待 background task 结果。

并发不改变错误合同，也不把依赖链错误地并行化。

### 8.6 全进程预算和大历史基准

`PerformanceSample` 增加：

- `totalPrivateBytesMb`
- `totalWorkingSetMb`
- `memoryMeasurement: 'complete' | 'private_bytes_unavailable'`

`exceedsBudget` 改为比较所有 Roc Electron processes 的 private bytes 总和。main RSS 保留为诊断字段，但不再决定预算是否通过。任一 Roc process 缺少 private bytes 时，Windows performance smoke 直接失败为 measurement unavailable，不静默改用 working set。

固定 gate：

- 空数据：`mainReady <= 500 ms`、`rendererReady <= 2500 ms`、总 private bytes `<= 450 MB`。
- 1k event seeded profile：打开 thread 到尾页可交互 `<= 750 ms`，总 private bytes `<= 500 MB`。
- 10k event benchmark：初次只返回 100 events；尾页可见 `<= 1000 ms`；稳定状态 DOM message rows `< 300`；单页 prepend p95 `<= 250 ms`。

如果实现前首次 private-bytes 基线已经高于固定 gate，不得自行上调预算；必须先优化或单独请求用户批准调整。

### 8.7 性能批验收

- 普通 chat token/event 不再触发 AppShell task live state 更新。
- SQL query plan 使用 thread/sequence 索引，initial/before/after 页无全表排序。
- 1k/10k fixtures 验证 page size、scroll anchoring、增量 append、DOM 上限和交互时间。
- build budget 自动证明首屏不 preload Markdown/Settings。
- loader 测试证明独立 promise 在依赖结果返回前已经启动。
- performance smoke 同时报告 main RSS、总 working set 和总 private bytes，并以总 private bytes 判定。

## 9. 批次五：动画与交互

### 9.1 Persisted history 不执行入场动画

`ChatTranscriptMessage` 增加明确来源：`persisted | live`。

- persisted row 使用 `initial={false}`。
- persisted approval/question 子卡同样不执行 mount animation。
- 新 live user/assistant/interrupt 保留现有轻量入场动画。
- 从 live 转成 persisted 时稳定 key 不变，不能重新 mount 或闪动。

### 9.2 Settings exit ownership

`AppSettingsLayer` 始终作为 presence owner 存在：

- `AnimatePresence` 上移到持有 `open` 的父层。
- `open` 只控制 presence 内是否渲染 `SettingsModal`。
- `SettingsModal` 移除无效的内部 `AnimatePresence`。
- modal 内容可 lazy load，但 backdrop/panel 的 exit 必须完成后再卸载。

测试使用 exit completion 或 fake animation lifecycle 证明关闭时不是立即卸载。

### 9.3 Dialog 焦点恢复

扩展现有 `dialog-focus.ts`，统一执行：

1. 打开前捕获 `document.activeElement`。
2. dialog mount 后执行现有 initial focus 和 Tab trap。
3. Escape、backdrop、close button 和外部状态关闭走同一个 close path。
4. exit 完成或 dialog unmount 后，把焦点恢复到仍连接在 document 的原触发元素。
5. 原元素已不存在时不猜测替代焦点，不把焦点送到 body 内任意元素。

Settings 和现有使用 dialog helper 的创建/确认弹窗复用同一逻辑。

### 9.4 历史菜单

每条历史记录改为：

- 主选择按钮。
- 使用 Lucide `MoreHorizontal` 的显式 icon button，带 `aria-label` 和 tooltip。

菜单行为：

- icon button 的 Enter/Space 打开菜单。
- row 的 ContextMenu/Shift+F10 继续支持鼠标和键盘上下文菜单。
- 打开后焦点移动到第一个 `role="menuitem"`。
- Escape 关闭并把焦点恢复到 opener。
- pointerdown outside 关闭。
- 菜单使用 `role="menu"`，删除项使用 `role="menuitem"`。
- 坐标在测量菜单后限制到 viewport 内，四周至少 8px 间距。
- 删除行为和现有 API 不变，不新增确认步骤或批量操作。

### 9.5 移除 paint-heavy shimmer

删除 `.reasoning-shimmer` 的移动渐变和 `background-position` 无限动画。

流式 reasoning 使用静态 muted 文本与现有小型 typing indicator；若保留 pulse，只允许作用于固定尺寸的小图标并使用 opacity。`prefers-reduced-motion` 下不执行 pulse。

### 9.6 动画交互批验收

- 打开 100 条 persisted 历史时 message row 不带 initial motion。
- 新 live message 仍执行一次入场，持久化后不重复。
- Settings close 等待 exit 完成。
- Settings gear、任务创建按钮等 dialog opener 在关闭后恢复焦点。
- 历史删除可通过显式按钮、Enter/Space、Shift+F10、Escape 完成完整焦点流。
- 320px 宽与常见桌面 viewport 下菜单不溢出、不遮住相邻控件。
- CSS 扫描不再出现 reasoning shimmer 的移动渐变动画。

## 10. 错误与恢复策略

| 场景 | 行为 |
|------|------|
| 外链 URL 无效或 scheme 不允许 | 阻止导航，结构化 warning，不调用 OS shell |
| task/approval schema 无效 | capability handler 前返回 validation error，不持久化 |
| 删除流程中途失败 | journal 保留当前状态，thread 隐藏，立即请求或下次启动幂等恢复 |
| retention/full check 失败 | 记录 maintenance failure，应用继续运行，下周期重试 |
| startup fast probe 失败 | 阻止 kernel 启动，保留原数据库 |
| backup 任一库失败 | backup 标记失败，不产生 complete manifest，不修改当前 data |
| restore staging 验证失败 | 删除或保留 failed staging 供诊断，当前 data 不变 |
| restore generation switch 失败 | 自动切回 rollback generation并返回失败 |
| history cursor 非法或 sequence 冲突 | 显式失败，不静默排序或重置全历史 |
| private bytes 不可测 | Windows performance gate 失败为 measurement unavailable |

## 11. 数据迁移与兼容

需要的数据库变化只有：

- task DB：`thread_deletion_journal` 及状态查询索引。
- core DB：`database_maintenance_runs` 及 kind/finished-at 查询索引。
- agent DB：`agent_events(thread_id, sequence)` cursor 查询索引；不新增或回填第二个 cursor 字段。

现有 `agent_events.sequence` 直接作为 cursor，不回填第二个 cursor 字段。

IPC 合同变化：

- background task create 从 preview 改为 raw request。
- task thread messages 从 array 改为 page request/page response。
- performance sample 增加全进程汇总字段并改变 budget 判定含义。

这些变化在 main、preload、renderer 和生成 IPC schema 中一次完成，不保留旧签名、别名或双读逻辑。

## 12. 测试策略

### 12.1 每批 TDD

每个问题先增加能稳定复现当前失败的测试。测试必须断言业务结果、状态、side effect 或错误分支，不用弱断言替代。

### 12.2 目标测试

安全批：

- main navigation policy
- Markdown controlled link
- task capability schema
- task repository risk derivation
- agent approval schema

数据一致性批：

- sqlite checkpointer contract
- deletion journal migration
- failure injection 与 restart recovery
- scheduler/list visibility

数据库批：

- kernel fast probe
- maintenance scheduler
- runtime retention integration
- backup/restore/rollback CLI

性能批：

- AppShell event filtering
- task history cursor/query plan
- transcript pagination/virtualization
- loader concurrency
- build chunk budget
- 1k/10k benchmark 与 performance smoke

动画交互批：

- persisted/live motion ownership
- Settings presence lifecycle
- dialog focus restore
- history menu keyboard/focus/viewport
- responsive layout smoke

### 12.3 每批验证门禁

每批至少执行：

1. 本批目标 Vitest。
2. `pnpm typecheck`。
3. `git diff --check`。

额外门禁：

- shared/IPC 改动：`pnpm generate:ipc` 后 `pnpm check:ipc`。
- database migration：对应 infrastructure tests 与 migration checksum tests。
- renderer UI：对应 renderer tests；响应式风险运行 `node tests\smoke\responsive-layout-smoke.mjs`。
- bundle/performance：`pnpm build`、chunk budget、`pnpm smoke:performance`。
- backup/restore CLI：目标 CLI integration tests；native/packaging 边界变化时运行 `pnpm verify:native-packaging` 和 `pnpm package:dir`。

## 13. Review 与提交门禁

每批实现完成后先 review 当前 diff：

1. 先列问题，按严重度排序并带文件/行号。
2. 重点检查行为回归、IPC schema、路径边界、持久化恢复、错误处理和测试缺口。
3. 有问题先修，再重跑直接验证。
4. 没有问题时明确记录“未发现问题”和剩余风险。
5. 只有 review 与验证都通过后才提交。

计划提交顺序：

1. `fix: harden renderer security boundaries`
2. `fix: make thread deletion recoverable`
3. `feat: activate database maintenance lifecycle`
4. `perf: bound renderer history and startup cost`
5. `fix: complete dialog and history interactions`

提交内容只包含本批代码、测试和必要生成文件，不混入下一批工作。

## 14. Completion Audit

五批全部提交后，重新基于当前工作树执行：

```powershell
pnpm exec tsc --noEmit -p tsconfig.json --noUnusedLocals --noUnusedParameters
pnpm typecheck
pnpm check:ipc
pnpm build
pnpm test
node tests\smoke\responsive-layout-smoke.mjs
pnpm smoke:electron
pnpm smoke:performance
git diff --check
```

如果涉及 CLI/native/package 路径，再执行：

```powershell
pnpm verify:native-packaging
pnpm package:dir
```

Completion audit 还要逐项回读本设计的验收表，确认没有依靠旧基线、计划状态或单个绿测提前宣告完成。

## 15. 审计问题覆盖表

| 审计问题 | 批次 | 直接证据 |
|----------|------|----------|
| Markdown 同窗外链 | 安全 | will-navigate + controlled link 回归 |
| renderer 篡改 task confirmation/risk | 安全 | raw create request + main derivation + schema test |
| Approval decision 空 schema | 安全 | approve/reject/edit 判别联合 |
| Checkpointer 扩大删除契约 | 数据一致性 | checkpoint-only delete test |
| task/agent 双库删除非原子 | 数据一致性 | journal failure injection + restart recovery |
| Retention 未接入 | 数据库 | runtime maintenance integration |
| 六库启动同步 quick check | 数据库 | fast probe 与 delayed full check 测试 |
| Backup/restore 不可达且无回滚 | 数据库 | offline CLI + staging generation + rollback |
| 普通 chat 触发 AppShell 根渲染 | 性能 | task run id filter test |
| Transcript 全链路无界 | 性能 | cursor page + Virtuoso + 10k benchmark |
| 首屏 JS 过大 | 性能 | lazy boundary + 1.5 MB build gate |
| 性能预算只看 main RSS | 性能 | total private bytes gate |
| Loader 瀑布 | 性能 | promise start-order test |
| persisted history 批量入场 | 动画交互 | source-aware initial test |
| Settings exit 不执行 | 动画交互 | parent presence lifecycle test |
| Dialog 不恢复焦点 | 动画交互 | opener focus restore test |
| 历史删除仅右键可达 | 动画交互 | explicit button + keyboard/menu tests |
| paint-heavy shimmer | 动画交互 | CSS residue scan + reduced-motion test |
