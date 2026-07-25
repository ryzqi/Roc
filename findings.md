# Roc Agent Harness 发现

## Requirements

- 严格按 `plan.md` Stage 0-7 顺序执行。
- 每个 stage 完成实现、独立 review、修复、验证和独立提交。
- 当前树和新鲜验证优先于旧计划描述或历史过程记录。
- 最终 cleanup 只删除有直接证据证明无用的代码。

## Current Findings

### Stage 5 Part 1 Review Result

- 2026-07-23 已完成 context reducer update、summary segment 边界、summary hard budget、deterministic hard trim、provider token counter/fallback、artifact scope/pagination、main/subagent budget gate 和 `context_budget_exhausted` 终态映射。
- `read_context_artifact` 已进入 executor tool surface、冻结 capability manifest、chat/plan harness；SQL 读取同时绑定 `artifactId + threadId + workspaceHash`，sha256 必填，返回 bounded slice 与 continuation metadata。
- summary fallback 仅接受明确 schema failure、timeout、network、empty response 和 retryable HTTP；未知实现错误继续抛出。
- hard trim 保持 AI tool-call/ToolMessage 成对删除；ToolMessage 反向删除路径也会递归移除对应 AI call 及其全部结果。
- 新鲜验证：focused 11 files / 95 tests、`pnpm typecheck`、strict unused scan、`pnpm check:ipc`、`pnpm build`、full Vitest 302 files / 1631 tests、`git diff --check` 全部通过。
- 独立 risk review：未发现未处理 Critical/High/Medium finding。全量 Vitest 末尾 node-pty `AttachConsole failed` 为子进程诊断噪声，Vitest 退出码 0；不改变本 part 结论。
- 状态：**Verified passing; committed**。Part 2 Native Convergence 与 Part 3 Checkpoint/HITL 仍 pending。

### Stage 5 Part 2 Native Convergence

- Deep Agents 1.10.7 的 harness profile 过滤只作用于 main middleware；declarative inline subagent 的 native summary 在 `normalizeSubagentSpec` 中固定前置，现有 profile 不能将其排除。
- 生产路径选择 Roc pipeline：main 继续由 provider profile 排除 native summary；声明式 subagent 在 Roc builder 内编译为 runnable，保留官方 todo/filesystem/skills/patch/prompt-cache、权限覆盖、HITL 与 static response format。
- Anthropic cache 识别已对齐 1.10.7：支持 `anthropic:*`、裸 `claude*`、`ChatAnthropic` 与 provider 为 anthropic 的 `ConfigurableModel`；静态 system breakpoint 在相同输入上保持稳定。
- 固定 corpus A/B 本地结果：两条候选均完成并保留 PROJECT/DECISION/NEXT 标记；Roc summary input token 少于 native，structured summary output 较 native plain-text summary 更大；两者原文均可恢复，Roc checkpoint 经 saver 序列化后小于 native event + full message state。
- 真实 route integration 使用未 mock 的 `createDeepAgent`、compiled research subagent、Roc compaction 与 `RocSqliteCheckpointer`，完成 `task -> write_todos -> return` 并触发 `context_summary_completed`；main 最终 middleware 不含 `SummarizationMiddleware`。
- 双轴 review 的 Standards finding 已全部修复并复核无新增问题；Spec 初审的 mock vacuity、cache model compatibility、真实 route/checkpoint/long-context 证据均已补齐。Standards 与 Spec 最终复核均无本地未处理 finding。
- 新鲜验证：focused 6 files / 26 tests、真实 route、`pnpm typecheck`、strict unused scan、`pnpm check:ipc`、`pnpm build`、full Vitest 304 files / 1634 tests、`git diff --check` 全部通过。
- 状态：**Verified passing; committed**。提交 `639c019`；真实 Anthropic provider cache usage 仍按 Stage 6 外部 integration 边界处理。

### Stage 5 Part 3A Saver Conformance

- 原 Roc saver 的 `list` 未实现 metadata filter，且会在 filter 前应用 SQL limit；固定 conformance 红灯返回 `checkpoint_002`，upstream `MemorySaver` 返回 `checkpoint_001`。
- 当前 filter 在 limit 前执行；filtered list 以 `(checkpoint_id DESC, thread_id ASC, checkpoint_ns ASC)` 做 64-row keyset metadata pagination，命中后才读取完整 checkpoint 与 pending writes；并发 retention 删除命中 row 时跳过且不消耗 limit。
- pending writes 按 upstream insertion order 返回；regular write 保留首次值，`__error__`、`__scheduled__`、`__interrupt__`、`__resume__` 重试覆盖原值且保持位置。
- shared conformance 精确覆盖两个 task 的完整 pending-write tuple、getTuple/list 双路径和 delete 后 write 无残留；不再用 Map 丢弃 taskId、重复 channel 或顺序。
- 双轴最终 review 无 Standards/Spec finding；focused 3 files / 11 tests、typecheck、strict unused 与 diff check 通过。
- 状态：**Verified passing; committed**。提交 `873df23`。

### Stage 5 Part 3B Interrupt Projection Review

- 当前工作树已把 `agent_pending_interrupts` 迁移为 `(run_id, interrupt_id)` collection，并用 `position` 保持 framework interrupt 顺序；rebuild 同时兼容 v9 单行 schema 与 v10 collection schema。
- executor adapter 已投影全部 framework interrupts；runtime 与 renderer 均按 interrupt id 维护 collection；resume payload 已改为 `{ [interruptId]: value }`。
- 真实 LangGraph/Deep Agents + `RocSqliteCheckpointer` restart tests 已覆盖 approval、单个 ask_user、并行 ask_user 与 DeepAgent multiple ask_user。
- 已补两阶段 resume dispatch：`beginResumeDispatch` claim 后调用 executor 并取得有效 stream；commit 事务同时写 canonical audit、session message（question）与 projection deletion。executor promise rejection 或 audit 事务失败均 rollback 并保留 projection。
- Review finding 已修复：不再在 commit 前消费 executor stream。SessionStart、`Command(resume)`、model/tool execution 只在 commit 后的 detached run 内发生；已提交 stream 的首事件失败按 run failure 处理。
- Review finding 已修复：`executeDeepAgentRun` 缓冲全部 `run_interrupted`，先事务写 collection projection，再向 renderer 发布；renderer 不会在投影未落库时 resume。
- Review finding 已修复：startup 恢复 waiting projection 除 collection 合法性外，必须命中最新 main checkpoint 的 `__interrupt__` pending write。stale projection 遇到无 interrupt 的新 checkpoint 不会回到 `waiting_user`；repository regression 与真实 Deep Agents + Roc saver restart 已通过。
- Preliminary Spec finding：`plan.md` 要求 pending projection 删除复制的 mode/workspace/capability 配置；v10 schema 仍保留 `mode`、`task_source`、`workflow_hint`、`workspace_path_state`、`workspace_path`、`explicit_skill_ids_json`，需在本 migration 中删除。
- Preliminary Spec/test finding：必须用生产 runtime/executor 路径证明真实 parallel interrupt 的完整 map 或 partial-map 合同；rebuild 的 legacy `position=0` fallback 也需要直接结果断言。
- Pinned LangGraph probe（`MemorySaver` + 两个并行 `interrupt()`）确认 partial resume map 可用：第一次只提交一个 interrupt id 后，已回答分支写入 state，另一 id 继续出现在 `__interrupt__`；第二次提交剩余 id 后完成。产品可保留单 interrupt IPC，但仍需用 Roc saver 与生产 runtime/executor 固化该合同。
- Preliminary Spec/rebuild finding：删除 obsolete columns 后 rebuild 不能无条件读取旧列；必须同时支持 legacy source 表和当前 minimal 表，否则 `readRows` 的失败路径会静默丢掉 pending projection。旧 v8/single-row fixture 还要断言 row、interrupt id 与 `position=0`。
- 状态：**Changed, partially verified; preliminary review findings unresolved**。

### Remaining Stage 5 Gaps

- Schema v11 已删除 projection 中复制的 mode/workspace/capability 配置；rebuild 通过 source-column 检测兼容 legacy 与 minimal collection。剩余要求是 focused migration/rebuild 回归确认。
- Final review 阻断：第二个快速 resume 在 run 已变 `running` 时曾清空余下 projection；已删除该错误清理，仍需补并发回归。
- Final review 阻断：`ChatTranscriptMessage` 仍是单 `interrupt` 字段，持久和 live transcript 都只展示 collection 首项；需扩为 collection，并同步 `chat-message-row`/`chat-view` 的逐项 resume UI。
- 已定位 UI 根因：`chat-transcript.ts` 将 persisted event 覆盖到单 `message.interrupt`，live projection 读取 `pendingInterrupts[0]`；`chat-message-row.tsx` 也只渲染单卡片。
- Transcript collection 已完成：persisted event 按 `interruptId` 合并/移除，live state 保留全量，assistant bubble 逐项渲染 approval/question；focused renderer 4 files / 48 tests、`pnpm typecheck` 与 `git diff --check` 通过。
- Restart reconcile 仅在 projection 已存在且 checkpoint 最新 main write 含 `__interrupt__` 时恢复 `dispatch_pending`/`running` 为 `waiting_user`。commit 删除最后 projection 后崩溃仍会进入 terminal；需从 latest checkpoint 的 `__interrupt__` 重建 projection。
- `langgraph_checkpoint_writes` 保存 `__interrupt__` 的 serde typed value；recovery 必须沿用 LangGraph serializer 解码其 `{ id, value }[]`，再写入最小 projection，不能从 session event 猜测。
- Roc saver 的 pending write 读取已使用 `this.serde.loadsTyped`；现有 repository restart fixture 证明 default `json` write 为 UTF-8 JSON blob。recovery 仅接受 `value_type='json'`、非空 `{id,value}` 数组和符合 `ChatInterruptPayload` 的 value；其他类型或形态视为不可恢复。
- Recovery 以 checkpoint 为执行真相：每次 startup 读取最新 main checkpoint 的 actual interrupt collection；projection 缺失或与该 collection 不同则原子重建，不重复写 UI history events。
- 真实 partial resume 的 latest checkpoint 保留已回答与未回答 interrupt；持久 projection 为 remaining subset 时必须保留，只有 projection 缺失或含 checkpoint 外 id 才从 checkpoint 重建。
- Checkpoint recovery 回归通过：缺 projection 的 partial resume crash 从 checkpoint 重建 collection；existing remaining subset 不会被旧 checkpoint 重新扩展。repository、真实 DeepAgent/Roc saver restart、runtime multiple 共 31 tests 通过。
- Crash recovery/concurrency review：decoder 只接受 observed `json` typed payload、malformed checkpoint fail closed、projection remaining subset 保持；快速第二 resume 明确拒绝且不删除剩余 projection。focused 4 files / 32 tests、`pnpm typecheck`、`git diff --check` 通过，未发现未处理 finding。
- Part 3B final independent review 新增待修：resume commit 后 observer publish reject 会阻断 accepted stream；latest checkpoint 的 historical interrupt collection 必须结合 durable resume audit 得出有效 pending 集合，不能裸按 subset 保留；持久 projection JSON 读取必须执行 shape validation。
- 复核 Spec 的 observer finding：`runtime.publish()` 已在 event-bus boundary 捕获 reject 并记录 notification metric；`publishChatRunEvent`/`publishTaskEvent` 均经此边界，accepted stream 不会被 observer reject 阻断。此项不成立，不改生产路径。
- Standards fixes：effective pending = checkpoint interrupt collection - canonical decision audit ids；projection 只在有序 id/payload 全量一致时保留。损坏 stored payload 通过同一 normalizer 明确拒绝。focused 5 files / 35 tests、`pnpm typecheck`、`git diff --check` 通过，等待复核。
- Standards re-review 新增 P1：crash 在 audit commit 与 stream 首次消费之间时，startup 虽隐藏已答 interrupt，却未把 canonical audit answer 合并回 LangGraph resume map；必须从 durable audit 重建完整 `interruptId -> value`。
- Audit resume-map 已修：repository 以 ordered canonical audit 重建 `interruptId -> {decisions|answer}`，runtime 将其与当前请求合并；focused 5 files / 35 tests、`pnpm typecheck`、`git diff --check` 通过，复核进行中。
- Part 3B final review：Standards 与 Spec 复核均无 residual finding。final broad gate（strict unused、IPC、build、full Vitest、diff check）退出码 0；node-pty `AttachConsole failed` 为既有 Windows 子进程诊断噪声，不改变 Vitest 通过结论。
- 现有 executor 已有 `normalizeInterruptPayload` 的 runtime shape validation；checkpoint recovery 需要复用等价严格语义，不能把 raw JSON 直接断言为 `ChatInterruptPayload`。
- Final review 阻断：commit 删除最后 projection 到 executor 实际消费之间崩溃，checkpoint 仍有 interrupt 但 repository 无 projection，restart 会 terminal；需以 checkpoint 重建 projection 或保留可恢复 dispatch intent，并补 crash/event-publish regression。

- multiple interrupt collection 与 dispatch failure preservation 已有部分实现，但上述原子性、竞态、schema 和生产语义 finding 尚未完成 review closure。
- checkpoint/artifact/event retention 规则尚未实现和验证。

### Stage 5 Part 3C Retention

- `agent_runs` 的可恢复非终态完整集合为 `dispatch_pending`、`waiting_next_turn`、`running`、`recovering`、`waiting_user`；现有 retention 只排除了后三项，会把前两项的 payload 与超额 checkpoint 当作可删数据。
- `terminalRunRetentionDays` 已是唯一已配置的 recovery safety window，避免新增未经确认的第二个生命周期参数：窗口内终态 thread、任意非终态 thread、或存在 pending interrupt 的 thread 都保留其全部 run payload、checkpoint 与 writes；只对全部终态且已越过窗口的 thread 清理 terminal run payload，并按既有 checkpoint 上限裁剪 checkpoint/writes。
- Part 3C red test 证明旧实现会删除 3 组受保护数据（`agentEvents`、`agentRunEvents`、`toolEffects`、`contextArtifacts`、checkpoint 和 writes 各 3 条）；最小修复后 focused retention test 和 `pnpm typecheck` 通过，待独立 review 与全量门禁。
- 独立 Spec review 发现 terminal `agent_outbox` 是 canonical terminal event 却未参与清理；已在相同事务内按同一 expired run 集合删除，并将 result 与 protected-window regression 扩展到 outbox。focused retention + maintenance tests（6 tests）、typecheck、diff check 通过，需对修复重审。
- 修复后双轴 re-review 无 residual finding。新鲜验证：retention/schema/rebuild/maintenance focused 4 files / 14 tests、strict unused、typecheck、IPC check、build、full Vitest 308 files / 1658 tests、diff check 均通过。Vitest 的 `node-pty AttachConsole failed` 为既有 Windows 子进程噪声，命令退出码 0。
- 状态：**Verified passing**。Part 3C 已完成，待本次独立提交后 Stage 5 全部闭环。

### Stage 6 Part 1 Usage Accumulation

- `stream-usage-accumulator.ts` 以前按每个字段覆盖最后一次观察到的 metadata；一个 agent run 出现 main、summary、subagent 或 retry call 时，先前 call 的 token/cache usage 会丢失。
- 每个有稳定 message id 的 model call 现在保留最后合并的 usage snapshot，再跨 call 求和；同一 id 的 partial metadata 只补全其自身未报告字段，不会将同一 call 重复计入。无 id 的 metadata 明确不计入，避免把无法证明同源的流分片静默重复计数。
- 独立 review 发现 subagent stream 未进入 aggregate、无 id stream 会重复计数；已将 subagent message usage 汇入同一 run accumulator，并新增 executor main+subagent regression。focused 3 files / 26 tests、`pnpm typecheck`、diff check 通过，待 re-review 与 full gates。

### Durable Project Facts

- `.codegraph/` 存在；理解或定位代码时先使用 CodeGraph。
- `/workspace/` 是 DeepAgents file-tool 虚拟路径，不是 shell cwd。Shell、hook 和 subprocess 必须使用真实 Windows 工作目录。
- Run capability、tool identity、execution scope、effect policy 和 background shell authorization 以冻结 manifest/snapshot 为执行事实源。
- Agent DB 持有 run/timeline/outbox 真相；task DB 只做幂等 projection；EventBus 不是 durable state owner。
- 同 thread active run 使用 CAS/lease 约束；background occurrence 使用 durable claim/lease 和 latest-only coalesce。
- Interactive shell 无审批但仍是 host code execution；background shell 缺 durable pre-authorization 时 fail closed。
- Effect 状态包含 checkpoint/subagent execution path；`unknown` 或 manual-confirmation effect 不允许盲重试。

## Closed Stage Evidence

| Stage | Commit evidence | Durable result |
|---|---|---|
| 0 | `ae0c95b`, `4543408`, `2b28ef1`, `9845543`，以及 Stage 2/4 回归 | 原始 P0 路径已有 characterization、stress、restart 和 cancellation 证据。 |
| 1 | `4d9e8a3` | Preview、executor、audit 和 resume 共享 immutable run contract。 |
| 2 | `1fbda30` | CAS run state、terminal transaction、outbox projector、bounded timeline/backpressure。 |
| 3 | `dfbbf00` | Durable occurrence、claim/lease、restart reconcile、crash-point/projector coverage。 |
| 4 | `4ced164`, `031baea`, `20c235d`, `e75a754`, `7e1ed9f` | Shared execution safety、native budgets、host shell、web/hooks cancellation、effect reconciliation。 |

## Verification Anchors

- Backpressure：`tests/main/plugins/agent/run-event-backpressure.test.ts` 覆盖 100k text coalesce、10k structural overflow 和 10k timeline/replay bound。
- Shell cancellation：`tests/main/services/shell-execution-cancellation.test.ts` 覆盖 Windows parent/child tree termination。
- Hook cancellation：`tests/main/services/hooks/command-runner.test.ts` 覆盖 running abort、pre-abort 和 Windows child tree。
- Web abort/security：`tests/main/web-read-service.test.ts` 覆盖 caller abort、private destination 和 response cap。
- Stage 5 当前 focused anchor：`tests/main/services/deep-agent/context/context-compaction-pipeline.test.ts`。

## Open Risks

- reducer update 已由真实 LangGraph + Roc saver restart integration 证明写入 checkpoint；尚未覆盖完整 Deep Agents model loop。
- `context_budget_exhausted` 只有进入 runtime terminal path 后，才能证明不会触发 recovery 或继续 model call。
- Stage 5 不得保留 Roc 与 native 两套长期并行的 summarization 事实源。
- 本地 cache contract 已验证；真实 Anthropic `cache_read` usage 需要外部 provider 凭据，归 Stage 6 integration，当前不得表述为 provider hit 已验证。
- Windows 全量测试偶发输出 node-pty `AttachConsole failed`，当前 Vitest 仍以退出码 0 完成；后续若转为非零退出再单独定位环境边界。

## 2026-07-25 Resume Audit

- 当前 HEAD 为 `a810b8f wip(agent): project pending interrupt collections`；工作树仅有用户未跟踪的 `plan.md`，本轮不修改或提交该文件。
- Part 3B 仍须闭环三项：collection interrupt 在 renderer transcript 的逐项呈现与逐项 resume、commit 后 executor 消费前崩溃的 checkpoint projection 重建、快速双 resume 的并发回归。
