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
