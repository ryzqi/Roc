# Roc Agent Harness 发现

> 职责：保存已确认技术事实、当前风险和可复用证据。规格见 `plan.md`，活动待办见 `task_plan.md`，时间线见 `progress.md`。

## Requirements

- 严格按 `plan.md` Stage 0-7 顺序执行。
- 每个 stage 完成实现、独立 review、修复、验证和独立提交。
- 当前工作树和新鲜验证优先于旧计划描述或历史过程记录。
- 最终 cleanup 只删除有直接证据证明无用的代码。

## Current Findings

### LangSmith Discovery

- `buildDeepAgent()` 只负责 Deep Agents model/backend/store/middleware/checkpointer 组装；per-run tracing 应从 executor 的 runnable invocation config 注入，不能成为第二套 agent/event 执行层。
- 当前 `AppSettings` 为 schema v2、settings document 为 schema v4，均无 observability/tracing 字段；若产品级 opt-in 进入 settings，必须使用现有 schema/migration 单一事实源，而不是旁路环境默认值。
- 当前 `AgentPluginOptions.deepAgentExecutor` 已是 main bootstrap 向 executor 注入运行时依赖的边界；具体 config/secret/app-version owner 仍需结合 bootstrap 与本机 LangSmith SDK 类型确认。
- Part 3 测试必须用 fake client/callback，不触发真实 LangSmith、provider 或外网。
- 本机固定依赖为 `langsmith 0.8.1`、`@langchain/core 1.2.2`、`deepagents 1.10.7`；executor 当前 runnable config 只有 stream events `version: 'v3'`、`run_id/thread_id` configurable 与 abort signal。
- `LangChainTracer` 原生接受显式 client、project、metadata 与 tags，并由 callback hierarchy 产生 graph/model/tool/subagent nested runs；无需复制 event log。
- LangSmith `Client` 原生提供 `hideInputs`、`hideOutputs`、`hideMetadata`、error anonymizer、`omitTracedRuntimeInfo` 和 `fetchImplementation`。Part 3 的可证明 redaction 策略固定为 inputs/outputs 全隐藏、metadata allowlist、error 全量替换、runtime info 省略。
- Electron `app.getVersion()` 已传入 main kernel bootstrap；app version 可沿现有依赖注入进入 executor，无需从 package 或环境重复读取。
- Kernel 已为每个 plugin 提供独立 `plugin_config` 与加密 `plugin_secrets` facade。LangSmith enabled/project 与 API key 由 Agent plugin 分别持有，避免扩展全局 `AppSettings`、复用 provider secret ID 或接受 ambient env 作为隐式事实源。
- Agent settings UI 可通过新增 Agent IPC 读取公开 tracing config、secret stored 状态并执行 save/set/clear；executor 在每次 run 从同一 plugin config/secret 读取，因此配置变更不需要重建 kernel。
- 当前 settings navigation 由 `SETTINGS_SECTIONS` 与 `SettingsView` active section 驱动；LangSmith 应作为独立“可观测性”section，不混入 provider 或 memory 表单。
- `plugin_config` 是 generic JSON store，不做 schema validation；Agent plugin 必须在 initialize/read/save 边界用 strict versioned schema parse，missing row 只初始化 explicit disabled default，corrupt/unknown config 明确失败。
- LangSmith config/secret 操作不进入全局 settings “保存全部”dirty model；独立 section 直接调用 Agent capabilities，避免 renderer 成为 config 或 secret 事实源。
- 现有 Agent capability 通过统一 plugin-capability adapter 映射到 shared IPC/preload；新增 get/save/set-secret/clear-secret 应沿用同一路径并运行 IPC generator/check。
- Roc run id 使用 `run_<uuid>`，不是 LangSmith 要求的裸 UUID；root trace 使用 SDK 生成的 UUID，并以 allowlist metadata 关联 Roc run/thread，不能把 Roc id 直接写入 RunnableConfig `runId`。
- LangChain callback handler 默认 `raiseError: false`，LangSmith `RunTree.postRun/patchRun` 也隔离 client 错误；Part 3 仍需用抛错 fake client 固定 exporter failure 不改变业务结果的回归证据。
- UI design-system 检索只采用可访问 label、明确 loading/error、focus 和响应式检查；视觉继续沿用 Roc 现有紧凑 settings tokens，不引入通用 dark/docs 主题。
- Backend Spec / Standards review 证明：只在 runnable config 中省略 `callbacks` 不能表达“默认关闭”；`@langchain/core` callback manager 会在 `LANGSMITH_TRACING_V2`、`LANGCHAIN_TRACING_V2`、`LANGSMITH_TRACING` 或 `LANGCHAIN_TRACING` 为 true 时自动创建 `LangChainTracer`，绕过 plugin config、显式 client 和 Roc redaction。
- 当前 runtime 对同一 durable run 会多次调用 executor：首次执行后，HITL resume 与 recovery retry 均可再次 invocation。若 tracing provider 每次 invocation 新建 tracer，则一个 Roc run 会形成多个 root trace；root tracing owner 必须跨这些 invocation 保持稳定。
- 真实调用点已确认：resume 会在 `runtime.ts` 先调用 executor 取得 stream，再把该 stream交给 `executeRun`；recovery loop 会在 `executeDeepAgentRun` 内再次调用 executor。三条路径都沿用同一个 `TaskRun.id` 和 frozen snapshot，可作为 root trace 生命周期的稳定 key。
- Exporter failure regression 必须经过真实 Runnable / callback lifecycle 并精确断言业务返回值不变；只断言 handler promise resolve 或只检查 mock config 都不足以证明边界。
- 固定依赖提供正式的 per-async-context 控制：`langsmith/singletons/traceable.withRunTree` 使用 AsyncLocalStorage 传播 root；LangChain callback manager 会读取当前 context 的 `tracingEnabled` 和 root id。enabled 可将各次 runnable invocation 挂到同一显式 SDK `RunTree`，disabled 可用 `tracingEnabled: false` context 压制 ambient tracer，避免修改进程级环境变量。
- Runtime 的 `emitSessionEnd` 仅在 durable run 的 `completed`、`failed`、`cancelled` 分支触发；`waiting_user` interrupt 不触发。可复用这一既有 terminal boundary 最终 PATCH LangSmith root，而不把单次 executor invocation 或 HITL 暂停误判为整个 run 终态。
- 当前修复使用 run-scoped manager：同进程首次执行、HITL resume 和 recovery retry 按 `runId` 复用一个 SDK `RunTree`；各 runnable invocation 作为它的原生 child，terminal `emitSessionEnd` 最终 PATCH root。Spec review 已确认进程重启丢失 root 是 High blocker：`waiting_user` 可恢复，因此同一 Roc run 不能创建第二个 root。
- `Client.omitTracedRuntimeInfo` 只控制 client 追加的 runtime info；SDK `RunTree.postRun()` 会先把 `extra.runtime` 写入 manual root payload。必须在 manual root export boundary 显式删除该字段，并通过实际 POST payload 测试证明。
- Exporter failure boundary 不能只覆盖 `LangChainTracer` child callback；manual root 的初始 POST 与 terminal PATCH 也必须在 fake exporter 抛错时不改变 durable run 业务结果。
- `resolveLifecycleHooks` 同时承担外部 hook notification 与 tracing terminal ownership，导致 cancel fire-and-forget、shutdown 不等待，且 `finishRun` 失败时不删除含 Client/API key 的 Map entry。Tracing 必须成为独立 lifecycle owner，并在 terminal/shutdown 明确释放进程内状态。
- 最新 Risk review 调用链确认：durable trace-session 合同只保存 root identity、project、app version 与 Roc correlation，不保存 API key；API key 仅进入进程内 LangSmith client，terminal `finally` 与 runtime shutdown 负责释放 manager 引用。
- 最新 runtime 调用链确认：cancel 只等待独立 tracing cleanup，随后仍以 fire-and-forget 方式发送 `SessionEnd` notification；shutdown 先等待 pending runs，再清空 tracing manager。repository strictness、migration/retention/history deletion 仍在本轮 Risk review 中继续核对。
- 最终 Spec review 新 finding：`AgentSessionRepository.reconcileStartupRuns()` 返回已终态化的 `interrupted` runs，但 Agent plugin initialize 丢弃返回值；当前 tracing terminal union 也不接受 `interrupted`，因此 startup quarantine 可留下未结束 root 与 durable session。
- 最终 Standards review 待独立复现的边界：LangChain `serialized` payload 可能绕过现有 redaction；`finishRun()` 的 session read 位于 cleanup `try/finally` 外；manager `shutdown()` 未显式等待 client auto-batch queue。
- 上述 Standards findings 已独立复现：出站 POST 原样保留 `serialized.kwargs` 中的 Authorization 与本地路径；session read failure 时 `Client.cleanup()` 未调用且 durable session 未删除；manager shutdown 未调用固定 SDK 的 `awaitPendingTraceBatches()`。
- `langsmith@0.8.1` 的 `Client.awaitPendingTraceBatches()` 会等待 pending drains、auto-batch item promises、batch ingest queue idle，并 force-flush OTEL；当前非 manual flush 配置可直接使用该公开 API，随后调用 `Client.cleanup()` 释放 client 资源。
- Review-fix 后 cleanup 顺序已核对：manager 先移除 Map 引用，tracing shutdown 以单一 promise 等待 batch 并在 `finally` 调用 client cleanup，外层 `finally` 再删除 durable session；任一 exporter/drain 失败不会跳过本地 session 删除。
- Risk review 确认：同一 run 已持有 client 时若用户关闭 tracing，下一次 `getRunTracing()` 直接删除 Map entry 而未调用 client cleanup；resume/retry 会触发该路径。durable session 应保留到终态，但旧 client 必须同步 dispose 并从 manager 释放。
- 配置关闭 lifecycle 已修复为同步 idempotent dispose：旧 client 立即 `cleanup()` 并移出 manager，durable session 保留到 terminal；若随后 re-enable，仍从同一 persisted root identity 重建。
- Risk review 确认 settings owner 严格：missing config 只初始化 explicit disabled default，corrupt/unknown config fail closed；enabled save 必须已有非空 secret，clear secret 必须先 disabled。
- Risk review 确认 executor tracing context 覆盖 `streamEvents()` 创建和 async iterable 的完整消费；model/tool/subagent callback 不会在迭代阶段脱离 root，disabled context 也覆盖同一异步执行边界。
- Risk review 尚余低概率性能问题：startup interrupted traces 当前逐条等待 finish，需在最终复审中判断罕见 crash cleanup 的确定性是否优先于批量启动延迟。
- 最新 Standards 复审除 `src/main/plugins/agent/index.ts` 的一个未使用 type import 外无 residual finding；focused 4 files / 37 tests、普通 typecheck 与 diff check 通过，strict unused 仅以该 import 的 TS6196 失败。
- Durable crash window 已定位：run terminal transaction 先于 `finishTracingBestEffort()` 提交；`AgentSessionRepository.reconcileStartupRuns()` 的查询只包含 `waiting_next_turn`、`dispatch_pending`、`running`、`recovering`、`waiting_user`。进程若在二者之间退出，下一次启动不会扫描已终态 run 对应的残留 trace session。
- `AgentLangSmithTraceSessionRepository` 当前只有 `create/get/delete`；Agent plugin initialize 只遍历本次 `reconcileStartupRuns()` 返回的 interrupted runs。最小修复边界是 repository 查询“有 trace session 的终态 run”，由 tracing manager 继续持有远端 finish/client cleanup/local delete 语义；不把外部 tracing side effect 塞进 run state repository。
- Crash-window 修复后 repository 只枚举 `cancelled/completed/failed/interrupted` 四种 tracing terminal 状态；initialize 在 run startup reconciliation 之后查询，因此既覆盖本次新转为 interrupted 的 run，也覆盖此前已终态但未 cleanup 的 session。`waiting_user` regression 证明非终态 session 保留。
- 最终 Spec 复审未发现 backend 行为错误或 scope creep；UI 数据外发/retention 提示仍按计划属于下一独立 renderer part，不阻断 backend commit。最终本地 Risk review 无新 finding；残余风险仅为多个 crash residue 串行 drain 可能放大 critical startup 延迟。
- Standards 指出的测试证据缺口已补：repository parameterized matrix 精确覆盖 `cancelled/completed/failed/interrupted`；plugin enabled fixture 证明 persisted failed root 执行 POST/PATCH、使用 `agent_run_failed_before_trace_cleanup` 且 waiting session 保留。最终出站 error redaction 继续由 fake-fetch regression 独立证明。
- Part 3 backend 已在最终 15 files / 124 tests、strict unused、typecheck、IPC check、diff check 通过且 Standards / Spec / Risk 无 residual finding 后独立提交为 `012c870 feat(agent): add opt-in LangSmith tracing`；UI review baseline 从该提交开始。
- UI 校准继续使用现有 Roc settings sidebar、紧凑 tokens 与表单密度；只采用 visible labels、键盘 focus、`aria-live`/`role="alert"`、async loading/disabled/success 和响应式无横向溢出要求，不采用外部设计查询返回的 landing、dark-only、glow、装饰卡片或外部字体方向。
- CodeGraph 已确认 LangSmith config/secret 不属于 `useSettingsDraft` / `SettingsSaveRequest` 的全局保存模型；renderer 应由独立 section 直接调用生成的 Agent capability client，并只保留公开 config 与 `apiKeyStored` 状态。
- 可观测性 UI 已沿统一 plugin capability adapter 增加四条显式 IPC；preload 与 renderer 只接收 strict `AgentLangSmithSettings`，其 output schema 不含 API key 明文。
- UI review 已关闭两个 Medium：清 key 同时约束 persisted/draft enabled，enabled config 保存再次检查 stored key；独立 section 不再遮蔽其他 section 的全局 dirty count 与保存入口。
- 响应式 smoke fixture 已对齐真实 settings header，并在 320px 与 1280px 同时验证 page actions、表单、输入和 key actions 无横向溢出或重叠。
- Part 3 backend 的 v13 migration 曾留下一个 kernel integration v12 期望；full Vitest 稳定暴露后已把唯一显式版本锚点同步为 13，focused 与 full suite 均转绿。

### Agent Integration Mode Discovery

- 当前 `package.json` 只有默认 `vitest run`；`vitest.config.ts` include 为 `tests/**/*.test.ts(x)`，会同时匹配 `*.int.test.ts`，因此独立 mode 必须同时增加专用 config/script 和默认 config 的显式 exclude。
- 仓库已有若干文件名含 `integration` 的默认-suite 测试，但 `core-plugins.integration.test.ts` 通过 static `AgentDeepAgentExecutor` 产生结果，不执行真实 Deep Agents runnable，不能满足 Stage 6 integration gate。
- Part 4 的单一路径固定为 `tests/integration/agent/**/*.int.test.ts` + 独立 Vitest config；离线 case 使用 deterministic chat model 实际调用 Roc `buildDeepAgent()`，live provider case 只在显式凭据存在时运行。
- “无 key”不能让整个 integration command 空跑：离线真实 harness case 必须始终执行；仅 live provider case 明确 skipped，且默认/full Vitest 必须证明专用目录未被收集。
- `langchain` 已提供 `FakeToolCallingModel`；现有 native summarization route test 证明它可驱动真实 `buildDeepAgent()`、subagent 和 `RocSqliteCheckpointer`，无需为 integration mode 自建假的 runnable 协议。
- 现有真实 route case 专注 summarization/subagent conformance且仍在默认 suite；Part 4 新 case 应保持更小，只证明 native `write_todos` trajectory、结构化 terminal message 与 SQLite checkpoint，避免复制上下文压缩断言或扩展一次性 manifest。
- 仓库没有既有 live-provider test env 约定；为避免 ambient key 触发付费调用，live case 仅在 `ROC_AGENT_INTEGRATION_LIVE=1` 时启用，启用后缺 `ANTHROPIC_API_KEY` 明确失败，默认状态由 Vitest 报告 skipped。
- 离线 direct-builder invocation 必须显式压制 ambient LangSmith tracing，确保普通 CI 即使继承 tracing 环境变量也不会产生外发。
- `FakeToolCallingModel` 按调用序列返回真实 `AIMessage.tool_calls`，最终无 tool call 的 message 可作为稳定 terminal 结构；无需自建 BaseChatModel 或锁死自然语言文案。
- Direct `agent.invoke` 在 ambient tracing 为 true 时，即使用 `runWithLangSmithTracing(null, ...)` 包裹仍会由 nested harness 产生一次 LangSmith `/info` 探测；这不等同于生产 `streamEvents` 路径回归。专用 offline process 必须显式把 `LANGSMITH_TRACING(_V2)` 与 `LANGCHAIN_TRACING(_V2)` 全部设为 `false`、清空 ambient key，并用拒绝任何 fetch 的断言证明零外发。
- Deep Agents 原生 `write_todos` 返回 `Command`，同时写入 `todos` state 与带同一 `tool_call_id` 的 `ToolMessage`；latest Roc checkpoint 可回读两者，适合作为稳定 trajectory/state contract。
- Local Risk review 发现同一 ambient tracing 边界也适用于可选 live case；否则继承 LangSmith env/key 的手动运行可能在 Anthropic 调用之外产生未声明外发。offline/live 现共用 isolation helper，同时清除新旧 tracing flag 与 `LANGSMITH_API_KEY`/`LANGCHAIN_API_KEY`；offline regression 先模拟启用状态再证明零 fetch。
- Part 4 初次 Spec review 无 finding；Standards 仅发现账本状态与 live skip/fail 分支陈述过期，已按当前实现修正。review-fix focused 验证为 config 3/3、integration 1 passed / 1 skipped、typecheck 与 strict unused 通过；live opt-in 缺 key 在 4ms 内明确失败。
- Part 4 最终 Standards / Spec / Risk review 无 residual finding；broad gate 为 build、IPC check、默认 Vitest 315 files / 1724 tests 与 diff check 通过。真实 Anthropic live turn 因未提供凭据未运行；其默认 skipped 与 opt-in missing-key failure 边界已验证。

### Deterministic Agent Eval Discovery

- Part 5 baseline 为 `da0eb8d`；repo 当前无 `eval:agent`、eval config、versioned dataset 或 `tests/evals/` 路径，默认 Vitest 也尚未排除该目录。
- `agent-development` 的 eval ladder 要求 scenario eval 对 versioned dataset 分开评分 task outcome 与 critical trajectory；本 Part 不用 unit test 名称冒充 eval，也不接外部 LangSmith dataset/judge。
- Part 4 已提供真实 `buildDeepAgent()`、`RocSqliteCheckpointer`、offline tracing isolation 与 trajectory extraction 的可复用形状；Part 5 保持 test-only，不改生产 harness。
- 初始 corpus 只冻结两个高信号 case：native `write_todos` 成功并持久化 todos；Plan Mode 即使 fake model 产生隐藏的 `write_file` call，也必须返回 error tool result 且不产生 file side effect。
- runner 只接受显式 `--mode deterministic`，missing/unknown mode fail closed；live/judge mode 与其 provider/cost/variance contract 留给后续独立 part，不增加空实现或静默 alias。
- Config/CLI 红灯为既有 integration 合同 3 passed、新 eval 合同 5 expected failures；失败分别落在缺 script、缺 default exclude、缺 dedicated config，以及 missing/unsupported mode 尚无结构错误码。
- Scenario 红灯在 0 case 执行前精确失败于缺失 `deterministic-trajectory.v1.json`，证明 dataset 是显式执行输入；尚未用实现后轨迹反推样例。
- 实际 `pnpm eval:agent -- --mode deterministic` 会把一个前导 `--` 传给 Node script；runner 只规范化这一种 package-manager separator，missing/unsupported/extra args 继续 fail closed。
- 固定 `@langchain/core 1.2.2` 的 `ToolMessage.status` 是 optional：native success result 省略 status，Plan Mode guard error 显式为 `error`。eval adapter 明确把 `undefined` 规范化为 `success`，不对其他未知值兜底。
- Runner 通过当前 Node 直接启动安装包公开 `vitest.mjs` bin，避免 Windows `shell: true` 参数拼接和 Node 25 `DEP0190` 警告。
- Focused green：deterministic dataset/schema/scenarios 1 file / 5 tests、config/CLI 2 files / 8 tests、Part 4 integration 1 passed / 1 skipped、typecheck 与 strict unused 均通过；生产代码无 diff。
- 最终 Spec review 无 finding；Standards 仅发现 `progress.md` 顶部 HEAD/阶段陈述过期，已同步当前 baseline 与验证状态。
- 本地 Risk review 未发现新增行为 finding；runner 相对 config 路径符合 package script 从仓库根执行的合同，Plan Mode case 同时在返回 state 与 SQLite checkpoint 证明无 file side effect，ambient tracing/key 与 fetch 均被显式隔离。
- Broad 首轮与 build 并行的 full Vitest 有两个未改动测试超时；两个文件独占重跑全绿，随后 full suite 独占重跑 316 files / 1729 tests 全绿。该失败归因为并行资源竞争，不需要修改生产或测试 timeout。
- Part 5 最终 Standards / Spec / Risk 无未处理 finding；IPC check、build、default full suite 与 diff check 全部通过。

### Live Agent Quality Eval Discovery

- Part 6 最终 review baseline 为 `332048d`；实现起点为 `298b2da`，期间既有 multiple-interrupt integration 的等待预算修复已独立提交。现有 runner 原只接受 `deterministic`，专用 config 只收集 `tests/evals/agent/**/*.eval.test.ts`，因此 live suite 使用不重叠的目录/config。
- Part 4 已有固定 `ChatAnthropic` + `buildDeepAgent()` + `RocSqliteCheckpointer` 的真实 provider 路径；Part 6 复用该执行边界，不另建 agent 协议或生产 runtime。
- `plan.md` 要求 live/judge 仅 manual/nightly；显式 `--mode live` 本身作为 opt-in，缺 `ANTHROPIC_API_KEY` 必须在 runner 启动 Vitest 前明确失败。
- LLM judge 只评 response quality；terminal、trajectory、todos/files 与 checkpoint 仍由确定性断言拥有，避免高分掩盖错误工具或副作用。
- 当前环境 `ANTHROPIC_API_KEY` 不存在；真实 provider turn 本轮只能标记 `Blocked, not run`，不能作为完成证据。
- 最小 corpus 固定一个无工具质量 case；agent/judge 使用 bounded token、零 retry、deadline，并显式关闭 ambient LangSmith。网络边界只允许 Anthropic HTTPS default port 且拒绝自动 redirect。
- CLI/config 红灯为 1 file / 7 tests 中 5 passed、2 expected failures：live config 无法解析；`--mode live` 在空 key 下仍报 `agent_eval_mode_unsupported:live`。失败均发生在 Vitest/live network 前。
- Live suite 红灯在 0 test 执行前精确失败为缺少 `datasets/live-quality.v1.json`；证明 versioned dataset 是显式输入，且无 key 环境未进入 provider 或 judge network。
- Egress review 前的初始 live contract green：1 file / 6 passed / 1 live skipped；strict v1 schema、case uniqueness、quality result parsing 与 non-Anthropic hostname rejection 均实际执行，typecheck 通过。
- 共享 eval helper 抽取前后 deterministic suite 均为 5/5；Part 5 的 builder/checkpointer、terminal、trajectory 与 state 语义保持等价。
- Local Risk review 发现 hostname-only egress guard 会允许 `api.anthropic.com:8443`，且底层 fetch 仍可自动跨域 redirect；两条红测稳定复现。
- Egress guard 现要求 Anthropic HTTPS default port，并强制 `redirect: 'error'`；review-fix green 为 1 file / 8 passed / 1 live skipped，typecheck 通过。
- Part 6 当前本地结论以 review-fix 后的 8 passed / 1 live skipped 为准；6 passed / 1 skipped 仅是发现 egress 缺口前的历史证据。
- 最终 Standards / Spec review 无 finding，本地 Risk review 的端口与 redirect finding 已红绿关闭；config/CLI 10/10、deterministic 5/5、integration 1 passed / 1 skipped、typecheck 与 strict unused 均通过。
- Part 6 broad gate 的 `pnpm check:ipc`、`pnpm build`、默认 `pnpm test` 316 files / 1731 tests 与 `git diff --check` 均通过；既有 multiple-interrupt timeout 已在独立 `332048d` 中稳定化并完成双轴 review。
- 当前环境无 `ANTHROPIC_API_KEY`；真实 Anthropic agent turn、structured-output judge 与最低质量分仍为 `Blocked, not run`。本地合同为 **Verified passing**，Part 6 included in current commit。

### Agent Performance Gate Discovery

- Part 7 baseline 为 `2ea75fe`；`plan.md` 要求独立 `smoke:agent-performance`，不得用现有 UI/transcript smoke 代替真实 agent loop 证据。
- 初始测量面固定为 build、first model token/tool、tool roundtrip、simple completion、restart resume、10/100 iterations、subagent fan-out 与 event queue/outbox lag；实现 owner 与最低重复次数待从当前代码/脚本定位。
- artifact 必须同时记录运行环境、raw samples、阈值与判定；阈值先采本机 baseline，再冻结回归比例与绝对上限，不凭空填写。
- 本 Part 使用 deterministic local fixture，不引入 provider key、网络成本、UI performance 语义变更或生产 runtime 重构。
- 现有 `tests/smoke/performance-smoke.mjs` 启动 Electron，测 renderer readiness、transcript 1k/10k interaction、DOM rows、prepend P95 与进程内存，写 `performance-smoke.json`；它是 UI/transcript 证据，不能承载 agent loop 指标。
- 现有 UI smoke 直接在脚本内断言绝对预算，artifact 无本 Part 所需的 versioned metric/threshold/raw-sample schema；Agent smoke 应使用独立文件与 contract test，避免改变既有 artifact consumer。
- `buildDeepAgent()` 是真实 Roc harness 的同步组装入口，内部配置 middleware、tools、compiled subagents 与 checkpointer；可直接测 build，并用 deterministic model 驱动后续 loop，不需要生产 instrumentation。
- Roc declarative subagents 在同一 builder 内经 `createSubAgent()` 编译为 runnable；fan-out fixture 可复用该真实路径，具体 invocation trajectory 仍需从现有 tests 定位。
- 现有 artifact helper 只创建 `.artifacts/wave1`，不会清空目录；Agent smoke 可写独立 `agent-performance-smoke.json`，不覆盖 `performance-smoke.json` 或 Electron artifact。
- `FakeToolCallingModel` 的 tool-call index 在 `bindTools()` 实例间共享，并按提供序列推进；给定 N 组 tool calls 加一个 terminal 空组即可确定性驱动 N 轮，配合显式 model/tool call limits 与 recursion limit 覆盖 10/100 iterations。
- LangChain agent v3 `streamEvents()` 返回独立 `messages`、`toolCalls` 与 `output` stream；Roc executor 已并发消费这些 owner。性能 smoke 可在同一路径记录首个 model message chunk、首个 tool call、其 output promise 与最终 output，无需加入生产计时 hook。
- `createChatRunEventQueue()` 暴露 `stats().highWaterMark`；可用真实 queue 测 production event enqueue/drain。Outbox 可用 in-memory Agent/Task schema、`AgentTaskHistoryReader.listOutboxEventsAfter()` 与 `TaskRepository.projectAgentOutboxEvents()` 测真实 cursor projection。
- 现有 `native-summarization-route.integration.test.ts` 证明 `task` tool 经真实 compiled declarative subagent runnable 完成并写 checkpoint；fan-out smoke 可为 main/subagents使用独立 deterministic model，避免共享序列并发漂移。
- 固定 `FakeToolCallingModel` 会把完整历史 content 拼入下一响应；100 轮时会扩大 payload 与 fake 自身成本。性能 fixture 改用最小 `RocPerformanceFakeModel`：绑定 tools 时共享严格递增 sequence，intermediate content 为空，terminal content 固定，并显式发出 token callback。
- 10/100 iteration 使用 manifest 允许的本地 `performance_step` tool，并以 tool 实际执行计数断言轮数；不依赖最终 message history 保留全部旧 ToolMessage，也不通过样例特判绕过真实 middleware/tool node。
- v3 `run.messages`、`run.toolCalls`、`run.subagents` 与 `run.output` 可并发消费；first token、first tool、tool output 和 total completion 由各自 native projection 计时，避免加入生产 instrumentation。
- Restart fixture 使用 file-backed Agent DB：首轮完成后关闭连接，重新打开同一路径、重建 `RocSqliteCheckpointer` 和 agent，并以同一 `thread_id` 验证第二个 model invocation 看到首轮 marker。
- Queue fixture 使用非 coalescible `run_started` events，断言 drain count 与 `highWaterMark`；outbox fixture 使用真实 Agent/Task schema、连续 `run_deleted` rows、history reader 和 repository cursor，断言 event count/applied count/last sequence 一致。
- `createChatRunEventQueue()` 对非 coalescible event 同步入队并按当前队列长度更新 `highWaterMark`；先完整 push、再 close/drain 可稳定断言 high-water 等于 event count，drain 后 `queuedEventCount` 为 0。
- `TaskRepository.projectAgentOutboxEvents()` 对无 background task 的 `run_deleted` 仍按连续 sequence 推进 cursor；因此 outbox smoke 无需伪造额外 task 状态，只需真实双 DB schema、连续 rows、reader、projector 与 cursor 一致性断言。
- 当前 artifact contract 的 evidence 只有 iteration/outbox/queue/subagent 四项，且 fixture model 仍锁为 `FakeToolCallingModel`；完整 harness 前必须补 checkpoint/recovered/model/tool 等可审计 evidence，并改为实际使用的 `RocPerformanceFakeModel` literal。
- Contract 增量 review：仅要求 evidence 字段存在仍允许成功 metric 全部填 `null`；strict artifact 需要按 metric 校验可审计语义，iteration 固定精确 model/tool 次数，restart 必须证明 checkpoint 与 prior turn recovery，fan-out/queue/outbox 必须证明各自业务结果。
- Restart 根因已确认：两个重建的 fake model 都生成 `roc-performance-message-1`；LangGraph `messagesStateReducer` 对重复 ID 原位替换，导致第二轮 AI 留在首轮 AI 的数组位置、新 Human 反而位于末尾。fixture 不再伪造 provider message ID，由正式 reducer 为无 ID message 生成唯一 ID，严格 terminal 断言保持不变。
- Restart 修复后 smoke 已推进到 `iterations_10`；该场景按 `iterationCount * 4 + 20` 得到 recursion limit 60，但真实 Roc middleware graph 在 10 次 model-tool 循环终止前耗尽该预算。需先定位生产 recursion-limit owner 或测量 checkpoint step，再冻结有依据的测试预算。
- 生产 `deep-agent-executor` 调用 `streamEvents()` 时不传 `recursionLimit`；业务终止 owner 是 snapshot 中的 model/tool run/thread limits。performance smoke 的 `4N + 20` 因而只是测试私有假设，不能声称复用了生产公式；应由实际 graph step 测量加明确余量支撑。
- `iterations_10` 在 limit 60 时已完成 6 次 model、6 次 tool 并写入 62 个 checkpoint，实测约每轮 10 graph steps。smoke 改用每个预期 model invocation 12 steps 加固定 20 steps headroom；model/tool middleware limits 与精确计数仍是 runaway 和正确性 owner。
- 调整 iteration graph budget 后 smoke 已越过 10/100 iterations，并在三路 subagent fan-out 暴露 `InvalidUpdateError`：三个 subagent 同一 step 同时写 `threadModelCallCount` 的 `LastValue` channel。该问题可能属于生产 safety middleware 与并发 subagent 的真实合同冲突，不能把性能 fixture 串行化绕过。
- 安装的 LangChain 1.5.3 `modelCallLimitMiddleware` 用普通 Zod number 声明 `threadModelCallCount`，`afterModel` 返回当前值加一，没有并发 reducer；Roc 又把该 middleware 注入每个 compiled subagent，因此三个分支合流时产生三个 `LastValue` 写入。正确修复仍需对照现有跨 subagent budget 合同。
- `plan.md` Stage 4 要求 native model/tool limits 覆盖 main 与 subagent、G4 禁止只靠 recursionLimit；现有 wiring/scope tests 仅断言 middleware 名称出现在两类 stack，没有并发 fan-out 或 aggregate count 行为。规格未要求把多个 subagent 的 thread count 合并回 parent，只要求每个 execution scope 有可查询的同类 budget 规则。
- Stage 4 `031baea` 的原意是直接复用 native persisted counters：每个 stack 同时装 run/thread limits，错误映射为不可恢复 `run_budget_exhausted`；当时只做 wiring、snapshot 与 terminal mapping regression，没有并发 subagent 行为测试或 Roc 聚合 counter。
- LangChain `createSubagentTransformer` 只按 namespace 投影 nested stream 并在 lifecycle failure 时 reject `output`；它不合并 graph state，因此 smoke 的 unhandled `Subagent ... failed` 是根 `InvalidUpdateError` 的次生投影，不是 counter 冲突 owner。
- Deep Agents 1.10.7 `task` tool 对 parent input 与 subagent result 都调用同一个 `filterStateForSubagent()`，仅排除 messages/todos/structuredResponse/skills/memory；四个 native budget counter 会被传入分支并由 `Command.update` 原样合回 parent。并发分支返回绝对 counter，最终触发同 channel 多写。
- LangChain agent state schema 采用 first-key-wins，可用更早 middleware 改 counter channel reducer；但 native limiter 写绝对 count 并用绝对 0 reset，普通 sum/max reducer无法同时保持顺序、并行与 reset 语义。正确的较小边界是拦截 parent `task` tool 返回的 `Command.update`，只移除 subagent 私有的四个 native budget counters，保留子图内 native enforcement。
- LangChain `wrapToolCall` 合同允许 `ToolMessage | Command`，handler chain 外层可检查结果；`Command` 暴露 graph/update/resume/goto 并可重建。因此 Roc 可在 main-scope task boundary 无损过滤 counter keys，不改 Deep Agents、LangGraph reducer 或 subagent execution。
- 现有 `native-summarization-route.integration.test.ts` 已通过真实 `buildDeepAgent()`、compiled declarative subagent、`task` tool 与 Roc SQLite checkpointer 覆盖单分支路径；最小并发回归可复用该 fixture 扩成三个独立 subagent model，并断言三条分支均实际执行。
- 隔离 middleware 必须只加入 main agent guardrail，用来过滤 `task` 返回 parent 的 state；若把它加入 subagent safety stack，会在 subagent 内部工具边界剥掉 counter，削弱 native model/tool limit 的持久计数语义。
- performance smoke 的 fan-out fixture 已稳定形成一个 main model 同轮发出三个 `task` call、三个独立 subagent model 各执行一次的真实复现；默认 Vitest 应复用同一行为合同，但不依赖 performance 专用 config 或阈值 artifact。
- 当前 pnpm package target 的默认 `rg --files` 只枚举顶层 metadata，安装包实现需从各自 `package.json` exports 解析精确 `dist` 路径读取，不能把默认无匹配误判为 API 不存在。
- Deep Agents 1.10.7 的 `returnCommandWithStateUpdate()` 先把过滤后的 subagent result 全量展开进对象型 `Command.update`，再仅覆盖 `messages` 为 parent `task` 的 `ToolMessage`；因此 main `wrapToolCall` 能在不碰 subagent invocation 的位置精确删除四个 budget key。
- 当前 `@langchain/langgraph` 公共 `Command` 暴露 `graph`、`update`、`resume`、`goto`，公共入口同时导出 `isCommand`；重建过滤后的 command 不依赖私有字段或 bundle 路径。
- native model limiter 的 `afterAgent` 把 `runModelCallCount` 重置为 0、保留 thread count；tool limiter 同样把 run map 重置为空、保留 thread map。该绝对值/reset 合同进一步排除 sum/max reducer，边界过滤是唯一不改变 limiter 语义的最小路径。
- 现有 `execution-safety-scopes.test.ts` 验证 main/subagent 大部分 safety middleware，却没有把两个 native limiter 名称纳入共享期望；本次回归应补上这两个名称，并单独断言 state isolation 只在 main stack。
- 新增默认 Vitest 在 168ms 内稳定复现三路真实 `task` fan-out 的 `threadModelCallCount=[2,2,2]` 与 `INVALID_CONCURRENT_GRAPH_UPDATE`；fixture 本身没有先行类型、checkpointer 或 recursion-limit 故障，红灯边界与生产根因一致。
- main-only state isolation 修复后同一真实三路 fixture 在 166ms 内通过，三个 subagent model 均执行一次、三条 parent `ToolMessage` 均返回；单元合同同时证明四个 counter 被删除而 messages、自定义 evidence 与 `graph/goto/resume` 保留。
- 完整 performance smoke 修复后 1 file / 1 test passed，首次总耗时 8.92s；restart、10/100 iterations、fan-out、queue 与 outbox 场景全部产生有效 evidence。
- 同机 Windows x64 / Node v25.7.0 / 20 CPU 连续采样 5 轮，每项共 15 个 raw samples；观测最大值约为 build 17.78ms、first token 43.78ms、first tool 22.63ms、roundtrip 0.159ms、completion 66.09ms、restart 115.72ms、10 iterations 157.72ms、100 iterations 2198.92ms、fan-out 62.04ms、queue 0.342ms、outbox 7.13ms。
- 冻结门槛将按 baseline 最大/P95 使用 1.75-2 倍 agent-loop 回归比例；亚毫秒 roundtrip/queue 使用 5 倍避免计时器噪声误报。每项另设更宽但有限的整数 absolute max，防止未来因 baseline 重采而无限放宽。
- 本地 Risk review 发现 strict artifact parser 只校验字段形状，未重算 P95、relative max、ratio、failed limits 与 metric pass；篡改派生字段仍被接受。稳定红测后，parser 改为从 raw samples 重建期望结果逐项核对，并要求所有 failure artifact 都有非空 error。
- Review-fix 后一次完整 smoke 正确产出 failure artifact：fan-out 为 2.07x relative breach，但仍低于 180ms absolute max；同轮 iteration-100 为 1.58x、outbox 为 2.00x，说明负载影响不是单一 fan-out 代码路径。需在 review 结论后决定是否用更多 stressed samples/统一 headroom 调整，不能只为本次结果放宽单项。
- Standards review 提出 parent 不再累计 subagent 四个 native counter 可能允许多个分支分别使用完整预算；该结论与当前 Stage 4 记录的 per-scope native limit 合同存在解释冲突，需以 `plan.md`、原始 budget 提交和真实 task state flow 判定，不能直接把绝对 counter 合回 parent。
- Standards review 确认 baseline/current artifact 虽各自记录 environment，parser 尚未比较 OS、arch、Node 与 CPU；跨环境仍会套用本机相对门，可能产生无意义的 pass/fail。最小修复应在执行前 fail closed，或证明环境字段中哪些构成兼容 identity。
- Part 7 账本曾滞后于已完成的 fan-out 修复、完整 smoke 与五轮校准；本轮已把 `task_plan.md` 当前步骤切换为 review-fix 与 broad gate。
- 安装包 `modelCallLimitMiddleware` 明确定义 `runLimit` 为单次 agent invocation，并在 `afterAgent` 把 run counter 重置为 0；Stage 4 同时要求 main/subagent 各自安装 native limit，并写明 Roc 另补 per-scope policy。由此不能把多个 subagent 的绝对 run counter 当作一个 Roc 全局 run counter 聚合。
- 当前 state isolation 只过滤 subagent 返回 parent 的 counter，却仍把 parent counter 随 `task` request state 传入 subagent；低预算测试的第一次 subagent 调用其实从 parent count 1 起步，因此不能证明 subagent 自身 limit。最小一致修复是 task 边界双向过滤四个 native counter，再让 subagent 从 0 独立计数，并证明第三次 model call 被 limit 阻止。
- Spec review 另指出当前 `event_queue` / `outbox_projection` 记录的是批处理执行耗时，未把“事件进入队列/创建 outbox row 到消费/投影完成”作为显式 lag 起点；需改为 end-to-end lag measurement 并重采相关 baseline。
- Spec review 确认 performance harness 仍传 `workspacePath: null`；按当前验收应创建临时 workspace、传入真实路径并在 `finally` 清理，计时区间不应包含临时目录创建。
- Review-fix 后首轮独占 smoke 仅 `subagent_fan_out` 与 `outbox_projection` breach：fan-out P95 119.80ms / 1.93x，outbox P95 16.82ms / 2.36x；两者仍分别低于既有 180ms / 30ms absolute max。前者路径新增 subagent budget initialization graph node，后者已改为包含 row 创建的端到端 lag，因此旧 baseline 不再代表当前被测行为，应重采 samples 而不是放宽门。
- 同轮 artifact 记录完整 CPU model、fixture、Git revision 与 `worktreeDirty: true`；临时 workspace 残留数为 0，证明 cleanup `finally` 生效。
- 变更后重新串行采样五轮，每项 15 个 raw samples；fan-out 最大 131.98ms、outbox end-to-end lag 最大 18.57ms，均保留原 180ms / 30ms absolute max 和原 regression ratio。
- 校准后的独占 smoke 11 项全部通过；最高 observed ratio 为 first tool call 0.987，fan-out 为 0.952，100 iterations 为 0.936；artifact `error: null`、`worktreeDirty: true`，临时 workspace 仍为 0 残留。
- Native budget 的权威语义已按 execution scope 关闭：subagent 启动时四个原生 model/tool run/thread counter 归零，nested `task` 返回时过滤同四项，parent 与 sibling 不聚合绝对 counter；三路 fan-out、每个 subagent 独立 model/tool limit、Command routing/state 保真及 main/subagent wiring 均有直接测试，最终 Standards 与 Spec 复审无 finding。
- Strict artifact parser 现要求 threshold failure 的 `agent_performance_threshold_breached:<ids>` 与实际 `passed:false` metric ID 精确同序一致；execution failure 仍允许 partial metrics，避免把 setup/runtime error 误报成 threshold breach。
- `buildAgentPerformanceArtifact()` 已成为成功、network fetch failure 与 threshold failure 的单一总结入口：unexpected fetch 优先，其次按失败 metrics 生成唯一 threshold summary，只有无 fetch 且所有 metrics 通过时才返回 `passed:true`。
- 最新 smoke orchestration 已改为运行开始先删除旧 artifact、在 test 内加载 baseline、cleanup 单独失败时写 failure artifact，并在最终 artifact 写盘后只按该 artifact 的 `error` 失败。该 orchestration 尚未运行新鲜验证，不能沿用上一次校准 smoke 的通过结论。
- 最新 orchestration 的独占 smoke 已新鲜通过：artifact 为 `passed:true` / `error:null`，11 项 metrics 全过，fixture/network/provenance 与 baseline 一致；运行前后 `roc-agent-performance-workspace-*` 临时目录均为 0。
- Local Risk review 已定位 restart cleanup 边界：`measureRestartResume()` 在 `mkdtemp()` 后、进入 `try/finally` 前构造首个 file-backed SQLite connection；若该构造失败，临时目录不在 cleanup 保护内。应把首个 connection 初始化移入已有 `try`，不新增抽象。
- Local Risk review 另确认 threshold failure parser 只要求 summary IDs 与当前 `passed:false` metrics 一致，却不要求完整 11 项 metric set；现有测试明确接受单项 threshold artifact。普通 execution error 需要 partial metrics，但 threshold breach 表示测量已完成，是否必须 exact set 待最终 Spec review 判定。
- 最终 Spec review 确认上述两项均为 Medium：threshold breach 必须携带完整有序 11 metrics，restart 临时 SQLite constructor 必须进入 cleanup 边界；其余 performance 专项与 per-scope subagent budget 语义无偏差。
- 最终 Standards review 发现两个 hard evidence/cleanliness gap：smoke 的 `expect` 与 `agentPerformanceMetricIds` 未使用，strict unused 会失败；artifact builder 未直接覆盖 clean-pass 与 threshold-breach 分支。另建议把两处相同的 execution-failure artifact 组装收为 test 内局部 helper，避免 schema 演进漂移。
- Review fix 后 threshold parser 仅在 threshold prefix 分支要求完整有序 metric set，普通 execution failure 仍可 partial；builder 的 clean-pass、ordered multi-metric threshold 与 unexpected-fetch 三分支均有直接断言。
- Restart 首个 DB open 和 close 已进入 nested cleanup；修复后独占 smoke 11/11 metrics 通过，outer workspace 与 restart temp dir 运行前后均为 0。最高 observed ratio 1.704，仍低于冻结阈值。
- Review-fix 最终 Standards 与 Spec 复审均为 `No findings`；本地 Risk closure 无新增 finding。合并 Part 7 focused gate 为 5 files / 28 tests passed。
- Broad gate 首轮 UI/transcript performance smoke 在未改动的 profile-1k interaction 门失败：2474.7138ms > 750ms；seed、native rebuild 均成功。Part 7 diff 不修改 renderer/history smoke 路径，需在独占空闲环境复验后再判断是否为回归。
- 同一代码与门槛下随后两次独占 UI performance smoke 连续通过：profile-1k 分别 406.61ms、384.84ms，profile-10k 分别 361.59ms、365.10ms；Node ABI restore 后 `better-sqlite3` 均可加载。首轮记录为 broad suite 后环境抖动，不修改 UI performance 阈值。
- Part 7 broad gate 最终通过：focused 5 files / 28 tests、agent smoke 1/1、contract 13/13、typecheck、strict unused、IPC check、build、default Vitest 319 files / 1752 tests、responsive smoke、连续两次 UI performance smoke 与 diff check。

## Stage 7 Part 1 - Middleware Overlap Discovery

- 权威目标来自 `plan.md` 7.1：逐层记录 Deep Agents `PatchToolCallsMiddleware`、Roc tool protocol、rescue parsing、tool resolution、runtime error mapping、tool retry/effect idempotency 的 input/output/error/retry/effect/event 责任。
- 删除门槛是当前安装包 1.10.7 的真实 event fixture 与 deterministic trajectory 等价证据；静态名称、表面重复或单独的 unused scan 不构成删除依据。
- Roc 必须继续拥有 Windows path、capability manifest、effect recovery、product error/audit；Deep Agents 1.10.8 patch 属于独立 7.2，不进入本部分提交。
- Deep Agents 1.10.7 `PatchToolCallsMiddleware` 只修复消息 parity：删除没有前置 tool call 的 orphan `ToolMessage`，并为 dangling `AIMessage.tool_calls` 注入 cancellation `ToolMessage`；它不拥有文本解析、参数归一化、授权、resolution、retry、effect 或产品错误映射。
- 真实 `run.toolCalls` event keys 为 `callId,error,input,name,output,status`；其中 `output` 是工具原始返回值，不是最终 `ToolMessage`。Roc 编译 subagent 时显式安装 patch middleware 必须保留，因为 `CompiledSubAgent` 不再经过 native declarative subagent normalization。
- 新增 overlap conformance suite 稳定为 7 tests / 4 passed / 3 failed。失败分别证明：runtime error mapping 抢先吞掉 `RocToolResolutionError`；effect identity 缺失使 handler 未执行；network retry 同样在 effect 层之前失败。
- LangChain middleware 数组第一项位于最外层。当前 Roc 组合让 resolution/effect 的原始异常先被错误层转换，且 error budget 可能把 `Command` 返回给只允许持久化 `ToolMessage` 的 effect 层。
- `wrapToolCall` 的真实 runtime keys 为 `configurable,context,interrupt,signal,store,writer`，没有 `executionInfo`。主 agent identity 位于 `runtime.configurable` 的 `checkpoint_ns: 'tools:<tool-task-id>'` 与 `checkpoint_map['']`；subagent namespace 为去掉最后一个 `|tools:*` segment 后的前缀，checkpoint ID 取 `checkpoint_map[agentNamespace]`。
- execution path 规则冻结为：agent namespace 为空时 `main`，非空时 `subagent/<agent-namespace>`；同时严格校验 `ls_agent_type` 与 namespace 一致，不增加不存在字段的 compatibility path。
- 当前没有被 native middleware 完整覆盖的 Roc owner，因此不删除 production middleware；本 part 的最小修复是对齐真实 execution identity 与既有 wrapper 顺序。
- `schedule_background_task` 在 `previewStore.take(previewId)` 返回 `null` 时、调用 `createBackgroundTask()` 与 `registerTask()` 之前抛 `RocToolResolutionError`；该失败确定尚未发生副作用，即使工具使用 `manual_confirmation` reconcile，也必须在 effect ledger 记为 `failed_final`，再由外层 resolution middleware 映射为 tagged soft result。
- `compileRocSubagent()` 在 `createSubAgent()` 前显式加入 `createPatchToolCallsMiddleware()`；这是 CompiledSubAgent 的直接生产 owner。Stage 7.1 必须同时保留静态 wiring 回归与真实 `task` trajectory，不能只用 main agent event 或手写 subagent runtime fixture代替。
- 生产 manifest 将内建 `task` 限定为 `main`，而 MCP/插件工具默认可授权 `main` 与 `subagent`；`applyRunModeSubagentMiddleware()` 会把 declarative subagent 的显式 tools 再按 subagent scope 过滤。真实 identity fixture 必须保留这两层 protocol，而不是直接调用 subagent runnable。
- 现有真实 fan-out 测试已证明 main/subagent 使用独立 fake model 可稳定驱动 `task` 子图；Stage 7.1 单分支 fixture 可复用同一结构，让 subagent 调用一个 effectful tool，并把 effect row 与真实 checkpoint namespace/ID 交叉验证。
- 真实 unknown-tool agent invocation 在 `RocToolProtocolMiddleware` 的 manifest 授权边界直接拒绝，错误为 `agent_capability_manifest_tool_not_authorized:<name>`；该层位于 runtime error mapper 外侧，因此合同是 invocation hard failure，不是 error `ToolMessage`。
- Deep Agents 原生 `task` 成功结果的 `ToolMessage.status` 为 `undefined`，现有 trajectory adapter 将其规范化为 success；真实 subagent identity 测试应断言 trajectory success，不应要求框架写入显式 `status: 'success'`。
- LangChain 1.5.3 `ToolRetryMiddlewareOptionsSchema` 的默认 `onFailure` 是 `continue`，重试耗尽会返回 `ToolMessage(status: 'error')`；默认 `retryOn` 接受所有 `Error`，不能把未显式配置的生产行为写成“耗尽继续抛出”。
- 修复前 retry 位于 protocol 与其他 safety owner 外侧。用安装包真实 `toolRetryMiddleware` 复现后，名为 `web_read` 的 scope denial 和 `AbortError` 均执行 3 次并被转换为 error `ToolMessage`；现已把 retry 移到 safety owner 内侧，并用显式 predicate + conditional onFailure 保留 capability fail-closed、abort、interrupt 与 non-retryable product error，同时让真正的 retry exhaustion 继续返回可恢复的 error `ToolMessage`。
- LangChain `MiddlewareError.isInstance` 只校验 `Error` 上可写的 `~brand`，而 `cause` 同样可写；工具错误可构造自环或双环。Roc 解包边界必须跟踪已访问对象，避免同步无限循环冻结 Electron main。

### Stage 7.1 Middleware Responsibility Matrix

当前相关 `wrapToolCall` 外到内顺序为 Roc protocol -> error budget 与其余 safety owner -> native network retry -> runtime mapping -> resolution mapping -> effect ledger -> tool handler。Rescue 是 `afterModel` owner，PatchToolCalls 同时修复 agent/model 前的 message parity；两者不与 tool handler wrapper 争夺同一错误责任。

| Layer | Input | Output | Error | Retry | Effect | Event | Production owner | Owner tests |
|---|---|---|---|---|---|---|---|---|
| Deep Agents `PatchToolCallsMiddleware` | 当前 `messages`，包括 orphan `ToolMessage` 与 dangling `AIMessage.tool_calls` | 删除 orphan result，为 dangling call 注入 cancellation `ToolMessage`，并把同一 parity history 交给 model | 不分类 Roc domain/protocol/runtime error | 无 | 无 | 不直接 emit；修复后的 messages 是 native stream/message projection 的输入 | Deep Agents 1.10.7 `createPatchToolCallsMiddleware`；CompiledSubAgent 由 `src/main/services/deep-agent/agent-builder.ts:compileRocSubagent` 显式安装 | `tests/main/services/deep-agent/middleware-overlap-conformance.test.ts` parity + real event shape；`tests/main/services/deep-agent/context/native-summarization-conformance.test.ts` compiled wiring |
| Roc tool protocol | `ToolCallRequest`、runtime tool identity、frozen capability manifest、main/subagent scope | 仅对已授权 call 规范化 background-task JSON handoff 参数，其余 args 原样透传 | 未注册、scope denied、runtime identity drift 直接 fail closed | 无；未知工具不进入 network retry | 无 | 不直接 emit；下游 native event 使用通过授权并规范化后的 call | `src/main/services/deep-agent/tool-protocol.ts:createToolProtocolMiddleware` | `tests/main/services/deep-agent/tool-protocol.test.ts`；overlap suite 的 rescue/protocol 与 real unknown-tool trajectory |
| Rescue parsing | model 返回的最后一个 `AIMessage`、当前可用 tool candidates | 将受支持的文本/content-block 格式重建为 structured `tool_calls`，保留 reasoning 与 `forge_rescue` metadata；无法唯一解析则不改 | 不处理 tool execution error，不接受未知 tool name | 无 | 无 | 不直接 emit；生成的 structured call 由 native tool event owner 后续投影 | `src/main/services/forge-guardrails/middleware/rescue-parsing.ts:createRescueParsingMiddleware` 与 `rescue-parser.ts` | `tests/main/services/forge-guardrails/middleware/rescue-parsing.test.ts`、`rescue-parser.test.ts`；overlap rescue/protocol trajectory |
| Tool resolution | 原始或 `MiddlewareError` 包裹的 `RocToolResolutionError` 与 call identity | tagged soft `ToolMessage(status: success)`，内容为 `[ToolResolutionError] ...`，让 model 可修正输入 | 仅消费 resolution error，其他异常原样抛出 | 无 | effectful call 必须先由内层 ledger 记 `failed_final`；本层不写 ledger | 不直接 emit；soft `ToolMessage` 进入 native tool-result/message projection | `src/main/services/forge-guardrails/middleware/tool-resolution.ts:createToolResolutionMiddleware` | `tests/main/services/forge-guardrails/middleware/tool-resolution.test.ts`；overlap read/schedule resolution trajectories |
| Runtime error mapping | 内层未消费的 `RocDomainError` 或 generic tool error | product `ToolMessage(status: error)`；保留 Roc code/message/userAction | `GraphBubbleUp`、abort 与 `web_read`/`web_search` error 原样向外抛 | 不重试；network error 明确留给外层 native retry | effect ledger 已先记录 success/failure/unknown；本层不改变状态 | 不直接 emit；error `ToolMessage` 由 native stream 投影 | `src/main/services/forge-guardrails/middleware/tool-runtime-errors.ts:createToolRuntimeErrorMiddleware` | `tests/main/services/forge-guardrails/middleware/tool-runtime-errors.test.ts`；overlap product runtime trajectory |
| Native tool retry | safety owner 已放行的 `web_read`、`web_search` handler failure，同一稳定 tool call | 成功时返回最终 handler result；真正耗尽时返回 `ToolMessage(status: error)` 与既有脱敏 failure message | 显式 predicate 解包 middleware error；abort、GraphBubbleUp 与 `retryable: false` failure 不重试，conditional onFailure 立即抛出原错误链；resolution soft result 不进入 retry | `maxRetries: 2`、`backoffFactor: 1.5` | 每次 attempt 进入内层 effect；retry-safe failure 为 `failed_retryable`，下一 attempt 原子回到 `in_progress`；耗尽后 ledger 保留可恢复的 `failed_retryable` | 不直接 emit 新产品事件；hard error 外抛，retry exhaustion 的 error ToolMessage 继续由 native stream/message owner 投影 | `src/main/services/deep-agent/agent-builder.ts:createExecutionErrorEnvelopeMiddleware` 的 LangChain `toolRetryMiddleware`；`tool-runtime-errors.ts:shouldRetryNetworkToolError/handleNetworkToolRetryFailure` | `tests/main/deep-agent-tool-retry.test.ts` product order/predicate/onFailure；overlap installed-default + product exhaustion/recovery trajectories；`tool-runtime-errors.test.ts` network bubble-up |
| Roc effect idempotency | manifest effect policy、stable call ID/input hash、`runtime.configurable` checkpoint namespace/map/agent type | 首次执行返回并持久化 `ToolMessage`；成功 replay 反序列化同一 result；read-only tool 旁路 | 缺 identity fail closed；retry-safe -> `failed_retryable`；pre-effect resolution/error ToolMessage -> `failed_final`；不确定 manual effect -> `unknown` | 不调度 retry；只暴露可重试状态给外层 native retry，禁止 blind replay `unknown`/`failed_final` | 唯一 ledger owner：key 为 run + execution path + checkpoint + call；main/subagent 均绑定真实 checkpoint | 不直接 emit；ledger 是 durable audit/recovery 事实，native stream 继续拥有 tool event shape | `src/main/services/deep-agent/tool-effect-idempotency.ts:createToolEffectIdempotencyMiddleware` 与 `tool-effect-store.ts` | `tests/main/services/deep-agent/tool-effect-idempotency.test.ts`；overlap main retry、background resolution 与 real `task` subagent checkpoint trajectory |

结论：上述各层在 input/output/error/retry/effect/event 六维均有非重叠 owner；当前没有可由 Deep Agents 1.10.7 native middleware 完整替代的 Roc 层，因此 Stage 7.1 不删除 production middleware。

### Telemetry Contract

- 每个 run 持久化一个 versioned、redacted summary，覆盖 correlation、model usage、tool、subagent、context、runtime 和 terminal 状态。
- 持久模型不包含 raw prompt、reasoning、secret、workspace path 或完整 tool/subagent output；schema 顶层及各 section 均为 strict。
- `runId`、`threadId`、`occurrenceId`、`dispatchKey` 只属于 row/trace metadata，不得进入无限 metrics label key。`MetricsService` 的 per-key ring buffer 不能限制 key 总数。
- Repository 读取时验证 JSON、schema version、row/payload `runId` 和完整 frozen identity；missing、corrupt、unknown field 或 identity mismatch 均 fail closed。
- 完整 frozen identity 由 session repository 读取层加载 run/snapshot 后校验；低层 row repository 只负责 schema/version/row `runId` round-trip。

### Persistence And Lifecycle

- `agent_run_telemetry` 与 `agent_runs` 一对一；run 创建时写 initial row，运行中由 accumulator 合并 model/tool/subagent/context/recovery 观测。
- Completed、failed、cancelled、interrupted telemetry 与 run 状态在同一 repository transaction 内提交。Persisted row 已终态化时拒绝覆盖。
- Cancel 会等待指定 run 的 executor `finally` 回报最终 usage，再提交 terminal telemetry；transaction 失败时恢复 active claim，允许同进程重试。
- Interrupt 路径先累计 recovery，再原子写 `waiting_user`、pending projection 和 telemetry，最后发布 renderer event。Telemetry UPDATE 失败会回滚整个 waiting transition。
- Startup quarantine 使用已存在的 initial telemetry 构造 interrupted snapshot；restart resume 遇 missing telemetry 明确失败并保留 waiting projection。
- History deletion 在删除 `agent_runs` 前显式删除 telemetry；retention、database maintenance、required-table fast probe 和 health/kernel schema version 已同步到 v12。

### Migration Boundary

- Canonical v11 database 通过 v12 migration 回填 telemetry；legacy rebuild 仍只接受既有 `task_threads/task_runs` source contract，不增加 hybrid compatibility path。
- 已发布 migration 不可修改，否则现有 migration checksum 会 drift。当前改动保持 v1 migration 原文不变。
- V2 snapshot backfill 已有真实 fixture 与 repository 读取断言。
- v12 SQL 的 V1 omission 已在当前工作树修复：backfill 选择 V1/V2，telemetry 仍写 parser 规范化后的 `snapshotVersion: 2`；真实 V1 fixture、最终 review 与 broad gate 均已通过。
- V1 与 V2 的 telemetry correlation 字段路径一致：`runOrigin`、`dispatchKey`、`capabilityManifest.manifestHash`、`model.providerId`、`model.modelId`；migration 只需把 V1 row 纳入选择，无需新增兼容转换层。
- Telemetry 的 `snapshotVersion` 表示 runtime 规范化后的 execution snapshot contract，当前 schema 固定为 `z.literal(2)`；历史 V1 snapshot 由 parser 迁移为 V2，因此 backfill 必须仍写 `2`，不能扩成 `1 | 2`。
- 真实 V1 fixture 必须包含完整 strict snapshot 和可校验 capability manifest；仅构造 migration 使用到的 JSON 片段不能证明当前 parser 仍接受该历史格式。

### Runtime Regression Evidence

- 红灯曾稳定复现四个问题：cancel 最终 usage 为 0、retry 后 interrupt 的 `recoveryCount` 为 0、tampered frozen manifest 未拒绝、startup interrupted telemetry 终态为空。
- 上述四项已转绿。额外回归证明：interrupt telemetry 写失败整事务回滚；restart resume 缺 row 保留 waiting projection；corrupt JSON 不被 valid in-memory snapshot 覆盖；cancel terminal transaction 失败后可重试。
- 最后记录的 runtime focused：`runtime`、`runtime-executor`、`session-repository`、`runtime-hooks` 4 files / 58 tests 通过。
- 最终 Part 2 focused gate：15 directly affected files / 113 tests 通过，覆盖 repository、runtime/executor、interrupt/recovery/cancel、metrics、schema/migration/rebuild/retention/health/kernel 和 outbox history。
- Part 2 broad gate：strict unused、IPC check、full Vitest 310 files / 1680 tests、build（含 typecheck）与 diff check 全部通过。

## Open Risks

| Severity | Risk | Closure |
|---|---|---|
| External | 真实 Anthropic `cache_read` usage 需要 provider 凭据。 | 留给 Stage 6 provider integration；当前不表述为 provider hit 已验证。 |
| High | LangSmith root session 当前为进程内 run-scoped map；waiting_user 后进程重启再 resume 会新建 root。 | 已持久化最小 root identity；restart continuity regression 证明同一 root 重建，terminal 后清理。 |
| Medium | Manual root payload 仍可能包含 SDK 写入的 `extra.runtime`。 | 已在 export boundary 删除 runtime/serialized，并用真实 POST/PATCH payload regression 证明。 |
| Medium | Root exporter failure 未覆盖业务 terminal 结果。 | 已覆盖 root POST/PATCH failure，业务结果与 terminal 状态保持不变。 |
| Medium | Tracing terminal lifecycle 与 hook notification 耦合，cancel/shutdown 无明确等待和释放语义。 | 已拆分 owner，覆盖 cancel、session read failure、batch drain、dispose 与 shutdown。 |
| Medium | terminal transaction 后进程崩溃会留下已终态 run 对应的 durable trace session，现有 startup reconciliation 不扫描该状态组合。 | 已以持久数据库 fixture 红绿修复；最终 Standards/Spec/Risk 无 residual finding，15 files / 124 tests 通过。 |
| Low | 多个异常残留 terminal sessions 在 critical plugin initialize 中逐条等待 exporter drain。 | 非阻断 residual risk；每条最终删除且异常继续下一条，本轮保留确定性顺序。 |
| Medium | Restart performance fixture 的首个 SQLite constructor 位于临时目录 cleanup `try/finally` 之外。 | 已闭环：open/close/delete 使用 nested cleanup，smoke 与 0 残留通过。 |
| Medium | Threshold failure artifact 可只包含部分 metric set。 | 已闭环：threshold exact ordered set；execution/network failure 保留 partial。 |

## Durable Project Facts

- `.codegraph/` 存在；理解或定位代码时先使用 CodeGraph。
- `/workspace/` 是 Deep Agents file-tool 虚拟路径，不是 shell cwd。Shell、hook 和 subprocess 必须使用真实 Windows 工作目录。
- Run capability、tool identity、execution scope、effect policy 和 background shell authorization 以冻结 manifest/snapshot 为执行事实源。
- Agent DB 持有 run、timeline、outbox 和 telemetry 真相；task DB 只做幂等 projection；EventBus 不是 durable state owner。
- 同 thread active run 使用 CAS/lease；background occurrence 使用 durable claim/lease 和 latest-only coalesce。
- Interactive shell 无审批但仍是 host code execution；background shell 缺 durable pre-authorization 时 fail closed。
- Effect 状态包含 checkpoint/subagent execution path；`unknown` 或 manual-confirmation effect 不允许盲重试。

## Closed Stage Evidence

| Stage | Commit evidence | Durable result |
|---|---|---|
| 0 | `ae0c95b`, `4543408`, `2b28ef1`, `9845543`，以及 Stage 2/4 回归 | 并发、terminal projection、restart、scheduler crash、backpressure 和 cancellation characterization。 |
| 1 | `4d9e8a3` | Preview、executor、audit 和 resume 共享 immutable run contract。 |
| 2 | `1fbda30` | CAS run state、terminal transaction、outbox projector、bounded timeline/backpressure。 |
| 3 | `dfbbf00` | Durable occurrence、claim/lease、restart reconcile、crash-point/projector coverage。 |
| 4 | `4ced164`, `031baea`, `20c235d`, `e75a754`, `7e1ed9f` | Shared execution safety、native budgets、host shell、web/hooks cancellation、effect reconciliation。 |
| 5 | `b223636`, `639c019`, `873df23`, `fcc9c8c`, `9942594` | Context hard budget、single compaction path、saver conformance、restart-safe HITL、recovery-safe retention。 |
| 6.1 | `e538ba9` | Model usage 按 call 合并并跨 main/summary/subagent/retry/cache 累加。 |
| 6.2 | `abc3220` | Versioned、redacted per-run telemetry 与 terminal/recovery/migration/retention/metrics durability。 |
| 6.3 | `012c870`、`82164ab` | 默认关闭的 LangSmith native tracing、durable root lifecycle，以及独立可观测性 settings UI / IPC / secret controls。 |
| 6.4 | `da0eb8d` | 独立 integration mode、真实 Deep Agents/Roc SQLite offline trajectory 与可选 Anthropic live boundary。 |

## Verification Anchors

- Current telemetry：`tests/main/plugins/agent/run-telemetry-repository.test.ts`、`tests/main/plugins/agent/runtime-executor.test.ts`、`tests/main/plugins/agent/runtime.test.ts`、`tests/main/plugins/agent/session-repository.test.ts`。
- Migration/lifecycle：`tests/main/infrastructure/database-migrations.test.ts`、`tests/main/infrastructure/database-retention.test.ts`、`tests/main/plugins/task/agent-outbox-projector.test.ts`。
- Metrics cardinality：`tests/main/metrics-service.test.ts`。
- Backpressure：`tests/main/plugins/agent/run-event-backpressure.test.ts`。
- Windows cancellation：`tests/main/services/shell-execution-cancellation.test.ts`、`tests/main/services/hooks/command-runner.test.ts`。
- Observability settings：`tests/renderer/settings-view.observability.test.tsx`、`tests/main/preload-contract.test.ts`、`tests/main/ipc-plugin-adapter.test.ts`、`tests/smoke/responsive-layout-smoke.mjs`。
- Agent integration mode：`tests/config/agent-integration-mode.test.ts`、`tests/integration/agent/offline-harness.int.test.ts`、`vitest.agent-integration.config.ts`。

## Stage 7.1 Closure Evidence

- 最终 Standards review 的 1 个 Medium 与 2 个 Low 已修复并增量复审为 `No findings`；Spec 为 `No findings`，Risk 为 `No issues found`。middleware 顺序、conditional retry、effect 状态、resolution/manual/abort/interrupt 分叉、cause 环与真实 subagent checkpoint 均有独立证据。
- 最终 broad gate 通过：9 files / 63 focused tests、strict unused、typecheck、IPC check、build、320 files / 1773 full tests、deterministic eval 1 file / 5 tests、独占 agent performance smoke 1 file / 1 test 与 diff check。
- Performance artifact 为 schema v1、11 metrics、0 failed、`passed: true`、`error: null`；运行后无 `roc-agent-performance-workspace-*` 或 `roc-agent-performance-restart-*` 临时目录残留。
- Full Vitest 退出码为 0，测试全部通过；测试汇总后另有 4 条 `node-pty` helper 的 `AttachConsole failed` stderr，不改变本次测试断言或退出状态。
- Stage 7.1 未修改 `package.json` 或 `pnpm-lock.yaml`，Deep Agents 仍为 1.10.7；没有原生等价证据支持删除任何现有 Roc middleware owner。
- Risk residual 仅为 deterministic local trajectory 未覆盖真实 provider 的异常差异；该边界不改变 Stage 7.1 的 middleware overlap 合同。

## Stage 7 Part 2 - Deep Agents 1.10.8 Discovery

- 权威目标来自 `plan.md:647-664`：只审计并升级 1.10.8 core patch，为 `FilesystemBackend` / `LocalShellBackend` glob 增加 Windows junction/symlink loop 与 root containment 回归，并跑 official contract、paths、package 与 Electron smoke。
- Deep Agents 是当前 harness 层，生产依赖应精确 pin 到已验证版本；本 part 不联动升级 LangChain/LangGraph，不用 prompt 或 filesystem permission 代替 Roc runtime workspace、shell authorization 与 root containment。
- Observable contract 固定为 result + side effect + failure boundary：glob 不跟随目录 symlink/junction、不循环、不返回 root 外路径，合法 root 内普通文件仍可匹配；升级不改变已有 capability、checkpoint、retry/effect 或 event 合同。
- 官方 tag compare `deepagents@1.10.7...deepagents@1.10.8` 含 4 commits：ACP permission gate、Deno sandbox injection、目标 PR #668 与 version commit；本 part 只接受 `libs/deepagents` 的 #668/版本变化，明确排除 ACP/Deno。来源：https://github.com/langchain-ai/deepagentsjs/compare/deepagents%401.10.7...deepagents%401.10.8
- 官方 1.10.8 release 只有 #668：在 FilesystemBackend grep/glob 与 LocalShellBackend glob 的全部 `fast-glob` 调用关闭 directory symlink following，并保留 symlink-to-file 分类。来源：https://github.com/langchain-ai/deepagentsjs/pull/668
- npm metadata 表明 1.10.7 与 1.10.8 direct/peer dependency ranges 完全相同；升级不应联动改变 LangChain、LangGraph、fast-glob 或其他解析版本，lockfile 预期只替换 deepagents package key/integrity。
- 本机 1.10.7 Windows junction 复现：FilesystemBackend 118ms、LocalShellBackend 125ms，均返回 root 外 `outside-link/secret.txt`，并沿 `sub/loop` 生成约 80 层重复后代；这是稳定的 result/root-containment 红灯，不依赖等待 `ELOOP`。
- 专用 1.10.7 red gate 为 1 file / 3 failed：FilesystemBackend 与 LocalShellBackend 各返回 64 份 `inner.txt`，FilesystemBackend grep fallback 返回 `/outside-link/secret.txt`；三条失败均落在目标 native patch，不是 fixture/权限/cleanup 错误。
- 精确升级 1.10.8 后同一文件 3/3 passed（39ms）；升级 focused gate 为 4 files / 41 tests，覆盖 junction conformance、Roc backend route、official contracts 与 Stage 7.1 middleware fixture。
- lockfile 只有 importer specifier/snapshot、deepagents package key 与官方 integrity 从 1.10.7 替换到 1.10.8；LangChain/LangGraph/langsmith/fast-glob resolution 均未变化。安装包 ESM/CJS dist 共 6 处显式 `followSymbolicLinks: false`。
- pnpm 仍报告 deepagents peer `langsmith@^0.7.1` 与 Roc 现有 0.8.1 不匹配；1.10.7/1.10.8 peer ranges 完全相同，该 warning 不是本次 patch 引入，需由 official contract/typecheck/package/smoke 继续证明实际组合。
- 首轮最终 review：Spec 与 Risk 无 finding；Standards 发现 grep fallback 断言可假绿、活动账本状态滞后、`package.json` EOF 格式 churn。三项均接受为有效 finding，并限制在测试、账本与精确格式恢复内修复。
- Review-fix 后 junction direct gate 1 file / 3 tests、完整 focused gate 4 files / 41 tests 通过；fallback 现在同时证明 spy 被调用、root 内同 marker 被返回、root 外 junction marker 被排除。
- Standards 增量复审为 `No findings`；Spec 与 Risk 首轮均无 finding。cached package diff 已恢复为只改 `deepagents` 精确版本一行，Part 2 进入 broad verification。
- Broad gate 的 official+junction 2 files / 12 tests、paths、typecheck、build、321 files / 1776 full tests 与 `package:dir` 已通过；full Vitest 汇总后仍有 4 条既有 node-pty helper stderr，但退出码为 0。
- Electron smoke 首轮稳定失败于 `context_budget_profile_invalid`：合成 openai-compatible `smoke-provider` 自 5 月起未声明 context window，LangChain factory 因而使用 production 默认 8192；当前完整 system/tool/schema overhead 已使 model input 非正数。Stage 7.2 staged diff 未修改 budget/runtime/smoke 路径，Deep Agents 1.10.8 目标 patch 也只改变 directory symlink following。
- 最小修复仅让 smoke fixture 显式声明测试中已有的 128000-token context window；production 默认与 fail-closed budget validation 保持不变，同一 Electron smoke 必须转绿后才接受。
- 第二轮 smoke 已越过首轮 task/context failure，证明 seed provider 修复生效；随后 settings UI 新建的 `smoke-ui-openai` 成为默认模型，chat 提交后无新 provider request并在 transcript 等待超时。该 provider 的 UI draft 同样不包含 context window，因此仍落到 8192 默认。
- 修复扩展到在 settings UI 行为验收完成后，用现有 settings IPC 为 `smoke-ui-openai` 写入同一 128000，并立即回读具体值；不提高 timeout、不放宽断言、不修改 production provider/default/budget 行为。
- 第三轮 `pnpm smoke:electron` 以 exit 0 通过；两处 context fixture 修复让 prescribed packaged Electron workflow 恢复可执行，同时保留原有 chat、task、capability、settings、native 与 renderer 断言。
- Smoke-fixture 增量 Standards review 仅发现 required-gate 边界误用单数 provider；已同步为两个合成 provider，implementation 不变。Spec 增量 review 为 `No findings`。

## Stage 7.2 Closure Evidence

- 最终 Standards / Spec / Risk 分别为 `No findings` / `No findings` / `No issues found`；grep fallback、账本/EOF 与两个 smoke fixture finding 均已闭环。
- 最终行为证据：1.10.8 direct 1 file / 3 tests、focused 4 files / 41 tests、official+junction 2 files / 12 tests、321 files / 1776 full tests、build、package directory 与 Electron smoke 全部通过。
- 最终静态证据：`verify:paths`、typecheck、strict unused、两份 smoke MJS `node --check` 与 cached diff check 通过；测试后无 `roc-smoke-*`、`roc-deepagents-junction-*` 或 Roc/Electron process 残留。
- 依赖边界仅为 `deepagents` 1.10.7 -> 1.10.8 package key/specifier/integrity/snapshot；LangChain/LangGraph/langsmith/fast-glob resolution 未改变。既有 langsmith peer warning 与 Windows-only junction coverage 作为 residual 保留。

## Stage 7.3 Versioned Stream Adapter Scope

- 权威规格是 `plan.md:666-668`：集中 Deep Agents 1.10.x reflection 读取，以安装包真实 stream shape 作为 fixture；升级时只改 adapter/contract，projection 不再拥有 shape 猜测。
- 当前事实基线是提交 `475b4d2`，工作树仅有未跟踪 `plan.md`；Stage 7.3 尚无 production/test 修改。
- 最小目标是一个当前版本 owner，不是通用兼容层：先冻结 1.10.8 `streamEvents(..., { version: 'v3' })` 的实际异步 shape，再定义 Roc 内部 DTO 和显式 contract failure。
- 待重新验证的定位候选为 executor 入口、stream consumers、subagent projection、tool/usage/record helpers 与 final-output owner；只有直接读取上游 shape 的位置进入迁移范围。
- CodeGraph 的首轮宽查询被同名 `run` / `read` 符号扩散，未返回目标 consumer 源码；该结果不足以支持设计，后续定位必须按 `consumeMessageStream`、`consumeToolCallStream`、`consumeSubagentStream` 和 executor 入口逐个查询。
- 精确 CodeGraph 结果确认 `consumeMessageStream`、`consumeToolCallStream`、`consumeSubagentStream` 当前分别接收 `AsyncIterable<unknown>`；executor 是直接调用方。
- `consumeMessageStream` 在业务投影内读取上游 `text`、`reasoning`、`output` 和 content blocks；`consumeToolCallStream` 直接读取 `name`、`input`、`output` 并自行猜测 call ID；subagent consumer 把未知 shape 继续传给 `projectSubagentStream`。这正是 Stage 7.3 要收敛的 shape ownership。
- 边界候选因此是 executor 创建 adapter 后把 typed Roc DTO streams 交给现有 consumers；consumer 内仅保留 Roc 投影/过滤语义。最终位置仍需结合 subagent、usage、final output 的完整读路径确认。
- `subagent-projection.ts` 当前直接读取 `name`、`taskInput`、`asyncTaskId`/`taskId`、`messages`、`toolCalls`、`subagents`、`output`，并自行识别 async iterables/Promises。adapter 应拥有这些读取和 contract 校验；projection 继续拥有 Roc `SubagentIdentity`、递归序列与事件顺序。
- 当前 subagent tests 存在于 `tests/main/services/deep-agent/subagent-projection.test.ts`，但 CodeGraph 显示它们是 projection owner tests；是否来自真实安装包 shape 仍需直接审计，不能把手写对象当 Stage 7.3 fixture。
- executor 在 `agent.streamEvents(..., { version: 'v3' })` 后把 `run.toolCalls/messages/subagents` 强转为 `AsyncIterable<unknown>`；完成消费后又直接读取 `run.interrupted` 和 Promise-like `run.output`。单一 run adapter 应同时拥有这五个边界，而不是只包装三个 iterable。
- usage accumulator 当前从每个未知 message 反射读取 `usage_metadata`、`id` 及 token details。安装包公开 message-handle 合同另有 `usage` stream；必须用真实 fixture 判断当前逻辑是否只是被手写测试形状掩盖，不能先假设行为等价。
- tool call helper 当前接受 `callId` 或 `id` 两种猜测；1.10.x/v3 公开 handle 使用 `callId`。adapter contract 应固定当前官方/真实字段，projection 不再保留升级猜测。
- 本机安装路径已解析为 pnpm junction，package version 精确为 `deepagents@1.10.8`。其声明把 `streamEvents(..., { version: 'v3' })` 标为 experimental projection API，并说明未来版本可能变化，这直接支持版本化 adapter 边界。
- `DeepAgentRunStream` 是对 LangChain `AgentRunStream` 的类型 overlay，仅把 `subagents` 收窄为 Deep Agents 声明的 subagent union；run/message/tool 基础 shape 的实际 owner 在 LangChain/LangGraph stream 包，fixture 必须通过 Deep Agents 创建的真实 run 采样而不是只摘抄 `.d.ts`。
- LangChain 1.5.3 的真实 `SubagentRunStream` 合同是 `name/cause/output/messages/toolCalls/subagents`；没有 projection 当前猜测的 `taskInput`、`asyncTaskId` 或 `taskId`。`cause` 是触发 tool call 的 lifecycle cause，真实 fixture 必须固定其值并决定 Roc identity 的最小映射。
- `ToolCallStream` 合同固定为同步 `name/callId/input`，Promise `output/status/error`；现有 `callId || id` fallback 与 projection 内 Promise 探测应迁入 adapter，且当前版本不应继续把 `id` 当上游合同。
- `run.messages` 产出 `ChatModelStreamHandle`，即非 thenable 的 streaming handle，并附带 `namespace/node`；其 `.text/.reasoning/.usage/.output` 具体 contract 仍需从 Core 声明和真实 run fixture交叉确认。
- Core 1.2.2 声明确认每个 message handle 同时提供 raw event async iterable、`.text`、`.toolCalls`、`.reasoning`、`.usage` 和 `.output`；`.usage` 本身是 async iterable + thenable 的 `UsageMetadataStream`。Stage 7.3 usage DTO 应由该公开 stream 生成，而不是继续依赖 handle 顶层不存在的 `usage_metadata/id`。
- `deep-agent-final-output.ts` 直接反射 `run.interrupted/interrupts`，并在最终 `run.output` state 内猜测 `messages` 及 assistant message shape。adapter 至少应把 run terminal fields 转成明确 DTO；interrupt payload 的 Roc schema normalization 与最终可见文本过滤可继续由 projection owner 处理。
- 当前实际版本组合为 `deepagents@1.10.8`、`langchain@1.5.3`、`@langchain/langgraph@1.4.7`、`@langchain/core@1.2.2`；adapter contract fixture 应冻结这组安装解析下的运行 shape，但版本名按规格只承诺 Deep Agents 1.10.x / v3。
- `middleware-overlap-conformance.test.ts` 已用真实 agent v3 run 断言 tool handle keys 为 `callId/error/input/name/output/status`；可复用其可控 `BaseChatModel` 和 drain 模式，不必另造 tool fixture harness。
- `subagent-budget-state-isolation.test.ts` 已通过真实 `task` tool 驱动 compiled subagents；可从该模式抽取最小 subagent stream fixture。相对地，executor/usage/subagent projection 单测当前大量手写 `usage_metadata`、`taskInput` 等旧近似对象，不能作为安装包真实 shape 证据。
- `deep-agent-official-contracts.test.ts` 已有纯类型 required-key 锚点，但它只证明编译期声明，不证明 runtime property descriptor、Promise/iterable 行为或真实 values；Stage 7.3 仍需 runtime fixture。
- 现有 `ScriptedToolModel` 返回真实 `AIMessage` 并通过真实 `agent.streamEvents(...v3)` 产出 handle；为响应加 `usage_metadata` 即可直接验证 `.usage`，无需 mock stream DTO。
- 现有 subagent fixture 用主 `FakeToolCallingModel` 调用内建 `task`，子 model 返回终态，证明可稳定驱动真实 named subagent；Stage 7.3 可缩成单 subagent 并采样 `cause/messages/output`。
- `subagent-projection.test.ts` 已有一条 `cause`/无 legacy task input 的手写 case，但同文件其余 identity 测试仍依赖 `taskInput`；迁移后 projection tests 应只构造 adapter DTO，不再构造 Deep Agents-like raw objects。
- 首轮真实 fixture 显示 message handle 的 `node` 是 `model_request`，`namespace` 为 `model_request:<动态 UUID>`；不能把 root message namespace 假设为空数组。
- `handle.output` 返回的 AIMessage 把字符串正文规范化为 `{ type: 'text', text }` content blocks；tool-call message 的 `output.tool_calls` 为空，因此 tool call 必须从 handle 的 `.toolCalls` stream 或 run-level `.toolCalls` 读取，不能从 final message output 反推。
- 在当前非 streaming `_generate` fixture 中，message handle 虽暴露 `.toolCalls`，该 stream 仍为空；真实调用只稳定出现在 run-level `.toolCalls`。adapter 不能把 message-level toolCalls 当作 run projection 的替代来源。
- 真实 named-subagent fixture 已确认公开 fields、`cause: { type: 'toolCall', tool_call_id }`、scoped message usage、空 nested tool/subagent streams 与 final output state；第二轮该 case 已直接通过。
- reflection inventory 显示 Stage 7.3 owner 不仅是 executor 的三个 cast：message consumer 还猜测 content blocks、tool-call chunks、guardrail message、reasoning fallback；usage 猜旧 `usage_metadata/id`；subagent 猜 legacy identity fields；final-output 猜 run terminal fields。
- `record-utils.ts` 不是整体迁移候选：它还由 final assistant content normalization 和独立 provider-message tests 使用。只把 Deep Agents handle/property/iterable/Promise contract 集中到 adapter；通用 message content/redaction 解析继续由现有 owner 使用。
- `stream-tool-utils.ts` 的 `redactUnknown` 被 tool-output projection 共用，必须保留；`readToolCallId/readContentBlocks/buildToolCallChunkData/readToolChunkId` 是否继续存在取决于 adapter DTO 设计和 owner tests，不能整文件删除。
- `stream-consumers.test.ts` 目前直接传 raw-like objects；tool cases只给 `id`，missing-callId case 期待静默跳过。新 contract 应让 consumer 只接受 typed DTO，并由 adapter 对缺 `callId/name/stream/promise` 显式失败。
- `run-usage-telemetry.test.ts` 以 message `id + usage_metadata` 测累加/同 call 覆盖。迁移后仍要保留“一个 model call 的 partial usage 合并”，但 stable key 应由 adapter 的 message-handle identity 生成，usage 值来自 `.usage` stream。
- executor test helper 返回的 synthetic run 只有 `toolCalls/messages/subagents/output`，缺 `interrupted/interrupts`，且三个 stream item 是 raw legacy shapes。helper 必须升级成完整 1.10.x/v3 run contract，避免 adapter 测试被不真实 fixture 绕过。
- final-output interrupt test当前把整个 raw run 传入 projection；迁移后应直接传 adapter 已验证的 interrupt DTO，payload 的 Roc normalization/顺序断言保持不变。
- `guardrail_nudge` 的 stream 入口只有 `stream-consumers.ts` 和一条手写 HumanMessage 单测；真实 v3 `run.messages` 合同只产 chat-model handles，无法产出该 BaseMessage 分支。Forge message tags 在 middleware/state 仍有独立 owner，adapter 迁移不删除那些职责。
- tool progress 分支反射 message 顶层 content blocks；真实 handle 公共合同不含这些字段。OpenAI tool chunks 在 model normalization 层有独立 tests，但没有证据表明它们能经当前 v3 handle 顶层读取。Stage 7.3 不新增 raw-event feature，只移除 projection 的错误 shape ownership。
- `consumeVisibleTextStream` 的 hosted-search prefix suppression 是纯 Roc 文本语义，和上游 handle shape 无关，应保留；redaction、tool output projection、event ordering 也继续由 consumers 拥有。
- Deep Agents `AsyncSubAgent` 由独立 async-task middleware 和 `start/check/update/cancel/list_async_task` tools 驱动；`run.subagents` transformer 只报告嵌套 named `createAgent` runs。projection 对 `asyncTaskId/taskId` 的猜测不属于 1.10.x/v3 named-subagent contract。
- Shared/UI 的 `SubagentIdentity` 仍可表达 async，但 Stage 7.3 adapter 的 named subagent 投影应使用 `execution: 'sync'`、`taskInput: null`；不修改 async task tools/state 的其他产品合同。
- `readInterrupted/readRunInterruptedEvents/readFinalAssistantText` 只有 executor 生产调用与一个 interrupt owner test；可安全把前两者改成 adapter terminal DTO 输入，并把 final output 顶层 `messages` validation交给 adapter。
- Adapter 红合同已固定五类输出/失败边界：真实 root run DTO、真实 named subagent/cause/递归 stream、partial usage null 语义、tool required/Promise 边界，以及 run/message/subagent contract drift 显式错误码。原始安装包 characterization 2/2 仍独立通过。
- Adapter DTO 使用 stream path + ordinal 生成 usage key（如 `run/messages/0`、`run/subagents/0/messages/0`），不依赖 provider message `id`；这为同一 model call 的 partial usage 合并提供稳定内部 identity。
- 红合同自查补齐两层 named-subagent recursion、`status/error` Promise 与 run/message terminal drift；最终 6 条 adapter cases 全部只因 stub 未实现而失败，typecheck/diff check 通过，未发现 fixture 假绿或行为先验冲突。
- 安装包声明复核发现 `SubagentRunStream.cause` 合法为 `LifecycleCause | undefined`；真实 tool-dispatched fixture 有 cause，但恢复不到 originating tool 时为 undefined。adapter 应把该合法缺省规范化为 `null`，只有非 toolCall 或缺 `tool_call_id` 的对象才显式失败。
- `cause: undefined` 红测先稳定失败为 `deep_agents_1_10_v3_subagent_cause_invalid`，最小映射为 `null` 后 adapter 9/9、typecheck 与 diff check 通过；tool status/error 类型也与 LangGraph 1.4.7 声明完全一致。
- Typed consumer migration 红灯为 8 files / 57 tests：50 passed、7 failed。失败只覆盖 accumulator 3 条、executor main/subagent usage 2 条、tool contract error 1 条、subagent contract error 1 条；typecheck 6 个错误全部是旧 accumulator 两参数签名。这证明测试 DTO/fixture 已对齐，production 迁移边界稳定。
- Consumer migration closure 的 CodeGraph 复核显示，新 `StreamConsumerCallbacks` 只包含 runtime/todo/tool projection 等现行回调；`createExecutorCallbacks()` 仍返回的空 `recordTaskEvent` 已不属于该合同，是旧 guardrail stream 分支删除后留下的候选本次-unused 项，仍需精确引用扫描确认后才能删除。
- `createChatRunEventQueue()` 的生产 overflow 合同未变：默认最多 1000 个排队事件，第 1001 个不可合并事件会令队列以 `chat_run_event_queue_overflow` 失败。当前失败属于 tool producer 变慢后旧测试输入不再稳定形成 burst，修复边界应限定为测试 fixture，不修改产品容量或 overflow 语义。
- 精确全仓扫描确认 `recordTaskEvent` 的代码引用只剩 executor 空实现与 consumer test 的多余 mock；移除两处不会删除现存事件 side effect。
- Overflow owner test 可通过控制外层 iterator 形成确定性 backpressure：先读取首个 tool event 后暂停请求下一项，内部 `consumeRun` 继续生产而 executor 停在 `yield`，真实 1000-event queue 必然填满；producer `finally` 可作为 overflow 已发生的同步点，随后 drain 同一 iterator 应显式抛出 `chat_run_event_queue_overflow`。
- Consumer migration 残余扫描显示，stream `AsyncIterable<unknown>`、上游 `tool_call_id` 与相关 `Reflect.get` 已集中在 versioned adapter；consumer、usage accumulator 与 subagent projection 均只接 `DeepAgents110V3*` DTO。已删除的 chunk/id helpers 无引用，`stream-tool-utils.ts` 只剩仍被三个 owner 使用的递归脱敏函数。
- 待 review 定性的唯一 reflection 边界是 `deep-agent-final-output.ts`：interrupt payload 的 unknown 解析属于 Roc 产品 DTO，但 final output 仍从 adapter 的 `messages: readonly unknown[]` 读取 `role/type/content`。需对照 Stage 7.3 判断该 LangChain message 内容投影是否允许留在 final-output owner，或应由 adapter 提供更具体 DTO。
- Final-output 调用链复核确认 adapter 只拥有 output record 与 `messages` array 的合同校验；末条消息的 assistant 身份、content block 与可见文本解析仍由既有 `record-utils`/final-output owner 完成。该逻辑不是本次新增，但当前 DTO 仍将 message 元素声明为 `unknown`，Spec review 需判断 Stage 7.3 的“shape 猜测不散布到 projection”是否要求继续收口。
- Tool consumer 当前等待 `output/status/error` 三个 Promise，但只使用 `output` 值决定 end/error；owner tests 覆盖 output reject 与 status adapter-contract reject，未覆盖合法 `status: 'error'` + resolved error 值。是否为行为缺口取决于 1.10.8/LangGraph handle 是否保证 tool failure 同时使 output reject，需从安装包声明/实现取得直接证据。
- LangGraph 1.4.7 `stream/types.d.ts:198-213` 明确说明 output 只在成功时解析，reject/hang 由 runner 决定，并建议与 status/error 配对；error Promise 在 status 为 `error` 时提供消息。故当前 `Promise.all` 等待并忽略 status/error 是实际兼容性/挂起风险，不是推测。修复 owner 应是 1.10.x adapter 的 tool terminal DTO，root 与 subagent projection 不应各自重新解释三 Promise。
- Tool terminal finding 已闭环：adapter 在 raw handle 映射时立即配对 output/status/error 并暴露 discriminated outcome；error status 不等待 output，running/missing/unexpected error 属合同失败。root/subagent consumers 已无三字段读取，3 files / 25 tests、typecheck 与残余扫描通过。
- Spec reviewer 确认 final/trailing message reflection 是 Medium 缺口：`DeepAgents110V3Message.output` 与 `DeepAgents110V3Output.messages` 仍暴露 unknown，升级 nested message shape 时还需改 consumer/projection。修复应由 adapter 输出 `trailingReasoning`/`finalAssistantText` 等稳定 DTO，并把现有内容解析测试迁到 adapter owner。
- Nested message DTO finding 已闭环：adapter 现在把 raw message output 解析为 `trailingReasoning`，把 run/subagent final messages 解析为 `finalAssistantText`，并显式拒绝畸形 message 元素。projection 侧 role/type/content/output.messages 扫描为 0；3 files / 27 tests、typecheck 与 diff check 通过。
- Standards review 发现派生 Promise 观察时序 High risk：root `consumeMessageStream` 只在三个 stream 完成后 await `trailingReasoning`；任一 stream 先失败时，已拒绝的 trailing Promise 无 handler，Node 会发 `unhandledRejection`。subagent 路径已把 trailing Promise 放在初始 Promise.all 内，不受此缺口影响。
- High finding 已由稳定红测直接复现并闭环：同一 turn 内让 text stream 与 message output 同时拒绝，旧 consumer 捕获 text error 后仍产生 `Error: message output failed` 的 `unhandledRejection`。最小修复把 trailing Promise 纳入初始四路 `Promise.all`；最窄 owner gate 1 file / 10 tests passed，待增量复审。
- 三条 review finding 的共同直接门禁为 adapter conformance、root consumer、subagent projection 3 files / 28 tests；typecheck 与 diff check 同时通过。当前 residual 仅为完整 focused/broad gate 与独立复审尚未执行。
- 完整 focused gate 已恢复为 8 files / 63 tests 并通过。consumer/projection 对 `AsyncIterable<unknown>`、`message.output`、`output.messages`、`call.output/status/error`、raw adapter helper 的扫描均为 0；全仓 `recordTaskEvent` 为 0，adapter 入口只在 executor 调用一次。
- Local Risk review 的同类时序已确认：adapter 在 root adaptation 时立即派生 `run.output`，executor 到三个 stream 消费完成后才 await；subagent output 也在 message/tool/nested-subagent streams 完成后才 await。同步失败红测稳定捕获 `run output failed` 与 `subagent output failed` 两个 `unhandledRejection`；2 files / 15 tests 为 13 passed、2 expected failures。
- 同一根因还覆盖 adapter 的同步 validation 顺序：`run.output` 在 `interrupted/interrupts` 之前派生，后者合同失败时 caller 无法取得并观察派生 rejection。第三条红测在 12-test owner gate 中稳定捕获 `run output failed during contract drift`。
- Output observation High 已闭环：root/subagent 在任何 callback 或 sibling stream await 前创建一元素 `Promise.allSettled`，但仍延后读取 settlement，保持原错误优先级和投影顺序；adapter 在全部同步 terminal validation 后才派生 output。3 files / 27 tests passed。
- Standards 候选的三条 tool terminal contract 分支已补直接 owner 证据：missing error、`running` non-terminal status、finished + unexpected error 均抛各自稳定 contract code；adapter 15/15 passed，未发现实现偏差。
- Spec 增量复审定位的 tool adapter ordering 已被组合红测确认：`adaptToolCall` 在确认全部三字段 Promise contract 前依次派生 output/status/error；rejected output + non-Promise status 时，status contract 同步失败后稳定捕获 `tool output failed during contract drift` 的 adapter 派生 `unhandledRejection`。adapter 16 tests 为 15 passed、1 expected failure。
- Tool multi-Promise ordering finding 已闭环：adapter 先读取并同步验证 output/status/error 全部为 Promise-like，再派生投影与 outcome；组合 owner gate 16/16 passed。
- 所有 review-fix 的共同门禁为 4 files / 41 tests；typecheck 与 diff check 同时通过。当前只剩最终双轴复审、完整 Risk 扫描和 broad gates。
- Final Spec reviewer 与 Local Risk 独立确认 tool outcome 仍有同类 High：root/subagent consumers 先执行 start event/todo callbacks，之后才 await `call.outcome`。production eventQueue overflow 可同步抛；若 outcome 同时拒绝，reviewer inline probe 稳定捕获 `tool output failed` 的 `unhandledRejection`。最小修复必须在任何 callback 前建立 settlement，同时保留 callback error 优先级。
- Tool outcome 两路 owner 红测已稳定为 18/20，分别捕获 `tool outcome failed` 与 `subagent tool outcome failed`；typed consumer finding 已确认。
- Typed tool outcome finding 已闭环：root/subagent consumers 在取得 call 后、任何 start/todo callback 前建立 settlement，并在原 await 位置读取，保留 callback error 优先级及 ordinary/contract 分类；2 files / 20 tests passed。
- Standards reviewer 进一步确认 adapter owner 不能把 raw rejected Promise 的观察责任退回 fixture：run/message/tool/subagent 四类都可在读取 promise-like 后、后续同步字段漂移时泄漏 rejection。修复必须让 adapter 对已识别 Promise 立即建立非拒绝 settlement，再继续可能抛出的同步校验；测试必须删除 raw Promise 的预 catch。
- 四类无预 catch 红合同已稳定：adapter owner 1 file / 18 tests 为 14 passed、4 expected failures，具体捕获 run/message/tool/subagent 各自的 `... output failed during contract drift`。修复需保留既有字段 contract error 优先级，不能靠提前抛 output error 回避 sibling drift。
- Adapter four-owner finding 已闭环：run/message/tool/subagent 在 capture 到 Promise-like 字段时立即建立非拒绝 settlement；missing/non-Promise 仍在原字段校验位置抛原 contract code；每个投影 Promise 与 tool outcome 也被立即观察但保留原 rejection。owner gate 18/18 passed。
- 全部 rejection-observation review fixes 的共同门禁为 4 files / 45 tests；typecheck 与 diff check 同时通过。当前 residual 仅为最终双轴复审、完整 Risk 扫描与 broad gates。
- 完整 focused gate 已恢复为 8 files / 74 tests 并通过；Final Spec rereview 为 `No findings`，确认 adapter/contract owner 收敛完整且无 Stage 7.4、依赖、IPC/UI scope creep。
- 四个 rejection owner 文件的 45-test gate 连续三轮通过；event-loop regression 未表现出时序波动。Local Risk 残余扫描暂未发现新 finding，待 strict unused 与最终 Standards 结果收口。
- Strict unused 新鲜通过；删除的 legacy helper/callback 与新增 adapter DTO 没有留下本次引入的 unused symbol。
- Final Standards 与 Spec 增量复审均返回 `No findings`；Local Risk 对 Promise ownership、error priority、usage/final-output、queue/backpressure、递归 projection 与残余 shape 的复核也未发现新问题。剩余风险仅为 broad gates 尚未执行。
- Broad full Vitest 暴露此前 focused/fake run 未覆盖的 HITL High：LangGraph 1.4.7 `GraphRunStream.interrupted` 与 `interrupts` 是转发到 `StreamMux` 的动态 getter，pump 只有在消费到 interrupt values chunk 后才调用 `markInterrupted()`。adapter 若在 `streamEvents()` 返回时快照，会永久保留初始 `false` / `[]`。
- 真实失败链为：三个投影 stream 完成后 typed run 仍报告未中断，executor 进入 non-interrupt 分支并等待不会在暂停态结算的 `run.output`，因此 runtime 20 秒内收不到两个 `run_interrupted`。这不是测试超时不足或 full-suite 资源竞争；有效单文件同样 1/1 失败。
- Dynamic terminal finding 已红绿闭环：adapter 适配时先验证 raw terminal 字段，DTO 的 getter 在消费后重新读取、校验并映射 interrupt；raw handle 不泄漏到 consumer。直接动态合同 1/1、production 双中断/两次 resume 1/1、扩展 focused 9 files / 76 tests、typecheck 与 strict unused 通过。
- Dynamic terminal 增量 Standards / Spec review 均为 `No findings`，Local Risk 为 `No issues found`。当前 LangGraph 1.4.7 在 mux finalize 前同步更新并固定 terminal state，三个投影 stream 关闭后读取稳定；`run.output` 无论 pending/rejected 都已由早期 settlement 观察。
- 最终 broad gate 通过：`check:ipc`、最终 build、322 files / 1804 full tests、agent performance smoke 1/1、typecheck、strict unused 与 diff check。Residual 仅为 final-output helper 对稳定 DTO getter 的两次读取未固定单次快照语义；当前包下不构成行为缺陷。

## Stage 7.4 Performance Tuning Scope

- Stage 7.3 已在完整 review、focused/static/broad gate 与 staged-boundary 审计后独立提交为 `e94a7fc`；提交后工作树仅剩未跟踪规格源 `plan.md`。
- `plan.md:670-678` 是唯一性能调优规格：per-run agent/RTK 构造、provider model 复用、system/tool prompt 重复、selected skill/capability canonical ordering + fingerprint、event delta/UI 流畅度五个候选都必须先由指标证明。
- 本 part 的 no-change 是有效结论：若现有 artifact 不显示成本、候选无法安全隔离 secret/config version，或收益无法稳定复现，则保留当前 owner，不以理论优化或名字相似为依据改代码。
- 行为等价边界固定为 frozen run snapshot、provider/config/secret version、prompt/tool/capability 语义、event 顺序/backpressure、usage/terminal 结果与 restart/HITL；性能改动不能以弱化这些合同换取指标。
- Construction ownership 首轮 CodeGraph：`createAgentDeepAgentExecutor.execute()` 每次 invocation 都调用 `buildDeepAgent()`；`createExecutionSafetyMiddleware()` 为其构造路径直接创建 `new RTKBinaryManager()`。同一 durable run 的 initial/HITL resume/recovery 可能多次 invocation，因此这是可测候选，但当前尚无耗时或分配证据。
- Provider ownership 首轮 CodeGraph：`LangChainAgentModelFactoryAdapter` 的 default 与 provider/model 两条路径每次都先调用 `beforeCreate`，再向 `LangChainModelFactory` 创建新 handle。该 boundary 很可能承担 settings/secret refresh；在读取 factory 实现和版本语义前，不允许按 provider/model key 复用实例。
- 现有 `MetricsService` 只有通用 histogram/gauge/counter 与 prompt-cache token 指标；但 deterministic agent performance smoke 已直接覆盖 `agent_build`，首轮 CodeGraph 截断造成的“artifact 是否覆盖 build 待确认”判断已由 runner 与当前 artifact 纠正。
- 当前 `.artifacts/wave1/agent-performance-smoke.json` 中 `agent_build` P95 为 `17.2894ms`，低于 baseline `17.6593ms`（ratio `0.9791`）和 `50ms` absolute max；没有指标证明 per-run build/RTK 构造值得改变 owner 或生命周期。
- 同一 artifact 的 `event_queue` P95 为 `0.2592ms`，低于 baseline `0.9444ms`（ratio `0.2745`）；`iterations_10` P95 为 `137.0611ms`，低于 baseline `146.6721ms`（ratio `0.9345`），artifact 总体 `passed: true`。backend queue 当前没有调优证据，UI 流畅度仍需读取独立 renderer smoke/measurement owner。
- Construction source 进一步确认 `createExecutionSafetyMiddleware()` 在 `buildDeepAgent()` 内为 main/subagent safety chain 各自传入 `new RTKBinaryManager()`；但该构造已包含在总 `agent_build` 测量路径内，不能脱离总成本与生命周期状态，仅凭“每次 new”提升为 plugin-scope owner。
- Prompt block owner 已存在逐 block 的 SHA-256 内容 hash（16 hex），其中 tools 与 explicit skills 通过输入数组直接 `map` 生成；block builder 自身不排序。是否需要 canonical sort/fingerprint 取决于上游 capability/skill resolution 是否已稳定排序，以及现有 hash 是否进入持久化/metrics/cache owner，仍需追踪。
- `RTKBinaryManager` 只有构造时解析的 immutable `binaryPath`；`isRTKAvailable()` 每次仍执行文件存在/权限检查。`createRTKMiddleware()` 又在 middleware 构造时读取 path/availability 并创建独立 `CommandRewriter`，所以单独把 manager 提升到 plugin scope 不会复用 rewriter 或消除主要配置工作。
- 候选 1 结论为 **no-change**：完整 `agent_build` P95 已优于 baseline，manager 本身没有被独立证明为瓶颈，且只复用 manager 不改变每个 middleware 的 rewriter 构造。当前 owner 简单且符合 per-build isolation，不新增 plugin-scope singleton。
- Model bootstrap 已确认 `LangChainModelFactory` 本身是 kernel-scope，但 `LangChainAgentModelFactoryAdapter.beforeCreate` 在每次 agent model create 前调用 `configService.reloadSettingsDocument()`；model handle 缓存若绕过 adapter create，会直接跳过已存在的配置刷新边界。secret 的读取时机仍需从 factory 精确源码确认。
- Capability owner 已存在 `RunCapabilityManifestV1.manifestHash`：compiler 先 normalize requested MCP/skill IDs、解析 selected capabilities/tools/skills，再对不含 hash 的完整 manifest `JSON.stringify` + SHA-256。run snapshot 持久化整个 manifest，因此 selected capability fingerprint 已有 durable owner，不应另建平行 key。
- `loadExplicitSkillContexts()` 按 frozen `explicitSkillIds` 顺序映射已授权 manifest skills；prompt block 再按该顺序序列化。这一顺序可能是用户请求语义，而不是可任意排序的数据；需核实 `normalizeCapabilityIds` 与 snapshot creation 是否已 canonical，并区分 selected capability set 与 explicit skill request order。
- Model handle 精确链为 `adapter.beforeCreate -> configService.reloadSettingsDocument -> LangChainModelFactory.create* -> createModelForProvider -> resolveCredential -> SecretService.getProviderSecret`。每次 create 都重新解析当前 provider/model config，并从磁盘读取、解密当前 provider secret；`LangChainChatModelHandle` 同时持有 provider snapshot 与已配置 model instance。
- 候选 2 结论为 **no-change**：当前没有 model construction latency 或 allocation 指标；按 provider/model key 缓存 handle 会绕过 config reload/secret read，并把旧 endpoint/options/credential 固化到后续 invocation。保持 per-invocation handle creation 是明确的 version/isolation boundary。
- Capability normalization 的当前合同是 trim + stable dedupe，保留第一次出现的请求顺序；explicit skill IDs 同样保序。manifest tools/skills 依照该解析顺序生成，所以 `manifestHash` 对等价集合的不同输入顺序敏感。
- Prompt capability block 已由 `createCapabilitySummary()` 对 MCP server IDs 与 skill IDs 各自排序，因此等价 selected set 的 prompt 文本与 block hash 已稳定；explicit skills block 仍按 frozen request order，保留用户显式选择顺序。
- `PromptBlock.hash` 当前由 serialization 写入每个 prompt block 的 HTML comment，未发现独立 composite prompt fingerprint consumer；manifest 另有 durable full hash。是否需要进一步 canonicalize manifest 或增加 fingerprint，只能由 cache read/creation/input-token 指标证明，不能仅因 hash order-sensitive 改 frozen contract。
- Prompt cache telemetry 已存在：executor 把每次 usage 的 input/cache-read/cache-creation tokens 交给 in-memory `MetricsService`，记录 `prompt_cache_read_tokens`、`prompt_cache_creation_tokens` 和 `prompt_cache_hit_ratio`。它没有进入 deterministic performance artifact，当前也没有跨运行 token baseline 或稳定 provider cache sample。
- 当前 agent performance artifact 使用 `RocPerformanceFakeModel`、network disabled，只测 11 个 duration metrics 与行为 evidence；它不能证明真实 provider 对 system/tool description 重复的 input-token 或 cache miss 成本。
- 候选 3 结论为 **no-change**：缺少稳定 token/cache 成本基线；贸然缓存/改写 system prompt 或 tool description 会改变 provider input 与 run snapshot 行为，不能用理论上的重复成本授权修改。
- 候选 4 结论为 **no-change**：selected capability prompt 已 canonical sort，prompt blocks 已有内容 hash，capability manifest 已有 durable SHA-256；未排序的 manifest/explicit-skill 顺序属于 frozen request contract，且没有 cache/token evidence 证明其造成成本。不新增 parallel fingerprint，也不重排持久化 snapshot。
- Event delivery owner 当前对每个 `ChatRunEvent` 执行 `persistChatRunEvent()` 后 `await publish()`，显式把 durability、顺序和 subscriber backpressure 串联；renderer `applyChatRunEvent()` 收到每个 `assistant_block` 后立即应用 block 并返回新 state。
- Transcript rendering 已使用 `react-virtuoso`，现有 `requestAnimationFrame` 测试覆盖流式更新/滚动行为，但尚未证明它在 IPC/reducer 层合并 delta。若新增 merge window，会同时改变持久化 event 粒度、发布 backpressure、终态 flush 与 UI update cadence，必须先有 UI frame/long-task evidence。
- `src/main/terminal-output-batcher.ts` 只按 terminal session 合并原始终端输出，调用方是 main window terminal IPC；它不在 Agent `assistant_block` 路径上，不能作为 chat delta 已批处理或可复用的证据。
- `.artifacts/wave1/performance-smoke.json` 的 UI profile 覆盖 1k/10k 历史事件、interactive time、prepend latency、DOM virtualization row count 与进程内存；10k profile 仍只渲染 15 个 DOM message rows。该 artifact 是否覆盖 live delta cadence/long tasks，需以 runner 精确 measurement 定义为准。
- 当前 UI performance artifact 为 `passed: true`：1k/10k profile interactive 分别为 `368.9942ms` / `343.1448ms`（门限 `750ms` / `1000ms`），renderer ready 为 `1750.9251ms` / `1792.0388ms`，DOM message rows 都是 15（10k 门限 `<300`），RSS `219.5MB` / `229.7MB` 且未超 `500MB` budget；10k prepend P95 为 `210.8861ms`（门限 `250ms`）。
- 候选 5 结论为 **no-change**：backend `event_queue` P95 已显著优于 baseline，长 transcript UI gate 通过，且没有 live delta frame/long-task artifact 证明卡顿。新增 merge window 会改变 durable event 粒度、严格顺序、terminal flush 与 subscriber backpressure，不以未测收益承担该行为风险。

### Stage 7.4 Candidate Decision Matrix

| Candidate | Current evidence | Isolation / behavior boundary | Decision |
|---|---|---|---|
| per-run agent / RTK construction | `agent_build` P95 `17.2894ms` vs baseline `17.6593ms`；manager 复用不复用 rewriter | per-build middleware/safety owner | no-change |
| provider model instance reuse | 无 construction latency baseline | 每次 reload config、读取 secret，handle 绑定当次 provider/model/credential | no-change |
| repeated system/tool prompt cost | 只有运行中 cache token metrics，无稳定 artifact/baseline | prompt 内容与 provider input 必须保持不变 | no-change |
| canonical skill/capability + fingerprint | capability prompt 已排序；block hash + durable manifest hash 已存在 | manifest/explicit skill 保留 frozen request order | no-change |
| event delta merge window | queue P95 `0.2592ms`；1k/10k UI smoke passed，无 live-delta jank evidence | durable ordering、terminal flush、backpressure、transcript 完整性 | no-change |
