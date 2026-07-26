# Roc Agent Harness 进度

> 职责：记录已完成里程碑、提交和验证结果。当前待办见 `task_plan.md`，技术结论见 `findings.md`，长期规格见 `plan.md`。

## Current State

- Branch：`main`。
- HEAD：`e538ba9 fix(agent): accumulate usage per model call`。
- Stage 0-5：完成并提交。
- Stage 6：Part 1 完成并提交；Part 2 durable per-run telemetry 为 `Verified passing`，待独立提交。
- Stage 7：pending。
- V1 migration blocker 已修复；最终 review、focused 与 broad verification 全部通过。
- `plan.md` 当前未跟踪，作为 Stage 0-7 长期规格源；是否纳入后续提交需单独决定。

## Completed Milestones

| Stage | Result | Commit(s) |
|---|---|---|
| Stage 0 | 核心故障 characterization；后续 stress/cancellation 缺口由 Stage 2/4 回归补齐。 | `ae0c95b`, `4543408`, `2b28ef1`, `9845543` |
| Stage 1 | Immutable run manifest/snapshot、持久 audit、trusted origin、explicit skill contract。 | `4d9e8a3` |
| Stage 2 | Durable run CAS、terminal transaction、outbox projector、bounded queue/timeline。 | `1fbda30` |
| Stage 3 | Durable background occurrences、crash/restart reconcile、projector ordering。 | `dfbbf00` |
| Stage 4.1 | Main/subagent manifest safety 与 tool scope。 | `4ced164` |
| Stage 4.2 | Native model/tool call budgets 与结构化 budget failure。 | `031baea` |
| Stage 4.3 | Host shell pre-authorization、cwd/env/output/abort 边界。 | `20c235d` |
| Stage 4.4 | Web/hook scope、deadline、abort、provenance、Windows child-tree。 | `e75a754` |
| Stage 4.5 | Effect state、execution path、restart reconcile。 | `7e1ed9f` |
| Stage 5.1 | Context hard budget、reducer compaction、scoped artifact recovery。 | `b223636` |
| Stage 5.2 | Main/subagent context pipeline 收敛与 native A/B。 | `639c019` |
| Stage 5.3A | SQLite saver 对齐 upstream contract。 | `873df23` |
| Stage 5.3B | Interrupt collection、resume audit、checkpoint restart recovery。 | `a810b8f`, `24db71d`, `1e79a9e`, `fcc9c8c` |
| Stage 5.3C | Recovery-safe retention 覆盖 events、outbox、artifacts、checkpoint/writes。 | `9942594` |
| Stage 6.1 | Model usage 按 call 合并，跨 main/summary/subagent/retry/cache 累加。 | `e538ba9` |

## Verification Ledger

| Date | Scope | Result |
|---|---|---|
| 2026-07-23 | Stage 5.1 | Focused 11 files / 95 tests；typecheck、strict unused、IPC check、build、full Vitest 302 files / 1631 tests、diff check 通过；独立 review 无未处理 Critical/High/Medium。 |
| 2026-07-23 | Stage 5.2 | Focused 6 files / 26 tests、真实 Deep Agents route、typecheck、strict unused、IPC check、build、full Vitest 304 files / 1634 tests、diff check 通过；双轴 review 闭环。 |
| 2026-07-23 | Stage 5.3A | Focused 3 files / 11 tests、typecheck、strict unused、diff check 通过；双轴 review 闭环。 |
| 2026-07-25 | Stage 5.3B | Focused、strict unused、IPC check、build、full Vitest、diff check 通过；Standards/Spec 最终复核无 residual finding。 |
| 2026-07-25 | Stage 5.3C | Focused 4 files / 14 tests、strict unused、typecheck、IPC check、build、full Vitest 308 files / 1658 tests、diff check 通过；双轴 review 闭环。 |
| 2026-07-25 | Stage 6.1 | Focused 3 files / 26 tests、strict unused、typecheck、IPC check、build、full Vitest 309 files / 1662 tests、diff check 通过；最终 review 无 residual finding。 |

Windows full Vitest 偶发输出 node-pty `AttachConsole failed`；上述运行退出码均为 0。若以后变成非零退出，再单独定位环境边界。

## 2026-07-26 - Stage 6 Part 2 Durable Per-run Telemetry

### Review Resume

- Review baseline：`e538ba9`；HEAD 未变化，当前审查对象为其上的未提交工作树。
- V1/V2 migration focused gate 已记录通过；本轮先完成 Standards、Spec、Risk review，再运行 broad gates。
- `plan.md` 继续作为未跟踪长期规格源；本轮提交边界暂不包含该文件。
- Standards review：1 个 Medium 硬性合同问题、1 个 Low judgement-call smell；Low helper 抽取不采纳，避免为一次使用扩大 API。
- Spec review：1 个 High；session telemetry read 未校验完整 frozen identity，和当前验收冲突。
- Risk review：High identity fail-open 与 Medium nullable terminal contract 有效；其余迁移、删除、retention、health、metrics、cancel/interrupt 顺序暂未发现新增确定问题。
- Identity red：`session-repository.test.ts` 1 file / 28 tests，27 passed、1 failed；篡改 frozen correlation 后读取未失败。
- Review fixes：session read 加载 run/snapshot 并校验完整 identity；公开 interrupt terminal API 改为非空 telemetry，null 只留给私有 invalid-snapshot quarantine。
- Review-fix green：`session-repository.test.ts` 28/28、`pnpm typecheck`、`git diff --check` 通过。
- Final Standards/Spec/Risk 复审均无 residual finding。
- Review closure focused gate：15 files / 113 tests passed。

### Contract And Red Tests

- 固定范围：versioned、redacted per-run telemetry；repository round-trip；runtime lifecycle；schema/rebuild/retention；metrics cardinality。LangSmith、integration/eval、agent performance gate 延后。
- 首轮红灯证明：repository/table 不存在；`MetricsService` 接受四类高基数 label；cancel/interrupt/terminal telemetry 时序不满足 durable contract。
- 新增 strict telemetry schema、repository、accumulator、v12 table、metrics label 拒绝和 focused regressions。

### Review Closure Work

- Standards/Risk review 发现 corrupt telemetry 被覆盖、history deletion FK、schema health probe、cancel final usage、interrupt transaction、startup interrupted telemetry、missing row、recovery count、frozen identity 和 clock/retry 边界。
- DB 复核纠正错误方向：canonical v11 通过 migration 升级；legacy rebuild 不扩展为 hybrid source。已删除无效 compatibility path，保留已发布 migration checksum。
- Runtime 修复后，terminal/cancel/interrupt/restart telemetry 均使用明确 owner、事务和失败语义；missing/corrupt row fail closed。

### Last Recorded Verification

- Runtime durability red set：初始 3 files / 47 tests 为 43 passed、4 failed；修复后全绿。
- Boundary regressions：interrupt transaction rollback、restart missing row、corrupt terminal row、cancel retry 全绿。
- Runtime focused：4 files / 58 tests 与 `pnpm typecheck` 通过。
- Part 2 focused gate：25 files / 173 tests 通过，覆盖 telemetry repository、runtime/executor、interrupt/recovery/cancel、metrics、schema/migration/rebuild/retention/health/kernel、outbox history。
- 状态仍为 **Changed, partially verified**：focused gate 后发现 v12 只 backfill V2 snapshot。

### Remaining

- 复核提交边界并明确排除未跟踪的 `plan.md`。
- 独立提交 Stage 6 Part 2，记录 commit SHA 后拆分下一 part。

## 2026-07-26 - Planning Docs Cleanup

- 将 `plan.md` 固定为长期规格，`task_plan.md` 固定为活动计划，`findings.md` 固定为技术事实，`progress.md` 固定为里程碑和验证账本。
- 删除已闭环 WIP、逐命令流水、重复 review 过程和过期 Stage 5 blocker；保留 commit evidence、最后验证、当前 High blocker 和 deferred scope。
- 修正 `plan.md` 的过期实施状态和产品 Gate：interactive shell 不审批但明确为 host execution；background shell 仅使用冻结预授权；scheduler misfire 使用 latest-only coalesce。
- 未修改生产代码或测试代码。
- 验证：四份文档完整回读；引用文件全部存在；21 个里程碑 commit 可解析；过期状态扫描无冲突；四文件均为 LF、UTF-8 without BOM；尾随空白扫描与全工作树 `git diff --check` 通过。
- 状态：**Verified passing**。未运行代码测试，因为本轮只修改 Markdown。

## 2026-07-26 - Stage 6 Part 2 Resume

- 从 `task_plan.md`、`findings.md`、`progress.md`、`plan.md` 恢复上下文；`session-catchup.py` 未报告未同步内容。
- 确认 review baseline/HEAD 为 `e538ba9`，工作树仍是 Stage 6 Part 2 telemetry 改动；`.codegraph/` 可用并已用于定位 migration、V1 parser 和调用边界。
- 复现条件固定：v11 数据库包含当前 parser 支持的真实 V1 execution snapshot，升级 v12 后 telemetry row 缺失。
- 当前状态：**Located**。下一步只增加 V1 migration regression 并验证红灯，不先改生产 SQL。
- V1 regression 已加入：fixture 使用生产 manifest compiler 生成有效 hash，并先通过当前 `parseRunExecutionSnapshot`。
- 红灯：migration 后 `AgentRunTelemetryRepository.get(runId)` 收到 `null`；expected 为 `snapshotVersion: 1` 的 telemetry。失败位置 `database-migrations.test.ts:265`。
- 误触发的 full Vitest 结果：309 files / 1678 tests 通过，新增 V1 test 单独失败；退出码 1。伴随既有 Windows node-pty `AttachConsole failed` 输出。
- 首次 green 尝试将 telemetry `snapshotVersion` 写成原始 row 版本，focused 1 file / 11 tests 中 V1 case 以 `agent_run_telemetry_corrupt` 失败。
- Contract 复核确认 telemetry schema 固定接受 normalized V2；修复收敛为 `WHERE snapshot_version IN (1, 2)`，telemetry `snapshotVersion` 保持 2。
- V1 migration green：`pnpm exec vitest run tests/main/infrastructure/database-migrations.test.ts`，1 file / 11 tests passed，退出码 0。
- Part 2 direct focused gate：15 files / 112 tests passed，覆盖全部本 Part 修改的自动测试文件和新增 telemetry repository test。
- Review identity red：`session-repository.test.ts` 1 file / 28 tests，27 passed、1 failed；篡改 frozen correlation 后读取未失败。
- Review fix：session telemetry read 校验完整 frozen identity；公开 interrupt terminal API 要求非空 telemetry，`null` 仅保留给私有 invalid-snapshot quarantine。
- Review green：`session-repository.test.ts` 28/28 passed；最终 Standards、Spec、Risk 复审均无 residual finding。
- Final focused gate：15 directly affected files / 113 tests passed。
- Broad gate：strict unused、IPC check、full Vitest 310 files / 1680 tests、build（含 typecheck）与 `git diff --check e538ba9` 全部通过。
- Full Vitest 仍输出既有 Windows `node-pty AttachConsole failed`，但退出码为 0。
- 当前状态：**Verified passing**，待独立提交。

## 2026-07-26 - Stage 6 Part 2 Commit Resume

- `session-catchup.py` 检出上一会话 17 条未同步消息；与工作树、四份账本和 review 子任务结果交叉核对后，确认内容仅为已完成的最终 review 与 broad gate。
- 已把最终 review、focused 与 broad verification 结果同步到 `task_plan.md`、`findings.md`、`progress.md`；未修改长期规格 `plan.md`。
