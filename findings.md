# Roc 架构优化发现

## 已验证事实

- 仓库存在 `.codegraph/`，理解或定位代码时先用 `codegraph explore`。
- `package.json` 证明基础门禁为 `pnpm typecheck`、`pnpm test`；IPC 变更另有 `pnpm generate:ipc` 和 `pnpm check:ipc`。
- 开始时 `git status --short --branch` 为 `main...origin/main [ahead 38]`，仅 `plan/` 未跟踪。
- `plan/00-overview.md` 定义 9 个阶段，推荐依次执行 1 至 8，阶段 9 可插入。

## 待验证计划结论

- Interrupt 在 vendor、运行时事件、pending state、数据库/checkpoint 间存在多重形状。
- session repository 直接跨越 checkpointer、tool effect store、run event log 的 seam。
- executor/runtime 通过重放 UI 事件反推最终消息、interrupt 和 usage。
- IPC channel、capability 和 payload contract 存在重复事实源。
- stream adapter 泄漏 vendor 形状，主任务与 subagent 投影重复。
- task repository 聚合和 capability 注册存在浅转发与下标耦合。
- shell 安全规则在多个层级重复实现。
- 插件数据库 facade 可能破坏隔离 seam。
- 若干死代码/微转发文件需通过调用关系和 strict unused scan 证明后处理。

## 决策记录

- 每阶段 fixed point 取阶段开始时 HEAD；未提交工作树 diff 作为审查对象，满足“审查后再提交”的用户顺序。
- 子代理审查分 Standards 与 Spec 两轴；主代理汇总、修复并复验。

## 阶段 1：Interrupt 生命周期

### 已验证

- `AgentDeepAgentExecutor.execute()` 当前 interface 只返回 `AsyncIterable<ChatRunEvent>`；结构化结果不能直接回到 runtime。
- `deep-agent-final-output.ts` 的 `normalizeChatInterruptPayload()` 同时承担 vendor payload 归一化，`readRunInterruptedEvents()` 再将其变为 `run_interrupted` 事件。
- `runtime.ts` 的 `resolvePendingInterrupts` 依赖 repository 的 pending interrupt 读取；CodeGraph 未找到该函数和 `executeDeepAgentRun` 的直接测试覆盖。
- 阶段 1 保持 resume 三段式 dispatch 在 runtime；本阶段只收敛 interrupt 领域形态、投影和消费路径。
- `AgentSessionRepository.getPendingInterrupts()` 直接查询 `agent_pending_interrupts`，按 `position` 返回；`beginResumeDispatch()` 在同一 DB 事务中先转换 run 状态再校验 pending interrupt。
- `AppShell` 的 `run_interrupted` 全量刷新作用于 task snapshot/task surface，而非 chat transcript；删除会影响 task workbench 同步，除非有独立增量投影替代。
- Pending interrupt SQL 分散在 run completed/cancelled/failure 清理、interrupt 记录、resume commit、restart projection 恢复、读取与校验等路径；这些操作共享 repository 的 SQLite 事务。
- renderer 的 live state 与 transcript 最终都使用 `ChatPendingInterrupt[]`，可把 upsert/remove 收敛为共享纯函数，不需要引入第二个领域形态。

### 待确认

- repository 中 live/persisted/checkpoint 三条读取路径的真实优先级与事务语义。
- renderer 两套 reducer 是否能共享纯函数而不改变 message/run state 的其他行为。
- `AppShell` 全量刷新是否仍承担除 interrupt 以外的 transcript 同步责任。

### 设计约束

- Interrupt 模块必须保留 repository 事务内的 pending 校验/消费能力；不能在事务外做 read-then-write。
- 阶段 1 暂保留 `AppShell` 对 task run terminal/interrupted 的刷新，除非测试证明 task snapshot 已由事件完整增量维护。
- 主进程新模块应是同一 DB 上的 adapter，并由 `AgentSessionRepository` 组合；repository 的 run 状态事务继续作为外层编排，interrupt adapter 提供可在该事务内调用的同步方法。
- 为满足“runtime 不再从事件流反推 interrupt”且不制造临时 seam，executor interface 采用稳定的 execution module 形状：`events` 负责 UI 增量，`outcome` Promise 负责结构化结果。本阶段 outcome 至少含 interrupts；阶段 3 在相同 interface 上加深 final message/usage。
- `ChatRunEvent` 仍可发 `run_interrupted` 给 UI，但 runtime 的持久化/状态转换必须读取 outcome，而不是捕获该事件。
- production executor 的 outcome 使用 completed/interrupted 判别联合；阶段 1 completed 分支只表达完成状态，interrupted 分支持有唯一 `PendingInterrupt[]`。
- runtime 在阶段 1 仍从增量事件聚合 assistant text/tool names；阶段 3 将这些字段迁入同一 outcome，不改变 execution seam。
- renderer 共享模块只负责 `ChatRunEvent`/persisted `TaskEvent` 到 `ChatPendingInterrupt` 的归一化及集合投影，不接管 transcript/run state 其他字段。
- 约 20 个 main 测试文件构造 `AgentDeepAgentExecutor` fake；interface 改动需要集中测试 helper，避免每个测试复制 execution/outcome 装配逻辑。
- `session-repository.test.ts` 已覆盖 record/read/consume、事务回滚和 checkpoint 重建；阶段 1 应把 projection 细节断言迁到新模块直测，repository 只保留事务编排断言。
- LangGraph checkpoint interrupt 当前持久化格式为 `channel='__interrupt__'`、`value_type='json'`、blob `{ id, value }`；阶段 1 projection 必须原样读取并过滤已有 resume audit 的 interrupt id。
- Projection 接线后 repository 事务回滚、checkpoint 重建、corrupt payload 和 resume consume 29 项回归通过；renderer live/persisted 投影 28 项回归通过。
- execution 同时暴露 `events` 与 `outcome` 时，事件流异常可能绕过 outcome Promise；工厂必须立即注册 rejection handler，runtime 在异常/取消边界消费 outcome 后继续抛出原事件流错误，避免未处理 rejection 且不吞业务错误。
- 事件消费者主动停止时，production executor 的 `finally` 也必须将 producer 错误写入 outcome；仅 abort producer 并吞掉 rejection 会留下永久 pending Promise。
- question interrupt 的可选 `context` 与 `suggestedResponses` 必须完整校验并重建规范对象，避免 unknown 字段或错误类型进入 DB/renderer。
- checkpoint 恢复不能把损坏的 pending projection 当作空集合静默覆盖；损坏状态应 fail-explicit，缺失 projection 才允许重建。
- `PendingInterrupt` 的唯一类型入口为 `interrupt-projection.ts`；`runtime-types.ts` 不保留转导兼容路径。
- 阶段 1 最终验证：目标 72/72、全量 1811/1811、typecheck、strict unused、diff check 均通过；双轴复审 PASS。

## 阶段 2：Repository 跨 seam SQL

### 设计决策

- `agent_run_events` 容量语义统一为 trim：保留最近 `agentRunEventLogMaxEvents` 条事件，避免缓存容量成为业务运行故障。
- checkpoint 读取方法放在我方 `RocSqliteCheckpointer`，不扩展 LangChain 基类契约。
- tool-effect restart 转移由 `AgentToolEffectStore` 拥有；repository 不直接更新其表。

### 已验证

- `RocSqliteCheckpointer.readPendingInterrupts()` 保留 `value_type` 分支，并把单条 JSON 数组展开为多个 interrupt。
- `AgentRunEventLog.restoreRunEvent()` 恢复持久化 sequence 时同步 cursor；恢复 sequence 7 后下一条 append 为 8。
- `AgentSessionRepository` 通过可注入的 checkpointer、tool-effect store、run-event log 和 interrupt projection 组合行为，不再持有三张 owner 表的裸 SQL。
- production plugin 初始化让 repository 与 runtime 共享同一个 `AgentRunEventLog`。
- 首次 Spec 审查指出 history deletion、retention、database rebuild 仍旁路 owner；修复后三个 owner 暴露最小维护 API，基础设施仅选择集合与编排事务。
- `storage-ownership.test.ts` 对生产源码执行 SQL ownership 静态扫描；schema DDL 与数据库 fast probe 不被误判为 operational SQL。
- `session-repository.test.ts` 相对 `79d8aa0` 为 111 行新增、155 行删除，净减少 44 行。
- 最终验证：聚焦 7 文件/29 项、全量 324 文件/1818 项、typecheck、strict unused、diff check 均通过；Standards/Spec 复审 PASS。

## 阶段 3：结构化 RunOutcome

### 设计决策

- execution seam 继续使用阶段 1 建立的 `events + outcome`：events 只承载 UI 增量，outcome 是 completed/interrupted 业务结果的唯一来源。
- completed outcome 持有 `finalMessage`、成功 tool name 摘要素材和 usage；interrupted outcome 持有领域 interrupt 与 usage；失败和取消均无 outcome 值。
- hook echo 在 assistant delta 收集时只从前缀消费，禁止完成后的全局字符串替换。
- 内部 mode 定为 `run | plan | task`；IPC request/result 保留 `chat | plan | task`，转换只发生在 snapshot 创建和请求重建边界。

### 已验证

- runtime 已删除 assistant 文本、成功 tool name 和 hook 文本的事件重放累积；摘要直接使用 outcome 的 `finalMessage` 与 `summarySource`。
- event projection 失败时会等待已结算 outcome 并补记 completed usage；outcome rejection 不覆盖原始 projection error，失败部分 usage 由 callback 保留。
- executor 的空模型响应检查使用权威文本与成功 tool/hook 投影；空结果失败码仍为 `agent_model_response_empty`。
- live `run_started` 使用 snapshot mode，replay 读取同一内部 mode；测试证明二者完全相等，同时 `ChatStartRunResult.mode` 仍为入口 `chat`。
- 生产代码中的 `toChatRunMode` 只剩 `run-execution-snapshot.ts` 的定义与 `createChatStartRunRequestFromSnapshot` 调用。
- helper 行数从 735 降至 487，默认 outcome 被删除，测试 fake 必须显式声明 completed/interrupted/failed 语义。
- 最终验证：聚焦 58 文件/358 项、全量 324 文件/1820 项、typecheck、strict unused、diff check 均通过；Standards/Spec 最终复审 PASS。

## 阶段 4：IPC 契约单源化

### 已确认

- 2026-08-17 续跑复核阶段规格：现有 registry/双生成物只完成传输元数据单源；验收仍要求每个 channel 的 request/response/event payload 由 Zod 单源推导，并删除 Agent 本地重复 schema，不能以 phantom TypeScript contract 代替运行时契约。
- Agent harness 参考明确要求 HITL payload 可 JSON 序列化、resume 使用稳定 thread/run identity、trace 保留请求/运行/线程关联与脱敏审计字段；因此共享 schema 应拒绝 `undefined` 等非 JSON 值，并完整表达 resume/replay/snapshot/LangSmith 边界，不改变既有运行流程。
- CodeGraph 续跑确认 `src/shared/types/agent.ts` 仍平行手写 manifest/snapshot/preview/LangSmith 类型，main 侧再定义运行时 schema；`ChatRunEvent` 被 runtime 与 renderer 广泛消费。迁移应保留既有 shared type 导出路径，但实现改为共享 schema 的 `z.infer`，以免把内容契约收敛误变为调用方行为重写。
- `plugins/agent/index.ts` 的 capability descriptor 已接受真实 Zod input/output，可直接改为复用 shared schema；当前重复 parse 与 handler `as` 可同步删除。`ChatRunEvent` 的 tool input/output/error 手写为 `unknown`，应优先复用已验证的 TaskEvent JSON-safe block schema，拒绝再建宽松事件验证。
- `shared/schemas/task-event.ts` 已拥有严格的 assistant block、subagent identity/event、hook summary 与 JSON-safe tool payload schema；新的 chat contract 可直接复用。`shared/schemas/agent.ts` 当前仅有 capabilities，可承载 manifest/snapshot/preview/LangSmith 基础 schema，使 `schemas/chat.ts` 单向依赖它并避免循环导入。
- 当前 approval 归一化只验证 `actionRequests`/`reviewConfigs` 是数组，但 renderer 实际依赖 action 的 `name/args` 与 review config 的 `actionName/allowedDecisions`；这是假验证。共享 HITL schema 应精确定义这些字段，并用 `z.record(z.string(), z.json())` 约束 action args，拒绝含 `undefined` 的非 JSON 输入。
- LangChain 1.5.3 声明确认 ActionRequest 的可选 `description`、ReviewConfig 的可选 `argsSchema` 及 approve/edit/reject decision；依赖类型内部使用 `any`，但 Roc 的 IPC/DB 边界可并应收紧为 JSON 值，仍保持结构兼容并满足 LangGraph JSON 序列化契约。
- snapshot/LangSmith 本地 schema 无 main-only 依赖，可迁入 shared；V1→V2 migration、manifest hash 校验和稳定错误码仍应留在主进程，schema 只拥有结构约束，不吸收领域迁移行为。
- LangSmith trace session 的结构 schema 含 `rootId === traceId` 完整性约束，而 correlation matching、trace 生命周期和 redaction 属于 service。共享层应拥有 session/correlation schema 与 `z.infer` 类型，repository/tracing service 共同消费，消除“类型在 service、schema 在 repository”的反向依赖。
- `ipc-registry.ts` 的 `methodContract/eventContract` 当前在运行时返回 `undefined`，生成器仅消费路由元数据；这不是内容契约。目标应改为真实 Zod args/result/payload 对象，并由 schema 推导 preload 类型；生成器需从单文件 `transform` 切换为 bundle 加载以解析 registry 的运行时 Zod imports。
- `preload-contract.test.ts` 仍手写 domain/method 树，只证明生成物匹配另一份手写期望；阶段验收要求改为从 `ipcRegistry` 推导方法树，并给 Agent request/result/event schema 加正反解析用例。
- direct IPC 注册分散在 `register-ipc.ts` 与 window/settings/shell/workspace/files 模块，plugin IPC 则有统一 adapter。是否能在统一 `timedHandle` 执行 registry parse 需结合 `IpcResult` 包装顺序确认；不得只给 registry 挂 schema 而完全不在真实边界消费。
- `register-ipc.ts` 的 `timedHandle` 覆盖所有 request，可按 channel 对 Electron event 后的 args tuple 解析，并仅验证 `IpcResult.ok === true` 的 data；解析异常需转换为现有 `IpcResult` 错误。这样 direct/plugin 共用 contract，adapter 只负责 capability 输入形状变换。
- 七类 renderer IPC event 均从 `main/index.ts` 经 `sendToWindow`/`broadcastToWindows` 发出；若 helper 只服务 IPC channel，可在发送前统一按 registry event payload schema 解析，确保 `chatRunEvent` 等事件契约真正执行。
- 两个发送 helper 位于独立 `src/main/window-messaging.ts`，当前生产调用均来自 registry 的七类 renderer event，适合作为发送前统一 schema 解析边界；仍需保留窗口销毁与批量广播现有语义。
- `window-messaging` 可在 destroyed-window 短路之后、实际 send 之前验证 event payload；广播复用该函数即可。现有测试用 `{ type: 'message' }` 伪造 chat event，需替换为完整合法事件并新增损坏 payload 抛错断言。
- 未找到共享 JSON value 归一化器；stream/subagent 生产者可直接以 shared `toolCallAssistantBlockSchema.parse()` 作为构造边界，既验证 vendor/tool payload 可序列化，又避免新增宽泛 helper 或类型断言。
- 全量 IPC runtime contract 采用按 domain 的 shared schema 模块；app/task 结构可严格表达，TaskSnapshot/History/Detail 的事件字段直接复用 `taskEventSchema`/`persistedTaskEventSchema`，不得退回 `payload: unknown`。
- common/performance/diagnostics/metrics 传输值均可严格 JSON 建模；`diagnostics.getMetricsSnapshot` 的 args schema 必须保留 0 参数或单个 optional filter 的 tuple 语义。
- 阶段 fixed point 为 `fc6b95e`；当前工作树开始时干净。
- 权威计划要求 zod schema 成为 request/response/event payload 唯一事实源，生成 channel 常量、preload 转发和 channel-to-capability 映射。
- 阶段验收额外包含 `pnpm generate:ipc` 与 `pnpm check:ipc`；新增 channel 必须只改 schema 一处。
- 当前计划指出四类重复：手写 `RocPreloadApi`/preload 转发/adapter 映射、task event unknown payload 与 renderer duck guards、agent request 平行 zod、usage 五元组多点定义。
- CodeGraph 当前调用图确认 `RocPreloadApi` 约 145 行、26 个消费者；`ChatStartRunRequest` 有至少 79 个调用点，属于高影响共享合同。
- `ipc-generated.ts` 当前只生成 101 个 channel 常量及 request/event key 列表，不生成 preload API 或 capability metadata。
- `plugin-capability-adapter.ts` 当前另维护约 100 条 `domain/preloadMethod/channel/capabilityName/input` 映射；并非全部 IPC 都走 plugin capability，schema 必须显式区分 plugin request、direct request 和 event。
- `RunExecutionSnapshotV1/V2` 与 `run-execution-snapshot.ts` 的 zod schema 确实平行维护；阶段 4 需要从真实 schema 反推类型，不能只移动文件。
- 多数 plugin capability 已有 zod input schema，但定义分散在各插件 `index.ts`；agent/task 最集中，且仍有 `z.custom`/`z.unknown` 弱 schema。
- `chat-transcript.ts` 当前有 45 处 `Reflect.get`，覆盖 message、content block、hook、subagent、interrupt 等 payload guard；应由共享 payload schema 解析取代。
- `TaskEvent` 当前是 `{ type: 30项 union; payload: unknown }`，54 个消费者；持久化 mapper 对 `type` 与 JSON payload 均直接断言，未通过 schema。
- agent outbox 投影只接受 8 类 UI 事件（tool/assistant/guardrail/subagent/hook/approval），背景任务 repository 还写入 lifecycle 类事件；共享 task event schema 必须覆盖全部 30 类或明确缩小合法事件类型，不能只为 renderer 子集建假联合。
- `agent-run-payloads.ts` 已用约 250 行 `Reflect.get` 重建 agent outbox payload；与 renderer duck guards 属于同一契约重复，可共同迁移至共享 zod parser。
- hidden adapter 语义已定位：`chat.startRun` 删除 `shellAllowedCommands`；`shell.execute` 删除 `signal` 与 `allowedCommands`；字符串 id 被包装为 `{ id }`/`{ runId }`；optional arg 空调用变 `{}`。这些必须迁入对应 capability input schema/registry transform，并保留原因注释。
- `chat-transcript.ts` 实际只展示 message、assistant_block、hook、subagent、guardrail 和 interrupt 投影；共享 parse 后 renderer 可按 discriminated union 直接缩窄，删除 45 处 duck guard，不改变其他事件忽略语义。
- plugin capability registry 已在调用时 parse input/output；IPC registry 应复用同一 schema 对象，避免 transport 与 capability 各写一份。
- usage 五元组至少在 stream adapter、accumulator、run telemetry、executor 映射中重复；共享值对象需覆盖 nullable 语义，避免改变部分 usage 的累积行为。
- 项目直接依赖 `esbuild`、zod 4.4.3、TypeScript 7.0.2；生成器可通过现有 esbuild 加载 TS registry，无需新增依赖。

### 待确认

- schema 源模块如何在生成脚本中加载，同时保持 Electron main/preload/renderer 构建边界。
- capability 输入裁剪分别由哪些 schema 拥有，哪些字段应显式拒绝或 strip。

### 当前验证结论

- 主进程边界接线后聚焦测试 88 项中 14 项失败，均由严格 TaskEvent 解析拒绝含 `enabledCapabilities` 的持久化 payload 触发；说明共享契约尚未覆盖已有生产事件形状，不能通过放宽为 unknown record 解决。
- 同批 `pnpm typecheck` 已通过，失败位于运行时数据契约而非静态类型。
- `message` 事件的 user 分支真实持有可选 capabilities/attachments；assistant 分支虽无 renderer 读取方，但 repository 契约测试明确要求保留 provider/model 审计元数据，因此共享 schema 将其作为必填字段，旧弱类型测试夹具同步补全。
- usage 五元组的权威字段应为 `inputTokens/outputTokens/totalTokens/cacheReadTokens/cacheCreationTokens` 且均为 `number | null`；stream accumulator 的 `promptTokens/completionTokens` 只是内部别名，telemetry 的 `callCount/reportedCostUsd` 不属于该值对象。
- IPC TS registry 的生成必需字段为 `key/channel/domain/method/kind`；plugin request 另需 `capabilityName/inputTransform`，event 需订阅 method。`inputTransform` 必须显式覆盖 none/first/optional/id/chat-omit/shell-omit，不能把裁剪继续藏在 adapter。
- plugin request/response 的运行时 zod 已由 capability descriptor 负责；direct request/event 需在 shared registry 拥有 schema。生成物负责转发与路由元数据，不把类型契约退化为 JSON 中的字符串。
- 当前 `esbuild` 仅作为 Vite 的传递依赖存在，根包不可 import，`pnpm exec` 还指向缺失的 0.28.0；TypeScript 7 根包只导出版本信息。TS registry 生成器需要把锁内 0.28.1 提升为直接 devDependency。
- Agent 内容契约重复的真实位置：`run-execution-snapshot.ts` 重写 capabilities/manifest/V1/V2；`plugins/agent/index.ts` 重写 start/resume/replay/LangSmith capability schema；LangSmith trace session 类型和 DB schema 分居 service/repository。共享 schema 应让 main 侧只组合/解析，不再 `satisfies` 平行手写类型。
- 2026-08-18 续跑确认：`src/shared/schemas/ipc-core.ts` 尚未被 `ipc-registry.ts` 引用，因此当前 `pnpm typecheck` 通过只证明该新增文件自身可编译，不能证明 IPC runtime contract 已接线。
- CodeGraph 重新定位确认 `methodContract()` / `eventContract()` 仍返回 `undefined as never`；`register-ipc.ts` 与 `window-messaging.ts` 尚未统一执行 request args/result 与 event payload 解析。阶段 4 必须完成全部 channel 的真实 schema 与两端边界解析，部分真实、部分 phantom 不构成终态。
- `ipc-core.ts` 已覆盖 app/window/task/lifecycle/diagnostics 的大部分值对象，可作为第一批 registry contract；其余 memory/settings/hooks/mcp/skills/workspace/files/git/terminal/rtk/shell 需要从现有 shared 类型与 capability descriptor 迁移，agent/chat 则复用本阶段已建 schema。
- 当前生成器只用 esbuild `transform()` 编译 registry 单文件；真实 registry 一旦导入 Zod/schema 就会留下无法从 data URL 解析的相对 import。生成器必须改为 bundle 模式并从临时输出加载，或使用等价的完整模块图加载方式。
- `preload-contract.test.ts` 仍手写 18 个 domain/method 树；`window-messaging.test.ts` 当前证明任意 channel/payload 都会发送。阶段目标测试应分别改为从 registry 推导树，以及验证 event channel/payload 在发送前被同一 contract 解析。
- 各插件 descriptor 盘点确认：memory/workspace/skills 等已有部分 input Zod，但 output 多数仍是 `z.custom<T>()`，mcp 甚至保留 `z.array(z.unknown())` 的非 IPC capability；这些不能作为 IPC runtime result contract。shared schema 需定义真实输出形状，IPC 范围外 capability 不随本阶段扩张。
- 现有 plugin object schema 大多默认 strip 未知字段；阶段 4 shared IPC schema 将按项目 fail-explicit 约束使用 `.strict()`。保留既有数值整数、枚举与 optional 语义，不保留静默 strip。
- 运行时边界已接线：`executeIpcRequest()` 在 handler 前解析 renderer args、在成功返回后解析 data；`window-messaging.ts` 限制 registry event channel 并在实际发送前解析 payload。
- 规格扫描 fresh 结果：task event 路径无 `z.unknown()`，`chat-transcript.ts` 无 `Reflect.get`；usage 五元组以 shared `tokenUsageSchema`/`TokenUsage` 为事实源，其余匹配均为累加或 provider 字段映射。
- 剩余单源缺口：MCP service/plugin、hook config schema，以及 app/diagnostics/skills/task/runtime-tools/workspace 的 IPC-facing capability descriptors 仍存在平行 schema 或 `z.custom`。
- 2026-08-18 本轮恢复核对：上述单源缺口已在当前工作树完成迁移；交接所述剩余阻塞仅为 7 个文件中的旧类型 import 未清理，属于 schema 单源迁移后的静态残留，不涉及运行时行为。
- 首次全量门禁暴露的 3 项失败中，真实边界没有授权漏洞：`chatStartRunIpcRequestSchema` 与 `shellExecutionIpcRequestSchema` 都通过 strict `.omit()` 排除 main-only 字段，`executeIpcRequest` 会在 handler 前拒绝它们；失败的 adapter 测试绕过了该边界并断言已删除的隐藏裁剪。
- provider config 迁移后的事实源是 strict `providerOptionsSchema`：缺失 enabled thinking budget 的错误 path 精确到 `budgetTokens`，retired `anthropicCacheControl` 必须以 `unrecognized_keys` 拒绝，不能恢复旧静默 strip。
- 阶段 4 Spec 首审 FAIL：`ipc-core.ts` 的 task history/background task schema 在迁移时丢失旧 `.int().positive()`、`trim().min(1)`、datetime、runCount 非负整数等约束；单源化不能弱化既有有效状态。
- 阶段 4 双轴首审共同指出：app/workspace/git/terminal/diagnostics/mcp/hooks 等 shared types 仍平行手写对应 Zod shape，未满足“TS 类型全部 `z.infer`”；必须让稳定类型门面直接从 schema 转导。
- 边界缺口分两层：输入/成功 data 的 ZodError 当前逃逸为 rejected promise，违反 preload 的 `Promise<IpcResult>`；`ok:false` 的 `RocError` 又没有 runtime schema，畸形错误可直接穿越边界。应在同一 IPC boundary 内 parse 全部结果并把边界异常转换为受控错误。
- 生成器残留 `omit-first` 验证/格式化分支，但 registry union 与 adapter 均不支持且无使用方；这是禁止的隐藏 transport 裁剪死路径。README 仍将 `src/shared/ipc.ts` 写成 schema 源，也需同步到 registry/shared schemas。
- fresh 平行类型清单覆盖 `app/performance/diagnostics/metrics/memory/hooks/mcp/skill/workspace/git/terminal/rtk/shell`；其中 workspace 的 `FileEntryShape/FilePreviewLike/FileDeleteResult`、metrics 的 `HistogramStats`、hooks 的执行内部输入输出等属于领域内部类型，应保留手写，其他 IPC 同形类型改为 `z.infer` 或从父 schema 索引派生。
- 本轮 CodeGraph 与 fresh typecheck 共同确认：前七个类型文件已完成 `z.infer` 且编译通过；剩余平行事实源集中在 `mcp/skill/workspace/git/terminal/rtk/shell`，对应 schema 已存在于 `ipc-mcp-skills.ts`、`ipc-workspace.ts`。本轮只转导 IPC-facing 类型，保留 `AbortSignal` 等 main 内部执行输入以及 workspace 内部组合类型。
- Standards 复审补充发现 `DefaultModelState` 仍与 `agentRuntimeStatusSchema.defaultModelState` 平行。终态由导出的 `defaultModelStateSchema` 单独拥有字段，runtime status 组合该 schema，settings 稳定类型门面使用 `z.infer`；严格 schema 继续拒绝额外字段。
- Spec 复审证明 approval 仍未真正单源：task event 曾以 `jsonObjectSchema[]` 接受空对象，renderer 又用只验证数组存在的 guard 二次重建形状。终态用独立 `shared/schemas/hitl.ts` 同时服务 live chat、persisted task event 与 main interrupt normalization，持久化投影直接消费已解析的 `TaskEvent` 判别联合。
- Standards 最终复审补充指出 agent policy/manifest 与 HITL review config 各自维护 `approve/edit/reject`。决策集合现在由 `hitlDecisionTypeSchema` 唯一拥有，agent policy 与 `InterruptDecisionType` 直接复用/推导。
- Spec 最终复审追加旁路：`session-repository.ts` 的 recorded resume payload 和 `chat-view.tsx` 仍绕过共享解析。前者现用 approval/question payload Zod schemas（approval decisions 复用 `hitlResumeDecisionSchema`），后者消费 `TaskEvent` message 判别联合；两个红测已验证修复前可复现、修复后通过。
- Standards 最终复审最后指出 session repository 的 recorded resume validator 与 task-event payload schema 重复。`approvalDecisionPayloadSchema`、`humanQuestionAnsweredPayloadSchema` 现由 task-event 导出并作为 DB 审计读取的唯一 parser。
