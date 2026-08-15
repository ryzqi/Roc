# Roc Agent Harness 发现

> 职责：保存已确认技术事实、合同、残余风险和可复用证据。规格见 `plan.md`，活动待办见 `task_plan.md`，时间线见 `progress.md`。

## Durable Project Facts

- `.codegraph/` 存在；理解或定位代码时先使用 CodeGraph。
- `/workspace/` 是 Deep Agents file-tool 虚拟路径，不是 shell cwd。Shell、hook 和 subprocess 必须使用真实 Windows 工作目录。
- Run capability、tool identity、execution scope、effect policy 和 background shell authorization 以冻结 manifest/snapshot 为执行事实源。
- Agent DB 持有 run、timeline、outbox 和 telemetry 真相；task DB 只做幂等 projection；EventBus 不是 durable state owner。
- 同 thread active run 使用 CAS/lease；background occurrence 使用 durable claim/lease 和 latest-only coalesce。
- Interactive shell 无审批但仍是 host code execution；background shell 缺 durable pre-authorization 时 fail closed。
- Effect 状态包含 checkpoint/subagent execution path；`unknown` 或 manual-confirmation effect 不允许盲重试。
- `plan.md` 是未跟踪的长期规格源；当前工作树、Git 历史和新鲜验证优先于旧文档描述。

## Open Risks

| Severity | Risk | Closure |
|---|---|---|
| External | 真实 Anthropic live eval 未运行；当前环境无 `ANTHROPIC_API_KEY`。 | Blocked, not run；本地合同已验证。 |
| Low | `deepagents` 对 `langsmith@^0.7.1` 的 peer warning 在 1.10.7/1.10.8 均存在。 | 保留；由 official contracts、typecheck、package 与 smoke 证明实际组合。 |
| Low | deterministic local eval 不覆盖真实 provider 的 cache/token/异常差异。 | 保留；live eval 需要 key 后才可补充。 |
| Low | 多个 crash residue trace sessions 在 plugin initialize 中逐条 drain，可能放大启动延迟。 | 保留；顺序确定性优先，非阻断。 |
| Low | final-output helper 对稳定 DTO getter 读取两次，未固定单次快照。 | 当前固定包下非行为缺陷；升级或重构时收敛。 |

## Verification Anchors

- Telemetry 与 run lifecycle：`tests/main/plugins/agent/run-telemetry-repository.test.ts`、`runtime-executor.test.ts`、`runtime.test.ts`、`session-repository.test.ts`。
- Migration/lifecycle：`tests/main/infrastructure/database-migrations.test.ts`、`database-retention.test.ts`、`tests/main/plugins/task/agent-outbox-projector.test.ts`。
- Backpressure：`tests/main/plugins/agent/run-event-backpressure.test.ts`。
- Windows cancellation：`tests/main/services/shell-execution-cancellation.test.ts`、`tests/main/services/hooks/command-runner.test.ts`。
- Observability settings：`tests/renderer/settings-view.observability.test.tsx`、`tests/main/preload-contract.test.ts`、`tests/main/ipc-plugin-adapter.test.ts`、`tests/smoke/responsive-layout-smoke.mjs`。
- Agent integration mode：`tests/config/agent-integration-mode.test.ts`、`tests/integration/agent/offline-harness.int.test.ts`、`vitest.agent-integration.config.ts`。
- Middleware overlap：`tests/main/services/deep-agent/middleware-overlap-conformance.test.ts`、`tests/main/services/deep-agent/context/native-summarization-conformance.test.ts`。
- UI/transcript performance：`tests/smoke/performance-smoke.mjs`。

## Run State, Timeline, Effects

- `ChatStartRunRequest` 不是 durable execution snapshot；Stage 1 后 executor 只接受 persisted `RunExecutionSnapshot`，preview/executor/audit/resume 共享同一 manifest hash。
- Run 状态用显式 allowed transition + CAS；terminal run 状态、canonical event、outbox 和 telemetry 在同一 agent DB transaction 内提交。
- EventBus 只做 notification，subscriber 失败不改变 run outcome；renderer 可按 run/sequence replay 补洞。
- Chat run event queue 有界并支持 producer backpressure；text/reasoning delta 可合并，结构事件不合并，overflow 返回结构化错误。
- Scheduler occurrence 是 durable claim/lease；sleep 或关机错过多次时只 coalesce 最新一次，同 task 不 overlap。
- Effect ledger key 为 run + execution path + checkpoint + stable call ID/input hash；retry-safe 失败可重试，pre-effect resolution 失败记 `failed_final`，不确定 manual effect 记 `unknown`。
- Main 与 subagent 都安装 native model/tool budget limiter，但四个 native counter 按 execution scope 独立；nested `task` 返回 parent 时过滤四个 counter，不把多个 subagent 的绝对计数聚合回 parent。

## Telemetry Contract

- 每个 run 持久化一个 versioned、redacted summary，覆盖 correlation、model usage、tool、subagent、context、runtime 和 terminal 状态。
- 持久模型不包含 raw prompt、reasoning、secret、workspace path 或完整 tool/subagent output；schema 顶层及各 section 均为 strict。
- `runId`、`threadId`、`occurrenceId`、`dispatchKey` 只属于 row/trace metadata，不得进入无限 metrics label key。
- Repository 读取时验证 JSON、schema version、row/payload `runId` 和完整 frozen identity；missing、corrupt、unknown field 或 identity mismatch 均 fail closed。
- Telemetry `snapshotVersion` 表示 runtime 规范化后的 execution snapshot contract，当前固定为 `2`；V1 snapshot 由 parser 迁移为 V2 后 backfill。
- Completed、failed、cancelled、interrupted telemetry 与 run 状态同事务提交；已终态化 row 拒绝覆盖。
- History deletion 在删除 `agent_runs` 前显式删除 telemetry；retention、database maintenance、required-table probe 和 health/kernel schema version 同步推进。

## LangSmith Contract

- LangSmith tracing 默认关闭，且必须显式 opt-in；只省略 `callbacks` 不够，`@langchain/core` 在 ambient tracing env 为 true 时仍会自动创建 tracer。
- enabled/project 与 API key 归 Agent plugin config/secrets，不升级全局 AppSettings，不复用 provider secret 语义。
- 一个 Roc run 映射一个持久化 trace root；同一 run 的 initial、HITL resume 和 recovery retry 复用该 root，跨进程重建不创建第二个 root。
- Export redaction：hide inputs/outputs/metadata，metadata allowlist，error 全量替换，删除 SDK 写入的 `extra.runtime` 与 LangChain `serialized` payload。
- Exporter failure 不改变 durable run 业务结果；terminal lifecycle 负责最终 PATCH、drain 和 client cleanup。
- Startup reconciliation 覆盖 terminal crash window 留下的 `cancelled/completed/failed/interrupted` trace sessions；`waiting_user` 非终态 session 保留。
- 可观测性 UI 通过独立 Agent capability/IPC 读取公开 config 与 `apiKeyStored`，输出 schema 不含 API key 明文。

## Agent Integration Mode

- 专用模式为 `tests/integration/agent/**/*.int.test.ts` + 独立 Vitest config；默认 Vitest 显式 exclude，避免普通 `pnpm test` 收集真实 harness 目录。
- 离线 case 始终执行，使用真实 `buildDeepAgent()`、`RocSqliteCheckpointer` 与 deterministic chat model；live case 仅在 `ROC_AGENT_INTEGRATION_LIVE=1` 时启用。
- 缺 key 时 live case 明确 skipped，不能把整个 integration command 空跑；opt-in 后缺 `ANTHROPIC_API_KEY` 明确失败。
- offline/live 共用 tracing env/key isolation：同时关闭新老 LangSmith/LangChain tracing flags、清空 key，并证明无外发 fetch。
- Deep Agents 原生 `write_todos` 返回 `Command`，同时写入 `todos` state 与带同一 `tool_call_id` 的 `ToolMessage`；latest Roc checkpoint 可回读两者。

## Deterministic Agent Eval

- 命令为 `pnpm eval:agent -- --mode deterministic`；runner 只接受显式 mode，missing/unknown mode fail closed。
- 初始 corpus 固定两个高信号 case：native `write_todos` 成功并持久化 todos；Plan Mode 即使 fake model 产生隐藏 `write_file` call，也必须返回 error tool result 且无 file side effect。
- Dataset 是显式 versioned 输入，缺失 dataset 时在 0 case 执行前失败；不使用 unit test 名称冒充 eval，不接外部 LangSmith dataset/judge。
- `ToolMessage.status` 在固定 `@langchain/core` 是 optional：native success 可省略，Plan Mode guard error 显式为 `error`；eval adapter 把 `undefined` 规范化为 `success`，不对其他未知值兜底。

## Live Agent Quality Eval

- 命令为 `pnpm eval:agent -- --mode live`；live/judge 仅 manual/nightly，缺 `ANTHROPIC_API_KEY` 必须在启动 Vitest 前明确失败。
- LLM judge 只评 response quality；terminal、trajectory、todos/files 与 checkpoint 仍由确定性断言拥有。
- Egress guard 只允许 Anthropic HTTPS default port，并强制 `redirect: 'error'`，防止非默认端口或自动跨域 redirect。
- 当前环境无 `ANTHROPIC_API_KEY`，真实 provider turn 是 `Blocked, not run`。

## Agent Performance Gate

- 命令为 `pnpm smoke:agent-performance`；它是独立 agent-loop 证据，不能由 UI/transcript performance smoke 代替。
- Artifact 使用 versioned schema、raw samples、thresholds 与判定；strict parser 从 raw samples 重算 P95、relative max、ratio、failed limits 与 metric pass，不接受篡改派生字段。
- Threshold failure artifact 必须包含完整有序 11 metrics；execution/network failure 可保留 partial metrics，且必须有非空 error。
- `RocPerformanceFakeModel` 绑定 tools 时共享严格递增 sequence，intermediate content 为空，terminal content 固定，并显式发出 token callback。
- Restart fixture 使用 file-backed Agent DB：关闭后重新打开同一路径、重建 checkpointer 和 agent，并以同一 `thread_id` 验证首轮 marker。
- Queue/outbox fixture 使用真实 queue 与 Agent/Task schema；`event_queue` 与 `outbox_projection` 已改为 end-to-end lag measurement。
- Temporary workspace 与 restart temp dir 在 smoke 前后必须为 0 残留；首个 SQLite connection 构造也在 nested cleanup 内。

## Stage 7.1 Middleware Responsibility Matrix

当前相关 `wrapToolCall` 外到内顺序为 Roc protocol -> error budget 与其余 safety owner -> native network retry -> runtime mapping -> resolution mapping -> effect ledger -> tool handler。Rescue 是 `afterModel` owner，PatchToolCalls 同时修复 agent/model 前的 message parity；两者不与 tool handler wrapper 争夺同一错误责任。

| Layer | Input | Output | Error | Retry | Effect | Event | Owner |
|---|---|---|---|---|---|---|---|
| Deep Agents `PatchToolCallsMiddleware` | 当前 `messages`，包括 orphan `ToolMessage` 与 dangling `AIMessage.tool_calls` | 删除 orphan result，为 dangling call 注入 cancellation `ToolMessage`，并把同一 parity history 交给 model | 不分类 Roc domain/protocol/runtime error | 无 | 无 | 修复后的 messages 是 native projection 输入 | Deep Agents 1.10.7；CompiledSubAgent 由 `agent-builder.ts:compileRocSubagent` 显式安装 |
| Roc tool protocol | `ToolCallRequest`、runtime tool identity、frozen capability manifest、main/subagent scope | 仅对已授权 call 规范化 background-task JSON handoff 参数，其余 args 原样透传 | 未注册、scope denied、runtime identity drift 直接 fail closed | 无；未知工具不进入 network retry | 无 | 下游 native event 使用通过授权并规范化后的 call | `tool-protocol.ts:createToolProtocolMiddleware` |
| Rescue parsing | model 返回的最后一个 `AIMessage`、当前可用 tool candidates | 将受支持的文本/content-block 格式重建为 structured `tool_calls`；无法唯一解析则不改 | 不处理 tool execution error，不接受未知 tool name | 无 | 无 | 生成的 structured call 由 native tool event owner 投影 | `forge-guardrails/middleware/rescue-parsing.ts` 与 `rescue-parser.ts` |
| Tool resolution | 原始或 `MiddlewareError` 包裹的 `RocToolResolutionError` 与 call identity | tagged soft `ToolMessage(status: success)`，内容为 `[ToolResolutionError] ...` | 仅消费 resolution error，其他异常原样抛出 | 无 | effectful call 必须先由内层 ledger 记 `failed_final`；本层不写 ledger | soft `ToolMessage` 进入 native tool-result/message projection | `forge-guardrails/middleware/tool-resolution.ts` |
| Runtime error mapping | 内层未消费的 `RocDomainError` 或 generic tool error | product `ToolMessage(status: error)`；保留 Roc code/message/userAction | `GraphBubbleUp`、abort 与 `web_read`/`web_search` error 原样向外抛 | 不重试；network error 明确留给外层 native retry | effect ledger 已先记录；本层不改变状态 | error `ToolMessage` 由 native stream 投影 | `forge-guardrails/middleware/tool-runtime-errors.ts` |
| Native tool retry | safety owner 已放行的 `web_read`、`web_search` handler failure | 成功返回最终 handler result；真正耗尽返回 `ToolMessage(status: error)` | 显式 predicate；abort、GraphBubbleUp 与 `retryable: false` 不重试 | `maxRetries: 2`、`backoffFactor: 1.5` | retry-safe failure 为 `failed_retryable`；下一 attempt 原子回到 `in_progress` | hard error 外抛，retry exhaustion 的 error ToolMessage 由 native projection | LangChain `toolRetryMiddleware` + `shouldRetryNetworkToolError/handleNetworkToolRetryFailure` |
| Roc effect idempotency | manifest effect policy、stable call ID/input hash、runtime checkpoint namespace/map/agent type | 首次执行返回并持久化 `ToolMessage`；成功 replay 反序列化同一 result；read-only tool 旁路 | 缺 identity fail closed；retry-safe -> `failed_retryable`；pre-effect resolution/error -> `failed_final`；不确定 manual effect -> `unknown` | 不调度 retry；只暴露可重试状态 | 唯一 ledger owner：run + execution path + checkpoint + call | ledger 是 durable audit/recovery 事实，native stream 继续拥有 tool event shape | `tool-effect-idempotency.ts` 与 `tool-effect-store.ts` |

结论：上述各层在 input/output/error/retry/effect/event 六维均有非重叠 owner；当前没有可由 Deep Agents 1.10.7 native middleware 完整替代的 Roc 层，因此 Stage 7.1 不删除 production middleware。

## Stage 7.2 Deep Agents 1.10.8

- 权威目标来自 `plan.md:647-664`：只审计并升级 1.10.8 core patch，为 `FilesystemBackend` / `LocalShellBackend` glob 增加 Windows junction/symlink loop 与 root containment 回归。
- 官方 1.10.8 release 只有 PR #668：在全部 `fast-glob` 调用关闭 directory symlink following，并保留 symlink-to-file 分类。
- 升级边界仅为 `deepagents` 1.10.7 -> 1.10.8 package key/specifier/integrity/snapshot；LangChain、LangGraph、langsmith、fast-glob resolution 均未变化。
- `deepagents` 对 `langsmith@^0.7.1` 的 peer warning 在 1.10.7/1.10.8 均存在，不是本次 patch 引入。
- Electron smoke 的两处合成 provider fixture 需要显式声明 128000 context window；production budget/default 不变。

## Stage 7.3 Versioned Stream Adapter

- 权威规格是 `plan.md:666-668`：集中 Deep Agents 1.10.x reflection 读取，以安装包真实 stream shape 作为 fixture；升级时只改 adapter/contract，projection 不再拥有 shape 猜测。
- Adapter 是单一当前版本 owner，不是通用兼容层；真实 fixture 固定 `streamEvents(..., { version: 'v3' })` 的 run/message/tool/subagent/output 形状。
- Adapter DTO 提供稳定字段：`trailingReasoning`、`finalAssistantText`、typed tool outcome；LangGraph 1.4.7 的 `interrupted`/`interrupts` 是消费期间更新的动态 getter，adapter 在读取时重新验证/映射。
- Promise-like 字段在 capture 时立即建立非拒绝 settlement，避免派生 Promise 未被观察产生 `unhandledRejection`；同步 contract validation 仍保留原字段错误优先级。
- Consumer/projection 不再直接读取 raw message output、final messages、tool output/status/error 或 subagent output。

## Stage 7.4 Performance Tuning Scope

`plan.md:670-678` 的五个候选都必须先由指标证明；没有指标、owner 不明确、隔离条件不可复用或无法等价验证时，记录 no-change。

| Candidate | Current evidence | Isolation / behavior boundary | Decision |
|---|---|---|---|
| per-run agent / RTK construction | `agent_build` P95 `17.2894ms` vs baseline `17.6593ms`；manager 复用不复用 rewriter | per-build middleware/safety owner | no-change |
| provider model instance reuse | 无 construction latency baseline | 每次 reload config、读取 secret，handle 绑定当次 provider/model/credential | no-change |
| repeated system/tool prompt cost | 只有运行中 cache token metrics，无稳定 artifact/baseline | prompt 内容与 provider input 必须保持不变 | no-change |
| canonical skill/capability + fingerprint | capability prompt 已排序；block hash + durable manifest hash 已存在 | manifest/explicit skill 保留 frozen request order | no-change |
| event delta merge window | queue P95 `0.2592ms`；1k/10k UI smoke passed，无 live-delta jank evidence | durable ordering、terminal flush、backpressure、transcript 完整性 | no-change |

## Closure Evidence

- Stage 0-7 全部完成；Stage 7.4 三份账本已独立提交为 `d5150a6`，不包含 `plan.md`。
- Agent artifact 最终值：`agent_build` P95 `17.2894ms`、`event_queue` P95 `0.2592ms`、`iterations_10` P95 `137.0611ms`，`pnpm smoke:agent-performance` 1 file / 1 test passed。
- UI artifact 最终值：1k/10k interactive `368.9942ms` / `343.1448ms`，DOM message rows 均 15，RSS `219.5MB` / `229.7MB`，10k prepend P95 `210.8861ms`，`pnpm smoke:performance` 1 file / 1 test passed。
- Broad gate 最终通过：`pnpm typecheck`、`pnpm check:ipc`、strict unused scan、`pnpm build`、full Vitest 322 files / 1804 tests、`git diff --check`。
- 当前没有 production/test/scripts 改动；后续新范围必须重新从 `plan.md` 评审。
