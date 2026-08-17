# 阶段 5：Stream adapter 输出领域事件 + 合并克隆投影

强度：Worth exploring。依赖：阶段 3（事件流已只承载 UI 增量，adapter 的输出消费方稳定后再动）。

## 问题

**形状复读机**：`src/main/services/deep-agent/deep-agents-1-10-stream-adapter.ts`（575 行）对 `deepagents@1.10.8` 的输出做逐字段运行时断言（42 个错误码），但输出的 `DeepAgents110V3Run` 与输入形状几乎一一同构（messages/toolCalls/subagents/output/interrupts 原样透传，仅 usage 摊平、output 取末条消息文本）。删除测验：删掉它，消费方（stream-consumers、subagent-projection、final-output）代码几乎不变——复杂度被复制而非集中。它站在防腐层的位置，却没做防腐层的翻译，vendor 形状泄漏到全部下游。

**克隆投影**：两处 `consumeToolCalls` 近克隆——`stream-consumers.ts:101-183` 与 `subagent-projection.ts:175-242`：同样的 `Promise.allSettled` 结算、同样的 `DeepAgents110V3ContractError` rethrow、同样的 redact→projectToolOutput→emit start/end/error 三相，差别仅是事件外壳（`assistant_block` vs `subagent_event`）。

**测试复验镜像**：`deep-agent-stream-shape-conformance.test.ts`（1,012 行）再验证一遍同一契约——验证的是"镜像正确"，信息量低。

**附带**：`tool-effect-idempotency.ts:156-201` 的 `readExecutionIdentity` 解析 LangGraph 内部 configurable（`checkpoint_ns` 的 `'|'` 分隔、`'tools:'` 前缀、`ls_agent_type`、`checkpoint_map`）——vendor 未承诺的内部结构被业务幂等键直接消费，失败静默降级。

## 目标形态

1. adapter 升级为真正的防腐层：输出**领域事件**（tool-call 开始/结束/失败、assistant 增量、subagent 生命周期、usage、interrupt——阶段 1 的领域形态），把 `stream-consumers.ts` 的分类逻辑吸进 adapter。vendor 形状不出 adapter 文件。
2. tool-call 生命周期抽成单一投影器（结算、rethrow、redact→project→emit 三相），事件外壳作参数；`subagent-projection` 与主流程都调它，克隆删除。
3. `readExecutionIdentity` 隔离为显式 adapter，并配一条 vendor 升级哨兵测试（deepagents/langgraph 版本变更时该测试先红）。

## 实施步骤

1. 列出下游实际消费的字段集合（stream-consumers、subagent-projection、final-output、executor），据此定义领域事件类型——只翻译被消费的，不镜像全量。
2. 在 adapter 内实现 vendor 形状 → 领域事件的翻译；42 个错误码保留（防御有效），但断言对象变为"翻译能否完成"。
3. 抽 tool-call 生命周期投影器；两处 consumeToolCalls 改调；删除克隆。
4. 下游消费方逐个切到领域事件；`DeepAgents110V3Run` 类型及其透传字段删除。
5. `deep-agent-stream-shape-conformance.test.ts` 重写为验证翻译（vendor 夹具 → 期望领域事件），行数应大幅下降。
6. `readExecutionIdentity` 移入独立 adapter 文件 + 哨兵测试。

## 设计决策（动工前定案）

- 领域事件与现有 `ChatRunEvent` 的关系：合一还是两层（adapter 领域事件 → executor 组装 ChatRunEvent）？建议两层但形状对齐——ChatRunEvent 是 IPC wire 形态（阶段 4 管辖），领域事件是主进程内部形态；若两者字段一致可直接复用类型。
- `emitTodoEvent: () => {}` 永久空实现（`deep-agent-executor.ts:570-581`）随本阶段从 callbacks interface 删除。

## 验收

- 全仓 grep：`DeepAgents110V3` 前缀类型只在 adapter 文件内出现。
- `consumeToolCalls` 只有一个实现。
- conformance 测试行数下降且断言对象为翻译结果；vendor 升级哨兵测试存在。
- `pnpm typecheck` + `pnpm test` 全绿。
