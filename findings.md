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
