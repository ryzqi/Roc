# 科研性能测量

本页维护测量方法与解释范围。生产行为见各功能专题；检查选择见[开发指南](development.md)，科学质量评估见[评测指南](../evaluation/README.md)。

## 测量入口

在仓库根目录运行，显式指定新的报告路径。部分脚本会覆盖同名文件，不能复用已有基线的输出路径。报告保存协议、源码摘要、环境及样本；比较前须核对这些条件。

| 范围 | 命令 | 测量边界 |
| --- | --- | --- |
| SQLite FTS / 精确向量检索 | `pnpm research:retrieval-bench <新报告.json>` | 隔离合成 chunk 与向量的吞吐，包含项目过滤；不测 embedding 质量 |
| PDF 原生解析 / 页面代理复用 | `node scripts/benchmark-pdf-document-parser.mjs <新报告.json>` | 原生文本长文档、单页、取消与页面生命周期；缺模型路径不构成 OCR 吞吐测量 |
| 图谱邻域 | `pnpm research:graph-bench <新报告.json>` | 已记录关系与共享证据的邻域展开、分页；不测力导向布局 |
| 原生进程准入 | `pnpm research:admission-bench <新报告.json>` | macOS 原生探针的排队、容量、取消与清理；不测计算引擎吞吐 |
| 网络请求治理 | `pnpm research:network-bench <新报告.json>` | 注入响应下的缓存、退避、限流和取消；不访问真实服务 |
| 管理存储盘点 | `pnpm research:storage-bench <新报告.json>` | 隔离生成目录的扫描、计数及只读行为；不测真实用户库 |
| macOS UI 启动与历史加载 | `node scripts/performance/bench-macos-app.mjs <新报告.json> --samples 5 --idle-minutes 0` | 0/1,000/10,000 条合成用户消息，各启动 5 次；1440×900 实际 CSS 视口；主壳、首次绘制、助手输入与历史就绪，进程内存、CDP JS heap/DOM |
| macOS 可见 / 隐藏长期空闲 | `ROC_PERF_IDLE_VISIBILITY=both node scripts/performance/bench-macos-app.mjs <新报告.json> --samples 5 --idle-minutes 30` | 先可见 30 分钟，再原生关闭隐藏 30 分钟；各采样 0/5/30 分钟，记录真实窗口状态、Renderer 转发状态、heap/DOM、进程内存与主进程 CPU |
| UI 大规模交互 | `node scripts/performance/bench-ui-workloads.mjs <新报告.json> --samples 5` | 已构建普通 production 应用独立运行 5 轮，每轮覆盖 7 场景；真实应用与 IPC：100 项目搜索；100/2,000/10,000 文献逐页加载后滚动；20 次画布切换；500/5,000 历史消息上接收本地 SSE 500/5,000 个流式增量 |
| 持续 30 分钟流式 | `ROC_PERF_UI_WORKLOADS=1 ROC_PERF_STREAM_MINUTES=30 node scripts/performance/bench-macos-app.mjs <新报告.json> --samples 5 --idle-minutes 0` | 完成上述交互后，在 5,000 条种子历史所在会话持续接收真实本地 SSE；0/5/15/30 分钟各采样 3 秒，检查增量持续推进、Composer 草稿、窗口化消息、heap/DOM 与长任务 |
| PDF 连续翻页 | `ROC_PERF_PDF_PAGE_TURNS=200 node scripts/performance/bench-pdf-reader.mjs <新报告.json> --samples 5` | 固定 400 页真实 PDF，连续点击下一页 200 次；每次验证目标页、新 canvas 分配和栅格完成，随后沿用原有后台解析 / IPC 竞争测试 |
| 长流与可见 / 隐藏空闲各五轮 | `node scripts/performance/bench-repeated-workloads.mjs <新报告.json> --workload endurance --samples 5` | 严格串行重复整个底层脚本；每轮可见空闲 30 分钟、隐藏空闲 30 分钟、持续流式 30 分钟，各命名检查点取得 5 个独立进程样本 |
| PDF 连续翻页五轮 | `node scripts/performance/bench-repeated-workloads.mjs <新报告.json> --workload pdf --samples 5` | 每轮独立进程和资料根，固定 400 页 PDF 连续翻页 200 次；保留每轮完整报告，跨轮汇总整体耗时及各轮页内分位 |
| React 渲染热区 / Renderer IPC | `node scripts/performance/bench-react-profiler.mjs <新报告.json> --samples 5` | 专用 profiling 构建，完整 UI 大规模交互独立运行 5 轮；10 个静态 React 边界与 preload invoke 精确计数；不与普通构建的耗时混用 |

各脚本内的协议定义规模、样本数、分位数算法和阈值。SQLite 新连接只重置连接缓存，不清除操作系统缓存；少量 nearest-rank 样本中的 P95 可能就是最大值。进程 RSS 可能包含导入、数据生成及前序样本，数据库文件大小不等于瞬时 WAL 或 APFS 独占占用。

PDF 原生提取事件、解析发布和 Electron 首次绘制是不同计时边界。解析版本以[运行时合同](../resources/research-runtime/README.md)为准。扫描件、混合 PDF、真实模型缓存与阅读器帧率需要各自的样本和运行。

UI 基线先执行 `pnpm build`，随后串行量测，期间不并行运行 Electron 回归或构建。两个 UI 基准默认只保留 JSON 与 Markdown 报告；隔离数据根、数据库、诊断截图与 HTML 在结束时清理。需要检查失败现场时显式设 `ROC_PERF_KEEP_ARTIFACTS=1`，诊断目录会写入报告，复核后由执行者清理。报告保留构建 manifest 与脚本摘要；`trackedDirty` 必须连同具体变更范围解释。新 profile 不代表冷磁盘；助手首次懒加载就绪不等于热输入到绘制延迟。CDP heap/DOM 为采样点瞬时值，挂载消息只计用户/助手消息行，不能将总 DOM、控件或状态计数当消息数。`--idle-minutes 0` 不测长期空闲。

普通 UI、React Profiler 与重复工作负载的上层入口统一清除继承的 `ROC_PERF_*`、`ELECTRON_RENDERER_URL` 和 `ELECTRON_RUN_AS_NODE`，再显式指定本轮模式、构建目录及清理策略，防止工作站开发服务或上一轮选项改变实际被测对象。需要自选原始 trace 等选项时，使用相应底层入口。子报告读取采用共同的容错路径：缺失报告保留 null；截断或无效 JSON 保留解析错误及原始内容，不因再次解析失败跳过最终失败状态保存。

`ROC_PERF_IDLE_VISIBILITY` 可选 `visible`、`hidden`、`both`，默认 `hidden` 兼容已有协议。`both` 总计观察两段独立空闲时长。空闲期间不启用 tracing 或 RAF 循环；每个检查点同时验证原生窗口可见性与 Renderer 收到的 hidden 状态。`mainCpuOneCorePercent` 为 `process.cpuUsage()` 差值 / 墙钟时长，100% 表示占满一个逻辑核；它不除以逻辑核数，也不等同 Electron 各进程自己的采样区间 CPU 百分比。检查点能证明采样状态，不能证明两个点之间没有任何活动。

大规模交互与连续 PDF 翻页使用短窗口 CDP `devtools.timeline,toplevel,blink.user_timing` trace。报告保留事件总数、Renderer 主线程标识、顶层任务总耗时、≥50ms 长任务数量/耗时、Layout/Paint 各自的嵌套耗时，以及 RAF 间隔分位和输入事件到第二次 RAF 的代理延迟。Layout/Paint 不再累加进顶层 busy 时间，避免重复计量。RAF 频率不是合成器 FPS，第二次 RAF 是绘制机会代理，不能当作显示器呈现延迟；tracing/RAF 观察器本身有开销。默认只保留上述摘要；显式设置 `ROC_PERF_RAW_TRACE_DIR=<本次临时目录>` 可输出完整 Chrome trace JSON，使用独占创建防止覆盖已有 trace，复核后删除该临时目录。

列表样本通过真实搜索和“加载更多”取得全部页面，再验证末条与窗口化 DOM。流式样本将 500/5,000 条持久化用户消息与 500/5,000 个本地受控 SSE 增量分开记录，并在流式期间编辑真实 Composer；它不代表 500/5,000 次模型 run、真实远端吞吐或持续 30 分钟流式。底层 `bench-macos-app.mjs` 的 `--samples` 仅控制独立启动次数，其大规模交互和持续流式在一次脚本调用中各执行一次；连续 PDF 翻页也在对应底层脚本中执行一次。普通 `bench-ui-workloads.mjs --samples 5` 为每轮重新启动底层脚本，取得 7 个交互场景各 5 个独立样本；使用已有 `dist`，不构建、不启用 profiling、不执行长期空闲或持续流式。每轮隔离用户资料与中间 JSON/Markdown 自动清理，最终报告保留全部原始子报告和跨轮 P50/P95。汇总不把轮内 20 次切换当 20 轮；RAF/输入分位列是各轮分位值的统计，不是合并事件分布，缺少输入样本保留 null 和缺失次数，不补零。源码、构建、协议、fixture、主机或场景覆盖变化时拒绝合并。

持续流式须显式设 `ROC_PERF_STREAM_MINUTES=30`，并同时启用 `ROC_PERF_UI_WORKLOADS=1`；可设 `1` 先验证流程，`0`（默认）不运行。该场景沿用已经跑过一轮短流的 5,000 条历史会话，种子历史数与先前短流次数分别记录。Provider 通过实际 HTTP SSE 每 360ms 发送一块，生产模型适配、IPC 与 Renderer 正常处理；末个检查点后预留 15 秒余量，并验证首尾文本增量的实际间隔至少达到请求时长、同一 run 正常完成及末块已渲染。不能用提前完成后等到 30 分钟替代持续流式。0/5/15/30 分钟各启用约 3 秒 tracing/RAF，窗外仅每分钟读取有界的事件计数与最新接收时间，确认流未停止；不全程积累事件正文或 trace。失败时主动断开此隔离 Provider 的活连接，清理等待定时器与临时资料根。工程脚本存在不等于当前版本实测通过；只有保存的正式报告可以支持对应运行结论。

正式收集长流、可见空闲、隐藏空闲或连续翻页的 5 个独立样本，使用 `bench-repeated-workloads.mjs`；其 `--samples` 默认 5，控制完整子进程轮数。该入口要求已有普通 `dist`，拒绝 profiling 构建标记，不构建应用；清除继承的 profiling、原始 trace、PDF 参考版本和成对对比选项，并强制清理模式。每轮底层 `--samples 1`，等待子进程及其输出关闭后才开始下一轮，不与其他 Electron 检查或构建并行。`endurance` 保留原场景顺序：空项目资料根可见 30 分钟后隐藏 30 分钟，随后在另一隔离资料根执行 UI 场景及 30 分钟流式；它不是同一会话连续运行 90 分钟。五轮至少需要 7.5 小时，再加启动、交互、结束验证与清理时间；`--samples 1` 仍执行完整时长。`pdf` 每轮沿用既有打开 / 关闭、200 次连续翻页、后台解析与 IPC 竞争流程。

重复入口按相同命名检查点分别汇总跨轮 P50/P95；不混合 0/5/15/30 分钟，也不把一轮 200 页当作 200 个独立样本。页内栅格耗时 P95、RAF / 输入 / 事件循环分位是先在每轮取得数值，再比较这些数值，不代表合并后的事件分布。空闲起点没有 CPU 差分区间，保持 null 和缺失计数。源码、构建、fixture、协议、主机或场景覆盖不一致，或流式终态、持续时长、空闲可见性、页码序列缺失时，不接受该轮进入汇总。最终 JSON 的 `runs` 嵌入每轮原报告；失败立即停止后续轮次，明确记录 `failed` / `not_run`、退出状态、可用的部分报告和有界 stderr。JSON 与 Markdown 都显示整体状态及完成轮数；已有成功样本可保留汇总，但不足 5 轮不构成五轮验收。子报告 JSON/Markdown 在 `finally` 清理，资料根仍由底层脚本清理，正式报告保留。

长流和空闲检查点另记录 `rendererProcessCount`、`rendererAppMetricsCpuPercentSum` 与 `rendererWorkingSetBytesSum`，按 `app.getAppMetrics()` 的 `type: Tab` 筛选 Renderer 并求和。CPU 保留 Electron 原 `cpuPercent` 的采样区间与比例，不把它解释为主进程 `mainCpuOneCorePercent`，也不额外声称已按单核归一化。缺少 Tab 进程时，计数为 0，CPU 与工作集为 null 并计入缺失样本，不写成零占用；工作集仍可能包含共享页。

React 专用入口要求已有普通 `pnpm build` 产物。它以 `electron.profiling.config.ts` 在仓库根的临时 `.roc-profile-*` 目录构建，将 `react-dom/client` 精确映射到 `react-dom/profiling`，并在构建时为 root、shell、canvas、sidebar、assistant、transcript、composer、library、reader、graph 注入稳定的 Profiler 包装。构建证明校验实际进入 bundle 的 profiling reconciler、全部边界，以及普通 dist 的摘要前后一致且没有 profiling API；普通配置和组件源码不包含这些观察器。临时构建、每轮中间报告及隔离用户资料在结束时清理，正式 JSON/Markdown 保留源码与构建摘要、各轮样本和汇总。跨轮汇总拒绝源码、依赖锁、构建、协议、fixture 或主机变化，以及失败、不完整和非 profiling 的子报告。普通 UI、Profiler 与重复工作负载的 Markdown 均在测量表之前显示整体状态、完成轮数和失败原因，失败轮次从 1 开始；保留的部分汇总不能充当完整五轮验收。`--samples 1` 只用于预检，不能充当 5 次样本。

`actualRenderMs` 来自 React `Profiler.onRender` 的 `actualDuration`，是子树包含式渲染耗时，不是 commit 阶段耗时；嵌套边界不能相加。`commits` 是该边界收到的回调次数，`baseDuration` 是 React 估计值。每个边界只保留最慢 8 次数值诊断，不能据此计算所有 commit 的 p95；报告 P50/P95 基于各独立运行的总渲染耗时和次数。Renderer IPC 通过专用 preload 统计窗口内每次 `invoke` 开始，按 channel 保留调用数、完成/拒绝数、应用层失败数、未决数及已完成往返耗时；不读取消息正文、不估算字节，不包含主进程事件和回调推送。主进程已有的 500 条环形采样不能代替这一完整窗口计数。专用 reconciler、边界和计数器均有测量开销，因此 profiling 报告仅用于定位热区与重复调用，不替代普通生产构建的性能验收。

`research.getStorageUsage({projectId})` 只盘点配置的受管目录。逻辑字节、按 inode 去重的分配块、索引 payload 与数据库分配各有含义；缺失目录和读取错误必须保留。盘点结果不授予删除权限，合同见[执行资源](research-execution-resources.md)。

## 2026-11-23 UI 工程基线

[固定基线数据](ui-performance-baseline-2026-11-23.json)保留每次样本、进程采样及源码/构建摘要，供后续阶段同机比较。应用源码为 `42c3a78a0e45a017c389870edf06c07ae3c80def`；量测时未提交差异仅为本次 benchmark、审计脚本和文档，未修改被测生产代码。基准脚本 SHA256 为 `8cdbe04759a0b6e9a1297eba34b48462c6d0320dcfb6190cea148bf58f99543f`，renderer manifest 为 `7624252b6a1ca3b09e7b29460654df06363d43374f008b0ae50a6b2aad8b2fec`。

P0 的实际量测脚本随后提交于 `e57ec6c`，其内容摘要与上述 SHA256 完全一致；不能直接把 `42c3a78` 当作当时工作树中的脚本版本。静态核对确认，当前普通 `dist`、`--idle-minutes 0` 且未启用 UI / profiling 的启动计时边界、1440×900 视口、CDP 采样、事件规模和 P0 相同。普通启动夹具保留原有 0/1,000/10,000 事件数据，不新增 append cursor；只有需要真实追加消息的 UI 夹具显式初始化 `next_sequence`。单元回归分别检查原始启动数据和 UI 连续追加，避免修复流式夹具时改变启动对照。

当前启动报告在 fixture 中显式增加 `buildMode: production` 与 `appBuildDir: dist`，因此 `fixtureSha256` 与 P0 不同，通用 `compare-reports.mjs` 仍会拒绝直接比较。人工对照只能在两份原始报告之外说明这两个字段是 P0 默认值的显式记录，并逐项核对协议、依赖锁、同机环境 / 显示器 / 电源配置、实际构建模式、0/1,000/10,000 场景与各 5 次样本一致；记录原始摘要和本次源码 / 构建摘要，不改写旧报告或放宽通用比较器。必须单独运行普通启动入口，不能取 UI / Profiler 报告内不同 fixture 的启动样本替代。若还有其他差异，只并列展示并说明限制；脚本与口径核对本身不构成性能通过证据。

环境：Apple M1 Pro / 32 GiB、macOS 27.2.1 arm64、Node 26.13.1、Electron 45.3.4、pnpm 12.21.0；显示器 1512×982、scale 2，实际 CSS 视口 1440×900。每组 5 次独立资料根启动，串行运行；OS 缓存未清除。以下为 P50 / P95，5 次样本的 nearest-rank P95 等于最大值。

| 合成用户消息 | 主窗就绪 ms | 首次内容绘制 ms | 首次助手输入区就绪 ms | 历史末条可见 ms | Renderer heap MiB | 已挂载消息行 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 1226.6 / 1289.8 | 200 / 224 | 630.9 / 669.4 | 不适用 | 15.2 / 15.4 | 0 |
| 1,000 | 1254.2 / 1347.2 | 224 / 228 | 636.4 / 675.0 | 123.0 / 124.0 | 16.3 / 18.4 | 13 |
| 10,000 | 1262.0 / 1276.6 | 212 / 228 | 635.2 / 646.0 | 120.2 / 134.8 | 16.3 / 16.7 | 13 |

消息行数字只说明采样时的窗口化挂载；不证明 10,000 条流式模型消息全程性能。首次助手输入区就绪包含导航/懒加载，个别样本已提前完成加载，因此原始样本保留约 65–67ms 的低值；它不等同输入到绘制延迟。Heap 为采样点值，进程 working-set 合计包含共享页，不能代替峰值、独占内存或泄漏结论。30 分钟空闲、长时间流式、PDF 翻页、FPS 和 Profiler 热区尚待单独测量。

## 冻结向量检索回归

```sh
pnpm evaluation:frozen-retrieval:check \
  --corpus tests/fixtures/local-retrieval-quality-context-role-v2.json \
  --output-root .artifacts/frozen-retrieval
```

`--corpus` 必填，`--output-root` 是新 run 目录的父目录，默认 `evaluation/runs/`。[适配器](../evaluation/adapters/frozen-retrieval/index.mjs)在隔离内存库中使用生产 schema、FTS、sqlite-vec 和 RRF，读取捕获的向量；统一 CLI 封存 manifest、journal、trial audit 和 summary。它不执行 ingestion、embedding 生成或建索引质量评估。

Contract 2 要求来源/chunk 与实际上下文 embedding 输入哈希、向量 provenance、producer/reviewer/split，以及每种策略全部范围内 chunk 的 0–3 相关性标签。输入漂移、无效身份或缺失标签在评分前失败；输入变化须另建版本化 fixture，真实模型向量需要重新嵌入。

仓库的 [context-role fixture](../tests/fixtures/local-retrieval-quality-context-role-v2.json) 使用合成向量，只验证工程排序。Recall@20、nDCG@10、证据链覆盖和无答案问题的非空检索分别报告；证据链覆盖不能证明推理正确，非空检索也不是回答拒答率。完整科学质量需要独立人工审查的数据和真实模型运行。

## 固定测量文件

以下 JSON 保留各自测量时的协议、来源与限制，不作为当前代码的通过声明。只有相关原始输入和产物齐备、合同兼容时才能重评分或比较。

| 类型 | 数据 |
| --- | --- |
| 检索 | [协议](research-performance-protocol.json)、[初始测量](research-retrieval-baseline.json)、[窄排序测量](research-retrieval-narrow.json) |
| PDF 与图谱 | PDF 原始报告 `docs/research-pdf-performance.json` 仅在本地留存；[图谱](research-graph-performance.json) |
| 资源治理 | [准入](research-admission-performance.json)、[网络](research-network-performance.json)、[存储](research-storage-performance.json) |
| 旧冻结 fixture | [输入](../tests/fixtures/local-retrieval-quality.json)、[结果](research-local-quality-fixture.json)，用于保留来源与输入漂移对照 |

## 画布宿主保留预算

`app/view-retention.ts` 按项目内的宿主身份决定组件保留，模块缓存与组件挂载分别管理。`discover`、`knowledge`、`library` 共享一个文献宿主；切换项目时整个 `ViewContent` 按项目键重建，缓存的组件状态不跨项目。

| 宿主 | 隐藏后的策略 | 状态边界 |
| --- | --- | --- |
| `overview` | 成功切换后卸载，后台只读宿主预算为 0 | 无编辑草稿；再次进入重新读取项目、任务与成果，总览展开状态和滚动位置重置 |
| `library` | 访问后固定保留一个宿主 | 阅读笔记、Wiki 草稿、检索上下文及监控未决操作仍由内部组件持有 |
| `writing` | 访问后固定保留一个宿主 | 未保存文稿、编辑器选区与同步提议仍依赖组件生命周期；PTY 由主进程持有 |
| `runs` | 访问后固定保留一个宿主 | 后台任务编辑器的未保存配置、待完成操作及导航守卫 |

当前最多挂载 3 个草稿/会话宿主，以及正在显示的只读总览；显示草稿/会话宿主时最多挂载 3 个。只有目标模块成功解析后才执行释放；冷导入期间和导入失败时保留当前画布。再次进入总览会复用已加载模块，不重复下载 chunk。

固定保留宿主继续通过 `ViewActivity` 暂停已接入的隐藏资源与轮询；草稿导航监听仍在组件 effect 内，不能把整个宿主直接改为卸载或 React `Activity`。终端内部已单独分离生命周期：隐藏时释放 xterm DOM、尺寸观察和输出订阅，主进程继续持有 PTY；重新进入按窗口、项目和目录恢复同一会话及有界序号输出。显式结束、窗口销毁和应用退出释放 PTY。详见[终端会话合同](terminal-sessions.md)。

文献上下文侧栏保留分类、搜索、排序、多选和虚拟列表状态；关闭侧栏不会释放全部列表 DOM，已加载结果仍由虚拟化限制挂载行数。分类与 Zotero 统计只在文献数组变化时重算，批量所选条目及键盘导航索引按各自依赖缓存，避免加载状态、动作反馈等更新反复扫描整库。隐藏期间仍接收真实 store 的查询、项目与动作更新，查询往返或项目切换照常清空失效多选，不冻结整份 store。`tests/renderer/literature-list-layout.test.mjs` 在真实 Electron 中验证统计刷新、隐藏前后筛选与滚动保留、外部焦点不被抢走，以及隐藏期间查询往返和项目切换的多选失效。

`tests/unit/renderer-view-retention.test.mjs` 验证预算与共享身份；`tests/renderer/canvas-view-loading.test.mjs` 在 Electron 中使用受控视图导入器验证冷加载/失败衔接、20 次切换的挂载数、草稿/选区/导航监听保留和项目键重建后的清理。生命周期计数是宿主回归证据，不是内存节省的测量；真实 PTY 恢复另由 `tests/integration/terminal-session-reattach.test.mjs` 验证，性能变化仍以同构建的正式报告为准。
