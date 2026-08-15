# Roc Agent Harness 进度

> 职责：已完成里程碑、提交和最终验证账本。当前待办见 `task_plan.md`，技术结论见 `findings.md`，长期规格见 `plan.md`。

## Current State

- Branch：`main`
- HEAD：`d5150a6 docs(agent): record performance tuning evidence`
- Stage 0-7：全部完成并提交
- Stage 7：Part 1 `4f37f17`；Part 2 `475b4d2`；Part 3 `e94a7fc`；Part 4 docs-only `d5150a6`，五项 performance candidate 均为 evidence-backed no-change
- 当前工作树仅有三份跟踪文档的整理 diff；`plan.md` 保持未跟踪，不进入提交

## Completed Milestones

| Stage | Result | Commit(s) |
|---|---|---|
| Stage 0 | 核心故障 characterization；后续 stress/cancellation 缺口由 Stage 2/4 回归补齐。 | `ae0c95b`, `4543408`, `2b28ef1`, `9845543` |
| Stage 1 | Immutable run manifest/snapshot、持久 audit、trusted origin、explicit skill contract。 | `4d9e8a3` |
| Stage 2 | Durable run CAS、terminal transaction、outbox projector、bounded queue/timeline。 | `1fbda30` |
| Stage 3 | Durable background occurrences、crash/restart reconcile、projector ordering。 | `dfbbf00` |
| Stage 4 | Main/subagent manifest safety、native budgets、host shell、web/hook abort、effect execution path。 | `4ced164`, `031baea`, `20c235d`, `e75a754`, `7e1ed9f` |
| Stage 5 | Context hard budget、single compaction path、SQLite saver conformance、restart-safe HITL、recovery-safe retention。 | `b223636`, `639c019`, `873df23`, `a810b8f`, `24db71d`, `1e79a9e`, `fcc9c8c`, `9942594` |
| Stage 6.1 | Model usage 按 call 合并，跨 main/summary/subagent/retry/cache 累加。 | `e538ba9` |
| Stage 6.2 | Versioned、redacted per-run telemetry 与 terminal/recovery/migration/retention durability。 | `abc3220` |
| Stage 6.3 | 默认关闭的 LangSmith native tracing、durable root lifecycle，以及独立可观测性 settings UI / IPC / secret controls。 | `012c870`, `77cf36a`, `82164ab` |
| Stage 6.4 | 独立 agent integration mode、真实 Deep Agents/Roc SQLite offline trajectory 与可选 Anthropic live boundary。 | `da0eb8d` |
| Stage 6.4 稳定性 | 稳定 multiple-interrupt integration，移除 full-suite 偶发 timeout。 | `332048d` |
| Stage 6.5 | Deterministic trajectory eval runner、strict versioned dataset 与真实 harness scenarios。 | `298b2da` |
| Stage 6.6 | Manual live quality eval、strict versioned dataset、真实 Anthropic harness 与独立 structured-output judge。 | `2ea75fe` |
| Stage 6.7 | Deterministic agent performance smoke、versioned artifact 与真实 agent loop/queue/outbox 门。 | `dd5af40` |
| Stage 7 | Native convergence、Deep Agents 1.10.8 patch、versioned stream adapter 与 evidence-backed performance no-change。 | Part 1 `4f37f17`；Part 2 `475b4d2`；Part 3 `e94a7fc`；Part 4 docs-only `d5150a6` |

## Final Verification Ledger

| Date | Scope | Result |
|---|---|---|
| 2026-07-28 | Stage 7.4 关闭 | `pnpm smoke:agent-performance` 1 file / 1 test；`pnpm smoke:performance` 1 file / 1 test；`pnpm typecheck`、`pnpm check:ipc`、strict unused scan、`pnpm build`、full Vitest 322 files / 1804 tests、`git diff --check` 全部通过。 |
| 2026-08-04 | Tracking docs cleanup | 仅修改三份跟踪文档；`git diff --check` 通过，未修改 production/tests/scripts。 |

此前各 stage/part 的 focused 与 broad gates 均在对应提交前通过；Stage 7.4 的全量门禁是 Stage 0-7 当前收口证据。Windows full Vitest 可能输出既有 node-pty `AttachConsole failed` helper stderr，但主命令退出码为 0。

## 2026-08-04 - Tracking Docs Cleanup

- 将三份跟踪文档收敛为当前状态、里程碑/验证和技术发现三份职责；删除已完成的 step 流水、逐会话 resume log、review 过程流水与 errors table。
- `plan.md` 未修改且保持未跟踪。
- 未修改 production/tests/scripts；docs-only verification 为 `git diff --check` 和完整回读。
