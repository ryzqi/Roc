# Roc Agent Harness 执行账本

> 职责：记录当前阶段、剩余工作、有效决策和阻断项。长期规格见 `plan.md`，技术结论见 `findings.md`，执行与验证历史见 `progress.md`。

## Goal

按 `plan.md` 的 Stage 0-7 顺序完成 Agent Harness 优化。每个 stage 独立实施、review、修复、验证和提交；最终只删除有直接证据证明无用的遗留代码。

## Source of Truth

| 内容 | 权威来源 |
|---|---|
| 产品目标、架构边界、Stage 0-7 验收 | `plan.md` |
| 当前阶段、待办、阻断项 | `task_plan.md` |
| 已确认技术事实、风险 | `findings.md` |
| 已完成操作、提交、验证结果 | `progress.md` |
| 实际实现状态 | 当前工作树、Git 历史、新鲜验证结果 |

来源冲突时，以当前工作树和新鲜验证为准；旧记录只作历史证据。

## Current Phase

**Stage 6 Part 2 - Durable Per-run Telemetry**

**Status:** in_progress (`Verified passing`, commit pending)

- Review baseline：`e538ba9 fix(agent): accumulate usage per model call`。
- 当前范围：versioned、redacted per-run telemetry；repository round-trip；runtime terminal/interrupt/cancel durability；schema migration、retention、history deletion、health probe；metrics cardinality。
- 不在本 part 引入：LangSmith、provider integration、eval、agent performance gate、Stage 7 cleanup。
- 最后记录验证：最终 review 无 residual finding；Part 2 focused 15 files / 113 tests、strict unused、IPC check、full Vitest 310 files / 1680 tests、build/typecheck 与 diff check 全部通过。

## Phase Status

| Stage | Status | Evidence |
|---|---|---|
| Stage 0 - Characterization Gate | complete | 并发、terminal projection、restart、scheduler crash、backpressure、abort 与 Windows child-tree 均有回归证据。 |
| Stage 1 - Immutable Run Contract | complete | `4d9e8a3` |
| Stage 2 - Durable Run State, Outbox, Bounded Timeline | complete | `1fbda30` |
| Stage 3 - Durable Background Occurrences | complete | `dfbbf00` |
| Stage 4 - Execution Safety, Budgets, Cancellation | complete | `4ced164`, `031baea`, `20c235d`, `e75a754`, `7e1ed9f` |
| Stage 5 - Context, Checkpoint, HITL Conformance | complete | `b223636`, `639c019`, `873df23`, `fcc9c8c`, `9942594` |
| Stage 6 - Observability, Integration Tests, Evals | in_progress | Part 1 `e538ba9`；当前 Part 2。 |
| Stage 7 - Native Convergence, Patch Upgrade, Cleanup | pending | Stage 6 完成后开始。 |

## Current Acceptance

- [x] 最小 telemetry row 覆盖 run correlation、model usage、tool、subagent、context、runtime、terminal summary；不保存 raw prompt、reasoning、secret、workspace path 或完整 tool output。
- [x] Repository 按 `runId` 精确 round-trip；unknown field、损坏 JSON、schema/version/identity mismatch 明确失败。
- [x] Terminal、cancel、interrupt、restart recovery 与 telemetry 使用明确事务和顺序合同；missing/corrupt row 不被空 accumulator 覆盖。
- [x] History deletion、retention、required-table health probe 和 V2 snapshot migration 已接入并有 focused regression。
- [x] Metrics 拒绝 `runId`、`threadId`、`occurrenceId`、`dispatchKey` 等高基数 label。
- [x] v12 migration 同时覆盖当前仍支持的 V1/V2 run snapshot，并有真实 V1 fixture 回归。
- [x] Standards、Spec、Risk review 无未处理 finding。
- [x] Strict unused、typecheck、IPC check、build、full Vitest、diff check 全部通过。
- [ ] Part 2 形成独立提交。

## Current Step

**Part 2 independent commit**

**Status:** in_progress (`Verified passing`, commit pending)

- Reproduction：v11 数据库包含 `snapshot_version = 1` 且 `snapshot_json` 满足当前 `RunExecutionSnapshotV1` contract；升级 v12 后按 `runId` 读取 telemetry。
- Expected：V1/V2 run 均生成可由 `AgentRunTelemetryRepository` 读取的 row；V1 按 parser contract 规范化为 telemetry `snapshotVersion: 2`，其余冻结 identity 保持不变。
- Actual：v12 SQL 的 `WHERE snapshot_version = 2` 排除 V1；V1 row 缺失。
- Fix：v12 backfill 选择 V1/V2；telemetry 仍按 parser normalization 写 `snapshotVersion: 2`。
- Evidence：`pnpm exec vitest run tests/main/infrastructure/database-migrations.test.ts`，1 file / 11 tests passed。
- Focused gate：15 directly affected files / 112 tests passed；进入 Standards、Spec、Risk review。
- Review High：`AgentSessionRepository.getRunTelemetry()` 未校验完整 frozen identity，篡改 correlation 后读取 fail-open。
- Review Medium：公开 `interruptRunAtomically()` 允许 `telemetry: null`，可绕过 required telemetry contract。
- Red：session repository 1 file / 28 tests 中 1 个 identity read regression 失败。
- Green：session repository 1 file / 28 tests、`pnpm typecheck`、`git diff --check` 通过。
- Final review：Standards 0、Spec 0、Risk 0；无未处理 finding。
- Focused gate：15 directly affected files / 113 tests passed。
- Broad gate：strict unused、IPC check、full Vitest 310 files / 1680 tests、build（含 typecheck）与 `git diff --check e538ba9` 全部通过。
- Full Vitest 仍输出既有 Windows `node-pty AttachConsole failed`，但退出码为 0。

## Next Steps

1. 复核 `e538ba9` 之后的提交边界，明确排除未跟踪的 `plan.md`。
2. 独立提交 Stage 6 Part 2。
3. 记录 commit SHA，按 `plan.md` 拆分 Stage 6 后续 part。

## Decisions

| Decision | Rationale |
|---|---|
| 严格按 Stage 0-7 顺序 | `plan.md` 是当前验收源，避免跨 stage 混合事实源。 |
| 每个 stage/part 独立提交 | 保持 review、验证和回滚边界。 |
| Telemetry 是 per-run durable row，不是无限 metrics label | 保留诊断关联，限制 cardinality。 |
| Corrupt 或 missing telemetry 显式失败 | 不用空值或重建覆盖损坏证据。 |
| Terminal telemetry 与 run 终态同事务 | 防止 lifecycle 与诊断事实漂移。 |
| Cleanup 只做 evidence-first deletion | 无调用、测试、unused scan 或重复证据时不删除。 |

## Active Blockers

| Severity | Finding | Required closure |
|---|---|---|
| None | Part 2 已通过 review 与全部 verification gate。 | 完成独立提交。 |

## Errors Encountered

| Error | Attempt | Resolution |
|---|---:|---|
| 两个只读 PowerShell 统计命令把 `foreach` 输出直接接入管道，触发 `An empty pipe element is not allowed` | 2 | 先赋值给 `$rows` 再输出；失败命令未修改文件。 |
| 并行恢复检查中的 `git check-ignore plan.md` 以退出码 1 表示文件未忽略，导致 `Promise.all` 提前失败 | 1 | 将 expected non-match 显式转换为成功输出；确认 `plan.md` 未跟踪且未忽略。 |
| Windows `rg` 参数使用 shell glob 路径，并包含可能无匹配的查询；产生路径错误/退出码 1 | 1 | 后续使用目录参数配合 `-g`，并把无匹配与命令错误分开处理；失败命令未修改文件。 |
| `pnpm test -- tests/main/infrastructure/database-migrations.test.ts` 将 `--` 传给 Vitest并运行全部 310 个文件，而非只跑目标文件 | 1 | 红灯仍精确落在新增 V1 test；后续 focused 验证改用 `pnpm exec vitest run <path>`。 |
| 首次生产修复把 telemetry `snapshotVersion` 写成数据库原始版本，V1 row 被 strict telemetry schema 判为 corrupt | 1 | 查明 telemetry contract 固定为 normalized V2；恢复常量 2，仅扩大 migration 的 V1/V2 row 选择。 |
| 并行读取 skill 与 memory 时，预期的 memory 无匹配退出码 1 使整组 `Promise.all` 提前失败 | 1 | 改用 `Promise.allSettled` 并将预期无匹配显式转换为成功；确认无相关 memory 证据。 |
