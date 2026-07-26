# Roc Agent Harness 发现

> 职责：保存已确认技术事实、当前风险和可复用证据。规格见 `plan.md`，活动待办见 `task_plan.md`，时间线见 `progress.md`。

## Requirements

- 严格按 `plan.md` Stage 0-7 顺序执行。
- 每个 stage 完成实现、独立 review、修复、验证和独立提交。
- 当前工作树和新鲜验证优先于旧计划描述或历史过程记录。
- 最终 cleanup 只删除有直接证据证明无用的代码。

## Current Findings

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

## Verification Anchors

- Current telemetry：`tests/main/plugins/agent/run-telemetry-repository.test.ts`、`tests/main/plugins/agent/runtime-executor.test.ts`、`tests/main/plugins/agent/runtime.test.ts`、`tests/main/plugins/agent/session-repository.test.ts`。
- Migration/lifecycle：`tests/main/infrastructure/database-migrations.test.ts`、`tests/main/infrastructure/database-retention.test.ts`、`tests/main/plugins/task/agent-outbox-projector.test.ts`。
- Metrics cardinality：`tests/main/metrics-service.test.ts`。
- Backpressure：`tests/main/plugins/agent/run-event-backpressure.test.ts`。
- Windows cancellation：`tests/main/services/shell-execution-cancellation.test.ts`、`tests/main/services/hooks/command-runner.test.ts`。
