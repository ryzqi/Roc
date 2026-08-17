# 阶段 1：Interrupt 生命周期收敛

状态：✅ 完成（2026-08-17）

强度：Strong（首选）。依赖：无。这是唯一正在付费的摩擦——近期 5+ 条 fix 提交（recover missing interrupt projections、project every pending interrupt、recover resume audits across restart、stabilize multiple interrupt integration）都在为当前结构买单。

## 问题

一个 interrupt 从产生到恢复要经历 4 种形态、跨 8 个主进程文件，渲染层还有两套必须保持行为一致的并行 reducer。

主进程 4 形态接力：

1. vendor 形状 `DeepAgents110V3Interrupt` — `src/main/services/deep-agent/deep-agents-1-10-stream-adapter.ts:58-70, 411-447`
2. ChatRunEvent（executor 发出）— `src/main/plugins/agent/deep-agent-executor.ts:403-426`，归一化在 `deep-agent-final-output.ts:10-71`（`normalizeChatInterruptPayload`）
3. `PendingInterrupt`（runtime 从事件流"捞回"）— `src/main/plugins/agent/runtime.ts:1049-1056`，类型在 `runtime-types.ts:20-29`；resumeRun 三段式 dispatch 在 `runtime.ts:377-533, 1206-1237`
4. DB 行 + checkpoint blob — `session-repository.ts:701-878, 1400-1512`，硬编码 `'__interrupt__'` channel（与 `sqlite-checkpointer.ts:48-53` 重复定义）

渲染层双 reducer：

- live 事件 → pendingInterrupts upsert/remove — `src/renderer/chat-run-state.ts:179-208, 264-274`
- persisted 事件 → message.interrupts append/remove（逻辑重复）— `src/renderer/chat-transcript.ts:430-441, 834-854`
- resume request 组装 + selectPendingQuestion — `src/renderer/chat/chat-view.tsx:45-78`
- run_interrupted 触发全量刷新 — `src/renderer/app/AppShell.tsx:178-186`

executor 发出事件、runtime 又从事件里捞回结构化数据，是事件流被当作跨层数据通道的信号（病根与阶段 3 相同）。

## 目标形态

**主进程**：一个拥有 interrupt 投影与恢复的模块（建议 `src/main/plugins/agent/interrupt-projection.ts`），interface 三个动作：

- `record(runId, interrupts)` — 从执行结果记录中断（含归一化，吸收 `normalizeChatInterruptPayload`）
- `readPending(threadId)` — 读待处理中断（含重启后从 checkpoint 恢复的场景，经阶段 2 的 checkpointer 窄接口）
- `consume(interruptId, resolution)` — 恢复时消费

runtime 与 session-repository 只消费这个 interface。`PendingInterrupt` 成为该模块的输出类型，全链路唯一的领域形态；wire 上只有一种序列化形式过 IPC。

**渲染层**：live 与 persisted 事件先归一化为同一事件流（同一 payload 形状），再进唯一的 interrupt reducer（建议 `src/renderer/chat/interrupt-projection.ts`）。chat-run-state 与 chat-transcript 都调用它，不再各自维护 upsert 逻辑。

## 实施步骤

1. 盘点现有 4 形态的字段差异，确定唯一领域形态（以 `PendingInterrupt` 为基础，补齐 checkpoint 恢复场景需要的字段）。
2. 建主进程 `interrupt-projection` 模块，先把 `normalizeChatInterruptPayload`、runtime 的捞回逻辑（`runtime.ts:1049-1056`）、repository 的投影读写（`session-repository.ts:701-878`）搬进去，行为不变。
3. runtime 的 resumeRun 与 executor 的中断上报改走新 interface；删除事件流捞回路径。
4. 渲染层：定义归一化函数（live ChatRunEvent → 统一形状；persisted 事件 → 统一形状），建唯一 reducer；chat-run-state 与 chat-transcript 的两套 upsert/remove 改调它。
5. `AppShell.tsx:178-186` 的全量刷新评估是否还需要——若 reducer 已能增量维护，删掉。
6. 删除被替代的重复逻辑与等价性测试。

## 设计决策（动工前定案）

- checkpoint 恢复读取暂时保留裸 SQL 还是先做阶段 2 的窄接口？建议：若阶段 2 紧随其后，本阶段先在 interrupt-projection 内部封装该 SQL（唯一调用点），阶段 2 时换成 checkpointer 接口——避免两阶段互相阻塞。
- resume 三段式 dispatch（`runtime.ts:377-533`）是否并入本模块？建议：不并入，本阶段只收敛投影与数据形态，dispatch 属于 runtime 编排。

## 验收

- 全仓 grep：`normalizeChatInterruptPayload` 只在 interrupt-projection 内出现；runtime 不再从事件流读取 interrupt 数据。
- 渲染层只剩一个 interrupt reducer；chat-run-state 与 chat-transcript 中的重复 upsert 逻辑删除。
- 双 reducer 等价性相关测试删除；新增 interrupt-projection 的窄 interface 直测（记录/读取/消费/重启恢复四条路径）。
- `pnpm typecheck` + `pnpm test` 全绿；相关测试总行数下降。
