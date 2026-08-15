# Roc Agent Harness 任务计划

> 职责：当前阶段、剩余工作、有效决策和阻断项。长期规格见 `plan.md`，技术结论见 `findings.md`，执行与验证历史见 `progress.md`。

## Current State

- Branch：`main`
- HEAD：`19e262b docs(agent): consolidate tracking docs`
- Stage 0-7：全部完成并提交
- Stage 7：Part 1 `4f37f17`；Part 2 `475b4d2`；Part 3 `e94a7fc`；Part 4 docs-only `d5150a6`
- 当前无进行中任务；工作树干净，仅 `plan.md` 保持未跟踪。

## Phase Status

| Stage | Status | Commit Evidence |
|---|---|---|
| Stage 0 - Characterization Gate | complete | `ae0c95b`, `4543408`, `2b28ef1`, `9845543` |
| Stage 1 - Immutable Run Contract | complete | `4d9e8a3` |
| Stage 2 - Durable Run State, Outbox, Bounded Timeline | complete | `1fbda30` |
| Stage 3 - Durable Background Occurrences | complete | `dfbbf00` |
| Stage 4 - Execution Safety, Budgets, Cancellation | complete | `4ced164`, `031baea`, `20c235d`, `e75a754`, `7e1ed9f` |
| Stage 5 - Context, Checkpoint, HITL Conformance | complete | `b223636`, `639c019`, `873df23`, `a810b8f`, `24db71d`, `1e79a9e`, `fcc9c8c`, `9942594` |
| Stage 6 - Observability, Integration Tests, Evals | complete | Part 1 `e538ba9`；Part 2 `abc3220`；Part 3 `012c870`, `77cf36a`, `82164ab`；Part 4 `da0eb8d`；稳定性 `332048d`；Part 5 `298b2da`；Part 6 `2ea75fe`；Part 7 `dd5af40` |
| Stage 7 - Native Convergence, Patch Upgrade, Cleanup | complete | Part 1 `4f37f17`；Part 2 `475b4d2`；Part 3 `e94a7fc`；Part 4 docs-only `d5150a6` |

## Current Acceptance

Stage 7 Part 4 已按 evidence-backed no-change 关闭：

- [x] 五个 performance candidate 均已审计现有指标、真实调用链、owner 与隔离约束。
- [x] 没有候选达到可稳定证明收益的实施门槛，production/tests 未改动。
- [x] provider/config/secret、prompt/tool 顺序、event 顺序/backpressure、restart/HITL 行为保持不变。
- [x] agent/UI performance、typecheck、strict unused、IPC check、build、full Vitest 与 diff check 均通过。
- [x] Stage 7.4 exact-set 仅三份账本，不包含 `plan.md`；已独立提交为 `d5150a6`。

## Next Steps

当前无未完成 step。Stage 0-7 已关闭；后续新工作必须先在 `plan.md` 明确范围、验收与回滚边界，再按 stage 实施、review、验证和独立提交。

## Decisions

| Decision | Rationale |
|---|---|
| 严格按 Stage 0-7 顺序 | `plan.md` 是当前验收源，避免跨 stage 混合事实源。 |
| 每个 stage/part 独立提交 | 保持 review、验证和回滚边界。 |
| Telemetry 是 per-run durable row，不是无限 metrics label | 保留诊断关联，限制 cardinality。 |
| Corrupt 或 missing telemetry 显式失败 | 不用空值或重建覆盖损坏证据。 |
| Terminal telemetry 与 run 终态同事务 | 防止 lifecycle 与诊断事实漂移。 |
| LangSmith tracing 默认关闭且显式 opt-in | 外部 trace 不能由隐式产品行为开启；导出必须经过 allowlist/redaction boundary。 |
| LangSmith 配置与密钥归 Agent plugin config/secrets | 保持单一 owner；不升级全局 AppSettings，不复用 provider secret 语义。 |
| Cleanup 只做 evidence-first deletion | 无调用、测试、unused scan 或重复证据时不删除。 |
| Stage 7.1 与 1.10.8 升级分开提交 | 避免 native overlap 行为变化与 framework patch 混成一个事实源。 |
| Stage 7.3 adapter 只支持当前 1.10.x / stream v3 合同 | 规格要求集中 shape owner，不要求提前建立多版本兼容或迁移机制。 |
| Stage 7.4 不修改 production/tests | 五个候选均无稳定指标证明收益；缓存/重排/合并会扩大 config-secret、snapshot 或 event 语义风险。 |

## Boundaries / Not Doing

- 不手改 `plan.md`；它是未跟踪的长期规格源，除非用户明确要求进入提交。
- 不删除无法证明无用的代码；疑似 dead code 只报告，不清理。
- 不以 UI/transcript smoke 代替 agent-loop performance 证据。
- 不新增兼容 alias、双写路径、配置项或扩展点，除非新规格明确要求。
- 已知残余风险和技术合同见 `findings.md`；完成里程碑与最终门禁见 `progress.md`。
