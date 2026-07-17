# Roc Agent Harness 执行账本

## Goal

按 `plan.md` 的 Stage 0–7 顺序实施；每阶段完成实现、review、修复、验证和提交；最终仅删除已证明无用的遗留代码。

## Current Phase

Stage 4 — Execution Safety, Budgets, Cancellation (Shell scope gate pending)

## Phases

### Stage 0: Characterization Gate

- [ ] 为六个 P0 路径建立稳定、无外网的复现测试。
- [x] Step 1：同-thread concurrent start 复现；review 无问题，已验证，待提交。
- [x] Step 2：subscriber rejection terminal characterization；当前实现保持 `completed`，与 `plan.md` 旧故障前提冲突，已记录为回归测试。
- [x] Step 3：真实 `RocSqliteCheckpointer` restart + `Command(resume)`；approval 与 `ask_user` 均通过、review 已修复，待提交。
- [x] Step 4a：scheduler 非原子顺序基线；review 无代码问题，待提交。
- [x] Step 4b：四 crash-point/restart fixture；Stage 3 已以持久 task/agent DB、真实 runtime、task plugin startup projector 补齐。
- [ ] Step 5：stream 10k/100k high-water fixture；当前 queue/event log 不暴露 high-water 或 row cap，待 Stage 2/6 instrumentation 后补齐。
- [ ] Step 6：shell/web/hook graph-abort 与 Windows child-tree fixture；web 仅支持内部 timeout，hook 仅支持 timeout tree kill，shell/tool contract 无 `AbortSignal`，待 Stage 4 建立统一执行边界后补齐。
- [ ] Review 测试的真实故障路径和稳定性。
- [ ] 修复 review 发现的问题并提交。
- **Status:** in_progress

### Stage 1: Immutable Run Contract

- [x] 定义 versioned manifest/snapshot，并使 preview 与 executor 共享冻结结果。
- [x] 在 agent DB 同一事务持久化 snapshot、user message、`context_manifest`。
- [x] 让 executor 从持久化 snapshot 重建执行请求，移除第二次授权性 preview 计算。
- [x] 实施、review、修复、验证、提交（workspace dependency、test fixture source、schema-version、普通 chat workspace contract、canonical start/terminal timeline event、task-created audit 及 explicit `/skill` snapshot 合同已修复；review 后新增 origin provenance 与 explicit-skill audit-card 修复。post-review strict unused scan、23 files / 144 focused tests、全量 292 files / 1524 tests、`pnpm check:ipc`、`pnpm typecheck`、`pnpm build`、`ROC_SMOKE_TARGET=dist pnpm smoke:electron`、CodeGraph final review 与 `git diff --check HEAD` 均通过；已独立提交）。
- **Status:** complete

### Stage 2: Durable Run State, Outbox, Bounded Timeline

- [x] 定义 repository CAS transition、state version 与 per-thread active-run invariant。
- [x] 实现 terminal transaction、agent outbox 与 idempotent task projector。
- [x] 替换 `MAX+1` event sequence，建立 transactional append constraint。
- [x] 加 startup reconciliation：旧执行不自动重放；有效 `waiting_user` 保留，其他中断状态原子落为 `interrupted` 并写 durable terminal outbox。
- [x] 补 bounded/coalesced queue、event-row 上界与 backpressure 证据：100k text coalesce、10k structural overflow、10k timeline/replay P95 均有稳定 fixture。
- [x] 收敛 startup、HITL、retry、cancel 的 CAS transition；已删除 `updateRunStatus()`，所有生产状态切换要求 expected status/version。
- [x] 运行 Stage 2 focused/broad verification，独立 review，修复后提交。
- [x] 实施、review、修复、验证、提交。
- **Status:** complete

### Stage 3: Durable Background Occurrences

- [x] Step 1：task v4 occurrence/revision schema、不可变 occurrence request snapshot、唯一 key 与 CAS claim/lease；repository red-green tests 已通过。
- [x] Step 2：把 `dispatchKey=occurrenceKey` 接入 agent start；重复 dispatch 只返回同一 run。
- [x] Step 3：scheduler 先 claim 后 dispatch；重启 reconcile；同 task 不重叠与 misfire latest-only coalesce。
- [x] Step 4：outbox projector 按 occurrence/run 终态回写，旧 run 不覆盖最新摘要。
- [x] Step 5：四 crash point、duplicate fire、revision、power resume、乱序/重复投影与 Electron smoke。
- [x] 实施、review、修复、验证、提交。
- **Status:** complete

### Stage 4: Execution Safety, Budgets, Cancellation

- [ ] 实施、review、修复、验证、提交。
- **Status:** in_progress (blocked on Shell scope product gate)

### Stage 5: Context, Checkpoint, HITL Conformance

- [ ] 实施、review、修复、验证、提交。
- **Status:** pending

### Stage 6: Observability, Integration Tests, Evals

- [ ] 实施、review、修复、验证、提交。
- **Status:** pending

### Stage 7: Native Convergence, Patch Upgrade, Cleanup

- [ ] 实施、review、修复、验证、提交。
- [ ] 以当前工作树完成全量 completion audit。
- **Status:** pending

## Decisions

| Decision | Rationale |
|---|---|
| 先执行 Stage 0 | `plan.md` 明确要求先锁定当前故障，不改变产品行为。 |
| 每个 stage 独立提交 | `plan.md` 明确禁止跨 stage 大提交。 |
| 清理只做 evidence-first deletion | 项目规则与用户目标均禁止凭名称删除。 |
| Scheduler misfire | 用户以“继续”接受推荐策略：同 task 不重叠，睡眠/关机错过多次时只 coalesce 最新一次。 |

## Product Gates

| Gate | Current state |
|---|---|
| Shell scope | 未确认；Stage 4 前必须取得产品选择。 |
| Scheduler misfire | 已确认：同 task 不重叠；misfire 只 coalesce 最新一次。 |

## Errors Encountered

| Error | Attempt | Resolution |
|---|---|---|
| Stage 0 cancellation test paths from `plan.md` absent at expected locations | 1 | Locate current service test names before adding new fixtures. |
| PowerShell did not expand `runtime-*.test.ts` for `rg` | 1 | Use `rg -g` from the test directory. |
| Concurrent-run fixture expected `running`, current executor marks `waiting_next_turn` | 1 | Assert the actual pre-model state while retaining the concurrent-executor assertion. |
| Terminal subscriber fixture timed out because generic error entered recovery retry | 1 | Use a non-retryable `RocDomainError` to model a terminal subscriber failure deterministically. |
| Terminal subscriber fixture still timed out after non-retryable error | 2 | Current `completeRun()` removes the run from `activeRuns` before publish; catch returns without writing failed. Characterize the actual fixed terminal behavior. |
| Combined Step 3 fixture discovery command failed without diagnostic output | 1 | Split CodeGraph, source search, and package inspection into independent commands. |
| Step 3 fixture accessed LangGraph runtime `__interrupt__` as a static state field | 1 | Read the runtime projection through `Reflect.get` and validate it explicitly. |
| Step 3 review found in-memory SQLite did not prove database restart | 1 | Use a temporary file database, close the first connection, then open a new connection before resume. |
| Step 3 review found unused `interrupt` import | 1 | Remove the import; focused test and typecheck pass. |
| Scheduler characterization observed only timer callback after time advance | 1 | Drain scheduled async work with `vi.runAllTimersAsync` before asserting post-start ordering. |
| Scheduler callback fixture referenced nonexistent `BackgroundTask.runId` | 2 | Remove the test-only invalid assertion; scheduled-run absence is the relevant pre-link fact. |
| Stage 0 cancellation discovery referenced nonexistent `src/main/web-read-service.ts` | 1 | Current source is `src/main/services/web-read-service.ts`; rerun discovery against the actual service path. |
| Combined cancellation call-path discovery command failed without diagnostic output | 1 | Split CodeGraph, source search, tests, and plan reads into independent commands. |
| Stage 1 Electron smoke failed after chat submit: `No context_manifest event found after chat submit` | 1 | Locate the context-manifest event production and smoke assertion before deciding whether the mode-aware preview change regressed it. |
| Stage 1 persistence discovery found task projection is not the owner of chat history | 1 | `AgentSessionRepository.createTaskRun()` owns `agent_runs`/`agent_events`; persist the manifest atomically there, not through the task plugin subscriber. |
| Resume document chunk command failed because PowerShell parsed `$p:` as a scoped variable reference | 1 | Split document reads into independent commands; do not repeat the invalid interpolation. |
| Stage 1 parallel focused-test/typecheck batch timed out after 120 seconds without per-command output | 1 | Do not retry the batch; inspect processes and run single focused commands serially. |
| `rtk pnpm test -- <path>` forwarded an extra `--`, so Vitest ran the full suite instead of the target | 1 | Use `rtk pnpm exec vitest run <path>` for focused runs; treat the full-suite failures as regressions to fix. |
| Focused Stage 1 regression suite left `kernel-runtime.test.ts` failing because its test plugin asserts agent schema version 2 | 1 | Locate and update only that stale schema assertion to version 3, then rerun the same focused suite. |
| Composer discovery combined `rg` command failed due PowerShell quote escaping | 1 | Use fixed-string searches and separate commands for input markup and key handlers. |
| Composer diagnostic failed because `page.evaluate` cannot access outer `chatInputEvidence` | 1 | Pass the evidence as the evaluate argument; rerun the smoke without changing production code. |
| Locator Enter patch initially changed the Shift+Enter multiline action | 1 | Restore that action; target only final submission Enter after evidence capture. |
| Resume ledger patch was syntactically incomplete | 1 | Resend a complete patch; no file changed on the rejected call. |
| Smoke result ledger patch was syntactically incomplete | 1 | Resend a complete patch; code was unaffected. |
| Agent-update ledger patch was syntactically incomplete | 1 | Resend a complete patch; code was unaffected. |
| Agent-update root-cause ledger patch was syntactically incomplete | 1 | Resend a complete patch; code was unaffected. |
| Agent-update payload ledger patch was syntactically incomplete | 1 | Resend a complete patch; code was unaffected. |
| Red-test ledger patch missed a drifted error-table line | 1 | Read the table tail, then append with the exact current context. |
| Stage 1 repository red test found initial event count 3, missing canonical `agent_update` | 1 | Add `agent_update: { status: 'running' }` inside `createTaskRun()` transaction, then rerun focused test. |
| Provider-update smoke ledger patch was incomplete | 1 | Resend one complete patch; code was unaffected. |
| Post-smoke audit ledger patch was incomplete | 1 | Resend one complete patch; code was unaffected. |
| Writer/predicate ledger patch was incomplete | 1 | Resend one complete patch; code was unaffected. |
| Task-created detail ledger patch was incomplete | 1 | Resend one complete patch; code was unaffected. |
| Task-created audit red test found payload lacked goal | 1 | Add task goal to the existing `background_task_created` writer, then rerun focused test. |
| Stage 1 review found run origin derived from untrusted workflow hint and scheduler origin unavailable | 1 | Add a trusted scheduler source, require workbench source for workflow hints, and lock both paths with runtime regression tests. |
| Stage 1 review found explicit skills absent from persisted audit cards | 1 | Derive persisted skill cards from the frozen manifest and cover explicit-skill audit visibility. |
| Review red test created an accepted workflow-hint run, then DB teardown observed `clearPendingInterrupt` on a closed connection | 1 | The fixed source rejects the request before persistence; focused green run has no unhandled rejection. |
| Post-review focused suite retained two fixtures that intentionally sent old source provenance | 1 | Update only the fixture source values (`workbench` for workflow tests); the rerun passed 23 files / 144 tests. |
| Stage 2 test discovery used nonexistent `plugin-run-state.test.ts` | 1 | Current file is `tests/main/plugins/task/plugin-run-states.test.ts`; use `rg --files` before test reads. |
| Stage 2 first implementation left `agent_run_leases` absent after `applyAgentPluginSchema()` | 1 | v4 was placed in diagnostics by an over-broad patch context; moved it to `agentMigrations`. Migration/repository suite now passes. |
| Stage 2 impacted suite threw `ReferenceError: hasActiveThread is not defined` on the first `startRun()` | 1 | `createTaskRun()` variable was renamed to `hasExistingThread` but one branch retained the old identifier; corrected that one reference and rerun the same suite. |
| Stage 2 v6 cursor migration caused `FOREIGN KEY constraint failed` in standalone run-event and history deletion tests | 1 | Seed the run fixture before allocating its cursor; delete lease/outbox/cursor rows before deleting agent runs and threads. |
| Stage 2 focused suite found database health/probe fixtures still expected agent v4/task v2 | 1 | Update only version assertions to the current v6/v3 migration ledger. |
| Stage 2 focused suite found streaming fixture asserted text delta chunk boundaries after deliberate queue coalescing | 1 | Assert exact concatenated transcript and structural order; do not require old transport chunk boundaries. |
| Stage 2 typecheck found nullable provider/model passed to `requireNonEmpty`, and new reconcile test used obsolete approval payload shape | 1 | Broaden explicit required-string guard to accept nullable DB fields and fix test payload under `request`. |
| Stage 2 review-repair patch did not match the current `stream-consumers.ts` import context | 1 | No production file changed; re-read current source fragments and resend a smaller exact-context patch. |
| Stage 3 power-resume cron test used `vi.runAllTimersAsync` and recursively executed every future cron timer | 1 | Advance only the due 0ms timer; preserve the future cron timer for the scheduler rather than test execution. |

## Review Notes

- Step 2 spec review P1 已处理：`plan.md` 要求复现 `completed -> failed`，但当前源码在 publish 前移除 active run，故不能也不应人为复活旧故障；回归测试锁住已修正的终态不变量。
- Step 3 review 已处理：fixture 改为关闭并重连同一临时 SQLite 文件，approval 改走真实 Deep Agents `interruptOn`/HITL；最后移除 unused import。
- Step 4 review：当前测试只锁 `startRun -> recordScheduledTaskRun -> markBackgroundTaskFired` 的 gap；不能宣称已满足计划所列四个 crash point。 
- Stage 2 independent standards/spec review (2026-07-17) findings pending repair:
  - P0: queue overflow can leave producer streams running; `AgentRunEventLog` capacity exception can enter recovery/failure; agent outbox `INTEGER PRIMARY KEY` sequence can be reused after history deletion.
  - P1: cancel lacks durable replay/outbox terminal projection; text/reasoning coalescing has no char bound and producers ignore `push()` false; repository terminal writers can allocate beyond row cap.
  - P2: EventBus notification failures are only logged, not counted; assess against available Stage 2/6 observability boundary before final review.
- Stage 2 resume (2026-07-17): first-round findings have implementation and focused verification recorded; no live review worker remains after session recovery. Before any commit, launch a fresh independent re-review against the repaired diff, then repair any new findings and rerun the Stage 2 verification set.
- Stage 2 independent spec re-review (2026-07-17): P0 raw tool output is persisted without centralized redact/size/artifact projection; P1 duplicate final tool terminal backfill remains; P1 startup reconciliation does not use checkpoint/effect evidence; P1 live and replayed terminal failure payloads differ. All require repair before commit.
- Stage 2 independent standards re-review (2026-07-17): P0 startup reconciliation treats background-task placeholder rows with null snapshot/provider/model as executable, throws before plugin initialization, and lacks restart coverage. Repair before commit.
- Stage 2 final review repair (2026-07-17): fixed renderer `run_cancelled` terminal state/type, persisted live `run_failed` diagnostic/suggestion into the canonical transaction and replay, and made main/subagent tool-output projector failures propagate rather than masquerade as tool execution errors. The spec reviewer requested startup auto-resume; disposition: no automatic restart replay is the existing Stage 2 safety decision. Reconciliation uses snapshot/checkpoint/effect evidence to preserve only a safe `waiting_user` state, then the existing explicit `resumeRunAtomically()` path performs resume. No model/tool/effect executes merely because Roc restarted.
- Stage 2 release-spec repair (2026-07-17): queue now delays delivery of text/reasoning deltas to an already waiting consumer, so fast UI consumption cannot bypass the time/character coalescing contract. Task outbox projection is caught at the EventBus boundary; a new controlled `task.outbox.replay` capability replays pending durable rows after the projection store is healthy, with a regression covering failure followed by manual recovery and no new agent event.
- Stage 2 final review and verification (2026-07-17): `run_failed` outbox now strictly retains optional `diagnostic` and `suggestion`; focused regression, strict unused scan, IPC check, diff check, build and full Vitest all passed. Two new independent reviewers reported no findings. Stage 2 has an independent commit; Stage 3 remains blocked only on the explicit Scheduler misfire product gate.
- Step 6 discovery：graph abort 仅到 Deep Agent stream；`run_shell_command`、`ShellExecutionService`、`HookCommandRunner` 都没有 graph `AbortSignal` 入口。`WebReadService` 只有自身 timeout abort。完整 fixture 必须跟随 Stage 4 的生产合同，而不能以架构脆弱性测试伪造完成。
- Stage 1 discovery：Electron smoke 的 user/assistant/task-update 均来自 `AgentSessionRepository`；`capabilityPreview` 只被 EventBus 投影携带，未写 `agent_events`，所以没有 `context_manifest`。正确修复点是 run 创建事务。
- Stage 1 final review：standards/spec review 提出的 run-origin provenance 与 explicit-skill audit-card 缺口均已 red-green 修复；final CodeGraph call-path review 与 whitespace check 未发现新的具体问题。Stage 2 outbox 与 subagent safety parity 仍按 `plan.md` 留在后续阶段，未在本 stage 提前实施。
- Stage 2 re-review repair: `run_cancelled` renderer terminal state, overflow producer settlement, and legacy 10k non-terminal replay reconciliation are active P1 fixes. No Stage 2 completion/commit until their tests, aggregate verification, and a clean independent re-review pass.
