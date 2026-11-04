# Research optimization execution ledger

Task source: [execution plan](research-optimization-execution-plan.md).
User authorized sequential implementation and one commit per verified increment on 2026-11-03.
New contracts replace obsolete interfaces directly. No compatibility aliases are added.
Ownership, authorization, byte integrity and explicit failure contracts remain required.

## M0 — baseline and offline preparation

Status: `Verified passing` for local baseline and deterministic fixture contracts.

Workspace: `/Users/Apple_501/Desktop/Roc/Roc`, branch `main`.
Baseline: `c4bb32769b7815472966c6c620f143b914376752`.
Environment: Node `v26.13.0`, pnpm `12.5.1`, TypeScript `7.0.2`,
macOS `27.0.1` (`26A434`), `arm64`. No dependency installation required.

Pre-existing changes: `docs/README.md`, deletion of six Harness documents,
and untracked `plan/` source documents. These are excluded from implementation commits.
Relevant existing CodeGraph index used; no index creation or refresh.
ADRs 0020/0022/0023/0024/0025 reviewed.

The actual figure reproduction created
`research_run_13a5f9d6-617b-4a53-8455-3656497a44b1` and
`figure_run_3c8742c3-43fb-4852-9a40-a97ade07f30d` in isolated SQLite.
The figure remained `preparing`; passing its ID to the exposed experiment query raised
`research_experiment_not_found`. Its frozen role tools included `get_experiment`.
Evidence: `.artifacts/research-optimization/m0-figure-reproduction.log`.

### Ownership and storage

```mermaid
flowchart LR
    Chat["Agent run — agent DB"] --> Tool["Trusted main-process research tool"]
    Tool --> Stage["Stage runtime — research DB"]
    Stage --> Effects["Production effects — active stage and project ownership"]
    Effects --> Figure["figureRuns"]
    Effects --> Experiment["experiments"]
    Effects --> Export["exports"]
    Chat --> Budget["RunBudgetLedger — agent DB"]
```

Agent and research plugins get separate managed SQLite connections through `DatabasePool`;
schemas, migrations, health probes and backup/restore apply per logical database.
The agent budget ledger is the existing authority for reservations and settlement.
Stage `createAgent()` currently runs outside that ledger. Research task accounting will use
the agent database authority for atomic aggregate admission; research execution rows retain
their own domain lifecycle. Cross-database execution startup must be idempotent and repairable,
without claiming one transaction spans both databases.

`research.*Owned` names in role profiles map to internal tool factories and production effects.
They are not public capability registrations. Public `research.figure.getRun` already exists
and uses `runId`; adding an internal owned read must not expose arbitrary renderer ownership.
Role names/policy/skill instructions are frozen in stage run snapshots. Changed tool contracts
must reject incompatible retries and require a new request.

### Samples and verification

Original CC0 synthetic PDF, metadata, CSV, TypeScript source, Vega-Lite specification,
LaTeX manuscript and bibliography are fixed in `tests/fixtures/research-workflow/manifest.json`.
PDF text/page and all byte hashes are exercised by
`tests/unit/research-workflow-fixture.test.mjs`. The sample is an engineering fixture, not an
independent scientific evaluation dataset.

Commands below ran from the workspace above:

| Command | Actual result |
| --- | --- |
| `pnpm typecheck` | Passed |
| `pnpm check:ipc` | Passed, generated files current |
| `node --test tests/unit/research-workflow-fixture.test.mjs tests/unit/research-job-cancellation.test.mjs tests/unit/database-migrations.test.mjs tests/unit/literature-import.test.mjs tests/unit/research-export-body-gate.test.mjs` | 32 passed, 0 failed |
| `pnpm harness:eval` | 94 deterministic cases passed |

Logs: `.artifacts/research-optimization/m0-{contracts,typecheck,ipc,harness}.log`.
These checks cover the current retrieval/import, job cancellation/cleanup, migration and
export body invariants; they do not establish live-provider quality or full scientific workflow
completion. PDF parsing here is PDF.js fixture readback, not a live OCR benchmark.

Real-model L2: `Blocked, not run`. No isolated account, trusted price table, task/total spend
limits or named operator authorization supplied. Continue offline runner and contract work.
No remote writes, public publication or model spending performed.

## Remaining scope

ROC-PR-02B/C, ROC-PR-03A/B, P0 integration, ROC-PR-04/05,
X-UI, ROC-PR-06/07/09, X-SAFE, ROC-PR-08, X-NB/X-EXP, X-IDEA/X-WRITE,
ROC-PR-10, X-ECO/X-MON and X-PERF/X-CONTEXT/X-OBS remain pending.

## ROC-PR-01 — owned figure polling and publication

Status: `Verified passing` for local tool contracts and real figure service integration.
Baseline: M0 commits `525b1ae2` and `5805839`.

The figure stage now exposes `get_figure` through the internal
`research.figure.getOwned` mapping. Start/query/publish all use `runId`; obsolete
`experimentId` figure inputs fail strict schema validation. Experiment tools keep their own
experiment contract. The effects boundary checks active stage, project and owner before reading.
No new public Owned IPC capability was registered; generated IPC remains current.
Old frozen figure snapshots cannot execute/retry with a changed contract; a new request is required.

The first regression failed against baseline. Real integration then found three additional
blockers needed to satisfy the planned start/query/publish path:

- Relative spec paths reached a job boundary requiring absolute paths.
- Default Vega padding expanded a requested 216×144 figure to 256×189 pixels/points.
- Published figures left their run snapshot's `artifactId` null.

Path resolution remains inside the existing file ownership boundary. Pipeline `/2` uses
fixed overall fit sizing and preserves physical SVG/PDF dimensions at high and fractional DPI.
Publication now attaches its artifact in the same SQLite transaction.
Original failure output is retained under
`.artifacts/research-optimization/figure-dimensions-before/`.
No validator was weakened. Fit limitations for composed/step-based Vega charts are documented.

Commands ran from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `node --test tests/unit/research-figure-owned.test.mjs tests/unit/research-figure-integration.test.mjs` | 9 passed before the additional fractional-size case |
| `node --test tests/unit/research-figure-integration.test.mjs` | Latest 3 passed: real render/publish, 300-DPI fractional dimensions, cancellation |
| `pnpm test:unit` | 582 passed, 0 failed |
| `pnpm check:ipc` | Passed, generated files current |
| `pnpm harness:eval` | 94 deterministic cases passed |
| `pnpm build` | Passed, includes typecheck and Electron production build |

Logs: `.artifacts/research-optimization/pr01-{before,contracts,integration,unit,ipc,harness,build}.log`.
The full unit run began before the additional fractional-size test was added; that final case
was independently exercised in the latest 3-case integration run.
Tests cover foreign project/owner rejection, terminal errors, restart interruption, stage
cancellation, request drift, duplicate starts/publication and immutable old snapshots.
Real renderer tests use original CC0 inputs and Skia PNG/SVG/PDF outputs. Human scientific
approval and real-model quality remain outside these deterministic checks.

Changed modules: role profiles/tools/prompts, production effects, stage snapshot execution,
figure renderer fingerprint/sizing, figure publication/run repositories, figure documentation
and focused tests. No model spending or external writes.

## ROC-PR-02A — trusted task identity and dispatch

Status: `Verified passing` for local task identity, dispatch and persistence contracts.
Baseline: `9ba15a00`.

Research tasks and immutable execution associations live in the agent database (migration 11).
Stage runs store their task ID in the research database (migration 6).
Existing snapshots acquire an explicit null task ID; no historical chat parentage is inferred.
Startup repairs task links only when the authority already contains the matching execution.

Chat dispatch requires a one-use, short-lived broker reference bound to a running chat,
thread, project, frozen manifest and exact stage request. Copied tokens, request drift,
expired/revoked references, changed project/manifest and inactive parents fail before scheduling.
The reference crosses the capability call through main-process asynchronous context.
It never enters renderer input or model arguments.

Direct stage starts create independent roots. Retries share the previous task. Review
roles preserve scientific stage parentage separately from chat parent execution.
Experiments, figures and exports associate before background work starts. Association failure
records a failed domain execution and sends no model/rendering request.
Public capability and IPC schemas reject ownerRunId; internal production effects supply it.
No compatibility aliases or permissive failure fallbacks were added.

Commands ran from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `pnpm test:unit` | 592 passed, 0 failed |
| `pnpm harness:eval` | 94 deterministic cases passed |
| `pnpm generate:ipc` and `pnpm check:ipc` | Passed, generated files current |
| `pnpm build` | Passed, includes typecheck |
| `node --test tests/unit/research-task-identity.test.mjs tests/unit/ipc-execution-boundary.test.mjs tests/unit/database-migrations.test.mjs tests/unit/research-figure-integration.test.mjs` | Final consumer audit: 24 passed, 0 failed |
| `git diff --check` | Passed |

The final IPC consumer correction occurred after the full unit run; the focused final run
exercised actual public IPC parsing and all affected contracts, and production build was repeated.
Logs: `.artifacts/research-optimization/pr02a-{unit,harness,ipc,build,contracts-final}.log`.
This increment establishes execution identity, not unified budget admission or task cancellation.
Those remain ROC-PR-02B/02C. Real-model L2 and scientific review remain unrun.

## ROC-PR-03A — offline protocol and runner foundation

Status: `Verified passing` for offline protocol, runner and data audit.
The full reviewed corpus and live Harness adapter remain `Blocked, not run`.

Protocol v2 requires complete baseline/candidate commit SHAs and permits same-model
comparisons across different commits. Active runner configuration is copied and frozen.
Each task receives three fixed paired repetitions, with counterbalanced arm order.
Adapters receive only the public task view. Independent validators never execute output scripts.
Null, invalid, oversized and failed outputs remain classified in the fixed denominator.
Unsent calls have zero spend; dispatched calls with unknown consumption retain their full ceiling.
Cost ceiling violations and unconfirmed aborts block later dispatch.

Exclusive journals are synced before each call and refuse rerun after process restart.
Reports distinguish fixture execution from live-model evidence.
No live adapter, model call, external account access or external write occurred.
Trusted adapter ceilings alone do not prove Provider enforcement or sandbox fidelity.

The current pilot has 16 tasks, all in the pilot split. Literature/evidence/memory/file/script
families have one source cluster each; the other three families have two clusters each.
The audit reports these actual deficits. No task duplicates or fabricated human reviews
were added to reach the target of 200. Domain review and independent train/dev/holdout
data remain necessary before full quality claims.

Commands ran from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `node --test tests/unit/quality-evaluation.test.mjs tests/unit/quality-runner.test.mjs` | Final 17 passed, 0 failed |
| `pnpm typecheck` | Passed, includes runner |
| `pnpm harness:quality:check` | Passed, reports actual pilot deficits, zero model/network calls |
| `pnpm harness:eval` | 94 deterministic cases passed |
| `pnpm check:ipc` | Passed |
| `git diff --check` | Passed |

Logs: `.artifacts/research-optimization/pr03a-{contracts,typecheck,audit,harness,ipc}.log`.
Continue authorized offline PR-02B/02C while the independent corpus, live adapter,
isolated credentials, attributable prices and spending authorization are prepared.

## ROC-PR-02B — shared task and stage accounting

Status: `Verified passing` for shared task/stage admission and model accounting.
Project-wide budget configuration remains pending.

Agent migration 12 preserves existing calls and progress records while admitting linked
stage executions. Tasks freeze their parent chat policy or the explicit direct-root default.
Missing historical task policies reject dispatch; no guessed caps are introduced.
One immediate SQLite transaction checks task and execution calls, tokens, concurrency
and integer microdollar reservations. Linking a chat attaches its existing calls once.
Unknown consumption survives restart. Permanent stop reasons survive retries and stages.
Temporary concurrency denial does not permanently stop a task.

Stage createAgent now uses the existing budget middleware and observer, with a capped
model output. The real structured-output handler returns messages with structuredResponse;
the middleware reads its raw AIMessage for trustworthy usage. Successful stage settlement
reads stage budget status without requiring a chat row. Envelopes record provider/model.
No model/network calls occurred; the integration model is a local BaseChatModel fixture.
Dollar-capped dispatch without trustworthy pricing rejects.

Commands ran from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `pnpm test:unit` | Final 610 passed, 0 failed |
| `pnpm harness:eval` | Final 94 deterministic cases passed |
| `node --test tests/unit/research-task-budget.test.mjs tests/unit/run-budget-observer.test.mjs` | Final 15 passed, including actual createAgent success/failure |
| `pnpm typecheck` | Passed |
| `pnpm build` | Final production build passed |
| `pnpm check:ipc` | Passed |
| `git diff --check` | Passed |

Logs: `.artifacts/research-optimization/pr02b-{unit,harness,success,typecheck,build,ipc}.log`.
Task cancellation, aggregate diagnostics and shell presentation continue in PR-02C.

## ROC-PR-02C.1 — persistent task cancellation

Status: `Verified passing` for the task cancellation API and cleanup propagation.
Pause, continuation, interruption diagnostics and shell presentation remain pending.

Task cancellation persists the cancelled identity before aborting executions. Shared budget
admission and stage retries refuse cancelled tasks before starting another execution.
Task get, execution tree and cancel capabilities have strict project-scoped IPC contracts.
Agent cancellation resolves its trusted task association and awaits task cleanup, including
when the chat has already ended but its stage is still active.
Task status prevents cancellation recursion.

Only the task's stage roots, review children, owned jobs and direct domain jobs stop.
Owned domain cleanup uses existing stage cleanup; direct experiment, figure and export
tasks use their own services. Concurrent cancellation requests share one pending cleanup.
Cleanup errors are reported after all affected operations settle.
Late model output cannot publish an artifact or run the human gate.
No separate shell, compatibility alias or model/network call was added.

Commands ran from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `pnpm test:unit` | Final 616 passed, 0 failed |
| `pnpm harness:eval` | Final 94 deterministic cases passed |
| `pnpm generate:ipc` and `pnpm check:ipc` | Passed |
| `pnpm build` | Final production build and typecheck passed |
| `git diff --check` | Passed |

Unit coverage includes the actual Agent plugin capability, actual stage runtime, review
child termination, unrelated active stage isolation, delayed cleanup, late output,
direct domain service routing, cleanup failure, persistent identity and IPC boundaries.
Logs: `.artifacts/research-optimization/pr02c-{unit,harness,build,ipc,contracts}.log`.

## ROC-PR-02C.2 — stage pause, continuation and recovery states

Status: `Verified passing` for stage lifecycle and persisted task states.
Aggregate diagnostics, task events, approval-only pause restoration and shell controls remain pending.

Task schema v2 and agent migration 13 distinguish active, paused, waiting approval,
interrupted, failed, cancelled and completed states. Status reasons persist with snapshots;
the checked task status column governs budget admission. Migration upgrades old task records
without inventing execution links or reasons. A schema change is required because the existing
migration engine skips data-only SQL when schema objects already match.

Pause refuses new dispatch before stopping executions and awaits cleanup.
The task policy explicitly keeps its original deadline running during pause.
Continuation of stopped stage work creates a new execution under the same task and frozen
budget. Failed continuation rolls back task activation; old executions remain terminal.
Existing stage retries can explicitly continue failed/interrupted/paused tasks.
Cancelled tasks require the task continuation API.
Permanent budget stop reasons and unknown reservations are retained.

Restart interrupts only linked executions actually left running, preserves cancelled identity,
and starts no new execution. Human approval remains distinct from task completion.
Task states follow actual gate outcomes. A stage cancellation signal is checked again before
the human gate commits after asynchronous verification, fencing late workflow advancement.

Commands ran from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `pnpm test:unit` | Final 623 passed, 0 failed |
| `pnpm harness:eval` | Final 94 deterministic cases passed |
| `pnpm generate:ipc` and `pnpm check:ipc` | Passed |
| `pnpm build` | Final production build and typecheck passed |
| `git diff --check` | Passed |

Seven lifecycle regressions exercise pause cleanup, unchanged deadline/budget, new execution
identity, activation rollback, real approval, cancellation during verification, restart and
the real v12 database upgrade. Logs: `.artifacts/research-optimization/pr02c-lifecycle-*.log`.

## ROC-PR-02C.3 — task diagnostics and approval restoration

Status: `Verified passing` for authoritative summaries and paused approval restoration.
Task event correlation and shell presentation remain pending.

Task and execution budget views share one aggregation implementation and the same call rows.
The task summary reports known, unknown and reserved consumption without adding run totals
again. Domain diagnostics expose execution status, actual model identity, error codes,
timestamps, parent associations and artifact IDs. Prompt envelopes and credentials are omitted.
External service costs remain explicitly unknown, separate from application model amounts.
Chat lookup validates the persisted thread and task project before returning diagnostics.
It supports the actual chat lifecycle states, including recovery and dispatch transitions.

Paused approval can be restored to waiting approval without recreating the completed stage,
resetting its budget/deadline or calling a model. Pending cleanup still blocks restoration.
The diagnostics contract identifies stopped stage continuation and approval restoration
from authoritative domain records, not renderer counters.

Commands ran from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `pnpm test:unit` | 626 passed, 0 failed |
| `pnpm harness:eval` | 94 deterministic cases passed |
| `node --test tests/unit/research-task-diagnostics.test.mjs tests/unit/research-task-cancellation.test.mjs tests/unit/research-task-lifecycle.test.mjs tests/unit/run-budget-ledger.test.mjs` | Final consumer audit: 19 passed, 0 failed |
| `pnpm generate:ipc` and `pnpm check:ipc` | Passed |
| `pnpm build` | Final production build and typecheck passed |
| `git diff --check` | Passed |

The final consumer audit expanded diagnostics to the canonical chat status schema after
the full unit run. Focused contracts and production build were repeated after that change.
Logs: `.artifacts/research-optimization/pr02c-diagnostics-*.log`. No model/network calls.

## ROC-PR-02C.4 — durable task and model-call events

Status: `Verified passing` for task event correlation and replay.
Shell presentation and live invalidation remain pending.

Agent migration 14 records task creation/status, execution linkage, prior-call attribution,
reservations, settlement and startup uncertainty. SQLite triggers write each event in the
same transaction as its authoritative change. Activation rollback removes its status event;
denied/duplicate calls and duplicate settlement create no success event.
Events carry task, execution kind/ID and call ID, with monotonic sequence cursors.
Project-scoped replay uses explicit page size and cursor and returns actual stored events.
Migration retains existing tasks without fabricating historical event rows.
Event payloads contain no prompt envelopes or credentials.

Commands ran from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `pnpm test:unit` | Final 630 passed, 0 failed |
| `pnpm harness:eval` | Final 94 deterministic cases passed |
| `pnpm generate:ipc` and `pnpm check:ipc` | Passed |
| `pnpm build` | Final production build and typecheck passed |
| `git diff --check` | Passed |

Coverage includes actual createAgent success/failure correlation, prior billed chat linkage,
startup unknown conversion, rollback, duplicate attempts, pagination/project isolation and
the real v13 database upgrade. Logs: `.artifacts/research-optimization/pr02c-events-*.log`.
No model/network calls; integration model attempts use local fixtures.

## ROC-PR-02C.5 — live invalidation and cleanup refusal

Status: `Verified passing` for backend notifications and persistent cleanup failure.
Shell presentation remains pending.

Native task notifications carry only task and project identifiers. Trusted linkage,
model budget observations, terminal stage state and task actions invalidate persisted
diagnostics. Delivery failure logs a warning without changing accounting or execution.
Cleanup failures persist their reason; continuation and approval restoration refuse
unconfirmed cleanup. Foreign-project requests produce no notification.

Commands ran from `/Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `pnpm test:unit` | 633 passed, 0 failed |
| `pnpm harness:eval` | 94 deterministic cases passed |
| `pnpm generate:ipc` and `pnpm check:ipc` | Passed |
| `pnpm build` | Production build and typecheck passed |
| `LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false ROC_SMOKE_TARGET=dist node scripts/smoke-electron.mjs` | 12/12 passed, zero renderer errors, exit 0 |
| `git diff --check` | Passed |

Logs: `.artifacts/research-optimization/pr02c-notifications-*.log`.
Smoke used temporary application data/workspace and a local stub Provider.
No paid model requests or tracing exports.

## ROC-PR-02C.6 — assistant controls and management task diagnostics

Status: `Verified passing` for shell presentation, cursor task listing and event replay.
PR-02C implementation is complete; broader P0 integration remains pending.

The assistant shows persisted task progress and known/unknown/reserved budget amounts.
Pause, whole-task cancellation, continuation and approval restoration use authoritative
APIs. Pending stop actions remain pending until resource cleanup responds; failures remain
visible and unconfirmed cleanup disables continuation. User actions are the only dispatch
trigger. A task notification invalidates reads rather than incrementing a local counter.

The existing management drawer lists project tasks with stable creation cursors and shows
parent execution associations, provider/model identity, timestamps/duration, errors,
artifact IDs and paginated stored events. The shell owns selected task identity.
Project/thread/task changes drop stale reads and notification subscriptions are disposed.
Task metadata uses 12px system tokens. No extra route, shell or dependency was added.

Commands ran from `/Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `pnpm test:unit` | 634 passed, 0 failed |
| `pnpm harness:eval` | 94 deterministic cases passed |
| `pnpm generate:ipc` and `pnpm check:ipc` | Passed |
| `pnpm build` | Final production build and typecheck passed |
| `pnpm check:renderer-chunks` | Passed; eager JS 1,131,037 bytes across 6 files |
| `pnpm test:renderer` | Parallel run: 42 passed, 2 existing window/anchor tests timed out |
| `node --test --test-concurrency=1 tests/renderer/` | 44 passed, 0 failed before the final pagination test addition |
| `node --test tests/renderer/research-tasks.test.mjs` | Final 8 passed, 0 failed including added task pagination |
| `LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false ROC_SMOKE_TARGET=dist node scripts/smoke-electron.mjs` | 12/12 passed, zero renderer errors, exit 0 |
| `git diff --check` | Passed |

The parallel renderer failures were transcript anchor and settings dialog focus timeouts;
their unchanged checks passed with serialized test files. The new renderer suite first
failed because its audit helper was evaluated as a function without invocation; corrected
the invocation and retained the cut=0 assertion. No production check was relaxed.

Logs: `.artifacts/research-optimization/pr02c-ui-*.log`. Real Electron screenshots and
four light/dark assistant/drawer audits are in `.artifacts/research-optimization/task-ui/`;
each audit reports cut=0 and hidden=0. The isolated smoke uses a localhost stub Provider.
No paid model requests or tracing exports. Artifact opening/inspection belongs to X-UI.

## ROC-PR-02B.2 — project-wide model budget authority

Status: `Verified passing` for project/task/stage model admission and explicit configuration.
Project model budgets are now complete; P0 integration/live evaluation remain pending.

Agent migration 15 attributes original call rows to their trusted project and records the
project policy revision used for each new model reservation. Root chats use their frozen
project snapshot before any research stage association. Later task linkage does not create
another call or charge. Historical calls gain only stored project attribution; historical
budgets/revisions are not invented.

An explicit project policy caps model calls, concurrency, aggregate Tokens and optional
integer microdollar cost. Missing policies refuse model dispatch. Project, task and stage
admission plus call INSERT share the same SQLite immediate transaction. Unknown attempts
retain their ceilings; missing cost ceilings reject dollar-capped dispatch. Revision history
is immutable, all project consumption remains cumulative, and raising a cap does not reset
spend. Temporary concurrency refusal is not permanent. A delayed old-policy refusal cannot
block a new policy revision. Project stop reasons do not permanently exhaust task budgets.

The existing management drawer provides explicit project budget configuration and live
known/unknown/reserved summaries. Writes retain the draft's original revision, surface
conflicts and lock inputs until completion. Native get/save/notification IPC validates the
project and contains no model prompts. Smoke fixtures configure their isolated budget.

Commands ran from `/Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `pnpm test:unit` | Final 641 passed, 0 failed |
| `pnpm harness:eval` | Final 94 deterministic cases passed |
| `pnpm generate:ipc` and `pnpm check:ipc` | Passed |
| `pnpm build` | Final production build and typecheck passed |
| `pnpm check:renderer-chunks` | Passed; eager JS 1,131,037 bytes across 6 files |
| `node --test --test-concurrency=1 tests/renderer/` | 47 passed before the final write-lock review |
| `node --test tests/renderer/research-tasks.test.mjs` | Final 10 passed including project policy configuration/revision and pending write locks |
| `LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false ROC_SMOKE_TARGET=dist node scripts/smoke-electron.mjs` | 12/12 passed, zero renderer errors, exit 0 |
| `git diff --check` | Passed |

Initial failures were outdated v14 assertions, two hand-written database fixtures and
missing required thread goal/workspace values in new fixtures. The hand-written ledger
schema was removed in favor of real migrations, and required inputs were supplied without
relaxing constraints. Seven project regressions cover independent task competition, two
connections, retained unknown spend, actual provider refusal, root chat attribution, v14
migration, project ownership/revisions and stale-policy refusal.

Logs: `.artifacts/research-optimization/pr02b-project-*.log`. All model attempts are local
fixtures or the isolated localhost smoke Provider. No paid requests or tracing exports.

## P0.1 — fixed-data experiment, figure and human gate integration

Status: `Verified passing` for this bounded offline production chain. Full P0 remains
unfinished: retrieval/PDF/manuscript/review/export and the fault matrix need separate
checks; live L2 still requires isolated credentials, pricing and spending authorization.

The real TypeScript service launches Electron as Node under the native sandbox and Node
permissions, computes A=2/B=4 from the frozen CSV, indexes the output and publishes the
experiment. The figure stage captures that actual located result as evidence, renders
PNG/SVG/PDF with Skia, polls the correct figure repository, publishes and completes both
human gates. Chat, stage and owned domain jobs share one task identity. Original call
rows account for three local fixture attempts and 60 settled Tokens; costs remain unknown.

This regression exposed a production startup failure: the sandbox allowed Electron's
executable but omitted its bundled Frameworks. The bundled-node environment now declares
that directory for read access. Execution, networking and writes retain their existing
policies. The test uses public published figure source reads and actual template/export
services for cleanup; no approval or source evidence is mocked. The role model response
and tool choices are deterministic fixtures, so this does not establish model quality.

Commands ran from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false node --test tests/unit/research-p0-production-integration.test.mjs` | 1 passed; real process, renderer and approval |
| `LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false pnpm test:unit` | 642 passed, 0 failed |
| `pnpm harness:eval` | 94 deterministic cases passed |
| `pnpm build` | Production build and typecheck passed |
| `pnpm check:ipc` | Passed |

Failed draft runs retained in planning progress: missing raw C loader, missing cleanup
dependency, then the reproduced dyld refusal and the correctly refused evidence-free
figure approval. Checks were corrected against real contracts; no human gate was relaxed.

Logs: `.artifacts/research-optimization/p0-*.log`. Real output files, SHA-256 records,
located evidence, sanitized task diagnostics, events, runtime identity and both database
backups are retained under `.artifacts/research-optimization/p0-production/<taskId>/`.
No paid Provider request, tracing upload or remote write occurred.

Final isolated Electron smoke:
`LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false ROC_SMOKE_TARGET=dist node scripts/smoke-electron.mjs`
passed 12/12 with zero renderer errors and exit 0.

Follow-up discovery: the pinned toolchain exists at `.runtime/research-toolchain/darwin-arm64`;
the actual ResearchToolchain.status check verified its manifest and locked versions
(Tectonic 0.17.0, Vale 3.24.0, Typst 0.15.0). Missing system PATH binaries do not block
the next local manuscript/export integration.

## P0.2 — standard offline research workflow and real export

Status: `Verified passing` for the standard fixture chain and the report-failure case.
P0's other failure scenarios and authorized live L2 evaluation remain unfinished.

A trusted chat task now exercises discovery, frozen literature search, explicit import,
actual source PDF parsing and located evidence capture, ideation/planning, frozen TypeScript
data execution, published Skia figures, evidence-backed manuscript, three review children
and synthesis, human acceptance, native Tectonic/Typst compilation, export approval and
local ZIP delivery. Search/model responses are deterministic local fixtures. Parsing and
figure/PDF rendering call actual production implementations in process, so this does not
establish packaged-worker isolation, OCR or model quality.

The standard task has 17 executions and 14 original model calls / 280 settled Tokens.
Costs remain unknown. Source/output/ZIP SHA-256 values, execution tree, events, budgets,
source evidence, both databases, compiled PDFs and first-page previews are retained.
PDF text readback verifies A=2/B=4 and the report's project identity. Both previews were
visually inspected: chart bounds, text, captions/references and Chinese report tables render.

True export exposed a Typst bug: paths relative to rootPath were evaluated with jobDir cwd.
The compiler now runs in rootPath. Report generation is a required part of the delivery
contract; the old catch that returned success without report.pdf/report.typ was removed
under the user's no-defensive-code instruction. Export docs and ADR 0025 reflect the new
behavior. An injected Typst refusal now persists a failed export/stage/task and diagnostic,
with no archive or artifact. Publication and local write both refuse it.

Native-toolchain scenarios moved to `tests/integration/research-p0-production.test.mjs`
and `pnpm test:research-p0`; ordinary unit checks do not require a prepared .runtime.
The suite requires and verifies actual pinned tools, with no missing-tool skips.

Commands ran from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `pnpm test:research-p0` | Final 3 passed including real PDF readback/previews and report-failure refusal |
| `LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false pnpm test:unit` | 641 passed, 0 failed |
| `pnpm harness:eval` | 94 deterministic cases passed |
| `pnpm build` | Production build and typecheck passed |
| `pnpm check:ipc` | Passed |

Draft failures were a guessed library list request, a guessed PDF chunk identity, a
shared fixture-model structured tool name across review children, and the real Typst
path failure. Fixture errors were corrected against actual APIs; temporary wrappers
were removed. No Provider spending, tracing upload, remote write or compatibility alias.
Logs: `.artifacts/research-optimization/p0-standard-*.log`. Outputs: the P0 production
artifact directory. Remaining P0 work is the cancellation/restart/stale-approval/retry/
unknown-usage/MCP/hostile-document matrix and packaged-worker checks.

Final P0.2 isolated Electron smoke:
`LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false ROC_SMOKE_TARGET=dist node scripts/smoke-electron.mjs`
passed 12/12, zero renderer errors, exit 0.

## P0.3 — built worker isolation and strict worker availability

Status: `Verified passing` for native metadata/PDF/figure/preview workers. The remaining
P0 fault matrix and live L2 evaluation are still unfinished.

The P0 command now builds current production output and launches its test runner under
Electron's Node runtime. Fixtures copy the actual built CLI/chunks into an isolated module
directory. Metadata import, PDF parsing, Skia rendering and PDF previews run real child
processes under the native sandbox. The same full workflow and failed-report cases pass
without an in-process rendering/parser substitute. This verifies built-worker behavior,
not a signed release bundle or OCR model quality.

Real isolation found two product errors. Figure source paths are relative on the wire,
but the sandbox read list required absolute paths. The source is already inside the
readable frozen projectRoot, so the duplicate source grant was removed. The handwritten
package list omitted static/transitive CLI dependencies (the first refusal was yauzl).
Worker reads now use the application's package.json and installed node_modules code
directory, including pnpm links. Write, network, process and model-data boundaries are
unchanged. Missing application package scope fails explicitly.

The old jobInProcess downgrade and its ignored package-resolution errors were removed.
Every missing production worker now rejects with research_worker_unavailable. A regression
went red against the old path (metadata processing executed and raised a data error), then
passed after removal. Fixture cleanup hooks now remain at module scope; registration
inside before had removed worker files before the scenarios could exercise them.

Commands ran from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `pnpm test:research-p0` | Fresh production build/typecheck passed; initial final run passed 2/3 before a fixture preview-path correction |
| `node scripts/run-research-p0.mjs` | Final 3/3 native worker scenarios passed after moving fixture preview output under its writable job directory |
| `LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false pnpm test:unit` | 642 passed, 0 failed |
| `pnpm harness:eval` | 94 deterministic cases passed |
| `pnpm check:ipc` | Passed |
| `git diff --check` | Passed |

The sandbox correctly rejected a fixture preview outside jobDir; the fixture was corrected
without granting additional writes. Host Homebrew Node was unsuitable for an Electron
worker test due to dylib paths; tests now use the actual Electron executable. All temporary
DEBUG-p0-worker instrumentation was removed. Logs: `.artifacts/research-optimization/p0-worker-*.log`.
Native outputs, task/accounting/event receipts and both DB backups remain in the P0
production artifact directory. No paid model request, tracing upload or remote write.

- P0.3 final isolated Electron smoke: `LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false ROC_SMOKE_TARGET=dist node scripts/smoke-electron.mjs` passed 12/12, zero renderer errors, exit 0.

## P0.4 — native budget, cancellation, source and retry faults

Status: `Verified passing` for five core P0 fault scenarios. Restart, hostile PDF and
MCP unknown-side-effect integration remain pending, along with live L2 prerequisites.

The native suite now proves that a task model cap stops before the next actual SDK attempt
and persists the same stage/task/budget reason; missing model usage retains one original
unknown call and a nonzero token ceiling; and a figure published before stage failure is
retained on retry, with one native figure job/publication and both stage identities.
Retries use the frozen explicit Provider/model, and artifact/model provenance is retained.

Cancellation waits until a real native child creates its render directory while its owned
job is running. The task/controller then cancels the stage, renderer and chat identity,
waits for cleanup and rejects late publication. A separate human-approval race reparses
the actual source PDF during verification. Its old evidence reference becomes superseded;
approval refuses, leaves the artifact draft and task waiting, and records source/evidence/
parse IDs and source hash. Editing claims while waiting was correctly refused; that draft
probe was replaced with the legitimate source reparse event rather than bypassing the guard.

Every fault retains task diagnostics, original sanitized call rows, events, native execution
file/hash lists, both databases and changed/refused object identities under the P0 production
artifact directory. The fixture makes SDK/tool choices; these checks establish hard contracts,
not live model attack resistance or scientific quality.

Commands ran from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `node scripts/run-research-p0.mjs '--test-name-pattern=task model cap|untrusted model usage|stage retry'` | Final 3/3 passed |
| `node scripts/run-research-p0.mjs '--test-name-pattern=cancelling a task|claim version change'` | Cancellation passed; initial illegal fixture claim edit was correctly refused |
| `node scripts/run-research-p0.mjs '--test-name-pattern=source PDF reparse'` | Final 1/1 passed with real source reparse/invalidation |
| `pnpm test:research-p0` | Fresh production build/typecheck and all 8 native integration scenarios passed |
| `git diff --check` | Passed |

No product implementation changed in this increment. Runner supports Node test selection
flags. Unknown usage produces call_unknown instead of a successful settlement event; the
fixture now asserts that actual event. No check was weakened, no paid calls or remote writes.
Logs: `.artifacts/research-optimization/p0-fault-*.log`.

## P0.5 — native experiment and figure restart recovery

Status: `Verified passing` for two offline restart scenarios. Hostile PDF and MCP
unknown-side-effect integration remain pending. Live L2 prerequisites are unchanged.

The suite waits for a real sandboxed experiment output marker or native figure render
marker, backs up both databases while the job and stage are running, and shuts down the
owned native process. Reopening those running snapshots exercises the actual startup
budget, dispatch-grant, stage, experiment and figure recovery methods. Running executions
become interrupted, their ownership and task identities survive, an outstanding model
reservation remains unknown, issued grants are revoked, and late publication refuses.
No new stage or Provider request is automatically dispatched. Graceful cleanup cancels
the original owned job; the reopened crash snapshot correctly records it as interrupted.
This is persisted crash-state recovery with real child cleanup, not an OS process-kill test.

Command from `/Users/Apple_501/Desktop/Roc/Roc`:
`node scripts/run-research-p0.mjs '--test-name-pattern=restart during'` passed 2/2.
`git diff --check` passed. No product code changed, so no rebuild was needed.
Log: `.artifacts/research-optimization/p0-restart.log`. Before/after DB snapshots,
original running identities, recovered file/hash lists, diagnostics and events are retained
under `.artifacts/research-optimization/p0-production/<taskId>/`.

## P0.6 — hostile PDF and native secret boundaries

Status: `Verified passing` for the offline hostile-document contract scenario. MCP
unknown-side-effect integration is still pending; live model attack quality is untested.

An original Tectonic PDF contains actual authority-escalation and secret-exfiltration
instructions. The isolated parser reads those instructions, but the parent manifest and
issued grant count remain unchanged. Cross-project dispatch, cross-project production
read, out-of-workspace traversal and unavailable reading-stage shell/MCP/write tools
are refused. The real experiment then attempts to read and overwrite a synthetic secret
outside its frozen inputs. Node permission denies both accesses; the secret is unchanged
and no secret bytes appear in outputs/logs. This deterministic adversarial fixture proves
hard boundaries, not live-model prompt-injection success rates or a network attack trial.

From `/Users/Apple_501/Desktop/Roc/Roc`:
`node scripts/run-research-p0.mjs '--test-name-pattern=hostile PDF'` finally passed 1/1,
including retained PDF/parsed content. `git diff --check` passed. No product code changed.
Earlier fixture assertions guessed project/path denial names and omitted Node's
ERR_ACCESS_DENIED; all were corrected to real contracts without weakening any guard.
Logs: `.artifacts/research-optimization/p0-hostile-pdf-*.log`. Native denials, frozen source
hash, original PDF, actual parsed content, diagnostics, events and both DBs remain under
the P0 production artifact directory. No real credentials or remote writes were used.

## P0.7 — actual MCP timeout, receipt query and no-resend replay

Status: `Verified passing` for the complete 12-scenario offline native P0 suite.
Live L2 remains `Blocked, not run`: no isolated credentials, attributable prices,
spending authorization/limits or independently reviewed 200-task corpus.

A real local stdio MCP server commits one write, withholds the response, and exposes
its durable receipt through a query tool. The actual client adapter, discovered frozen
contracts and effect middleware retain the timeout as unknown. Another middleware call
refuses before invoking the handler; deleting unresolved history is also refused. A
queried receipt must match the input digest and operation identity. A different valid
operation hash is rejected. After reconciliation, the original tool result replays through
the middleware with no resend: one write, one receipt query and one handler invocation.
The actual MCP child exits after adapter cleanup. No shared remote service was written.

Commands from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `node scripts/run-research-p0.mjs '--test-name-pattern=MCP timeout'` | Final 1/1 passed |
| `node scripts/run-research-p0.mjs` | Complete offline/native P0 matrix 12/12 passed |
| `pnpm typecheck` | Passed |
| `git diff --check` | Passed |

The first fixture used runtime names in the remote allowlist; corrected to write/query
and bound actual discovered contracts. A malformed mismatch ID was corrected to a valid
different digest so the semantic mismatch check was exercised. No product behavior or
checks were weakened. Logs: `.artifacts/research-optimization/p0-mcp-timeout-*.log` and
`p0-fault-matrix-final.log`. Server receipts, unknown/resolved identities and both DBs are
retained under the P0 production artifact directory. Next: PR-04 academic search fusion.

### P0 fixture placement correction

A subsequent complete unit run during PR-04 found that the new MCP server had been
placed inside the frozen CC0 research-workflow directory. Its immutable file-list
check failed (644/645 unit checks passed). The server now lives in
`tests/fixtures/mcp/receipt-server.mjs`; the original dataset manifest and hashes stay
unchanged. From the repository root, `node --test tests/unit/research-workflow-fixture.test.mjs`
passed 2/2 and `node scripts/run-research-p0.mjs '--test-name-pattern=MCP timeout'`
passed 1/1 after relocation. Logs: `p0-mcp-fixture-manifest.log` and
`p0-mcp-fixture-relocated.log` in the research optimization artifact directory.
Status: `Verified passing` for the corrected fixture boundary.

## PR-04.1 — reproducible RRF and retained provider metadata

Status: `Verified passing` for deterministic ranking, frozen candidate provenance and
existing native consumers. The complete PR-04 remains in progress: Provider request/
pagination receipts, strict response contracts, cache/quota/health, arXiv/PMID aliases,
version/type/license/retraction UI and independently labelled retrieval metrics remain.

Search now uses RRF v1, k=60 and equal selected-source weights. Original source ranks
are retained; a source gives one contribution per identity despite duplicate records.
Source priority selects a whole canonical metadata record, independently of ranking
weight and completion order. Stable identity breaks score ties without locale. DOI
variants normalize to one identity; title similarity never merges papers. Candidate
snapshots retain all source records, original metadata hashes, ranks, dates, disagreements
and explicit selection reason. Both direct and stage-owned search use this ranking.
Model previews omit full provider records and bound conflict values; the scoped store
retains originals. Search alone still cannot import. Old search snapshots fail under the
new v2 contract without guessed fields or rewriting library/history.

Source changes: literature-fusion.ts, literature-service.ts, literature-import-service.ts,
literature-tools.ts and literature-import schema; focused regressions and
`docs/research-literature-fusion.md`. The documentation is explicitly allowed by the
existing docs whitelist. The obsolete first-source dedupe implementation was removed.
No dependency, database migration, compatibility alias or renderer change was added.

Commands from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `node --test tests/unit/literature-import.test.mjs` | 12/12 focused cases passed before adding the final old-snapshot case |
| `pnpm test:unit` | Final rerun 645/645 passed before that test-only addition |
| `node --test '--test-name-pattern=old search snapshot' tests/unit/literature-import.test.mjs` | Final added contract 1/1 passed |
| `pnpm harness:eval` | 94/94 deterministic cases passed |
| `pnpm generate:ipc` / `pnpm check:ipc` | Current generated contracts; no generated bytes changed |
| `pnpm test:research-p0` | Fresh production build/typecheck and all 12 native P0 cases passed |
| `git diff --check` | Passed |

The initial unit run caught the separately committed MCP corpus placement correction.
An existing source-index Retry-After assertion was updated to identify its source after
ordering became fixed. No check was weakened. Official OpenAlex help/Context7 and
Crossref tips were read on 2026-11-03; Semantic Scholar docs returned 429 and Europe PMC
returned 403. No live Provider, model, credential or external write was used. Docs make
those research/quality limits explicit. Logs: `.artifacts/research-optimization/pr04-fusion-*.log`.

## PR-04.2A — strict Provider response contracts

Status: `Verified passing` for all six response adapters and existing native consumers.
Remaining PR-04 work is unchanged: request/pagination receipts, caching/quota/health,
arXiv/PMID aliases, candidate metadata UI and independent retrieval evaluation.

Every adapter now validates result containers and required paper identity/title fields
with the installed Zod 4.6.7. A valid empty container remains empty; missing containers,
HTTP200 error objects, missing identities and invalid types fail that source explicitly
with literature_provider_response_invalid. Random IDs, invented Untitled titles, unchecked
payload casts and obsolete payload type guesses were removed. Optional metadata still
uses its declared unknown state. Source selection requires actual network sources; the
unused local empty-success branch was removed. OpenAlex now sends per_page. arXiv
validates XML grammar and Atom shape, refuses error entries and preserves declared DOI.

Changed: literature-provider-schemas.ts, literature-service.ts, focused regressions and
research-literature-fusion.md. No dependency, migration or renderer change.

Commands from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `node --test tests/unit/literature-import.test.mjs` | Initial 15/15 passed before the XML syntax addition |
| `pnpm typecheck` | Initial passed; final included in the production build |
| `pnpm test:unit` | Final 648/648 passed including malformed XML |
| `pnpm harness:eval` | 94/94 passed |
| `pnpm test:research-p0` | Fresh production build/typecheck and 12/12 native P0 passed |
| `git diff --check` | Passed |

Official arXiv Atom/error/DOI documentation and matching Zod/fast-xml-parser primary
Context7 docs were checked. Europe PMC and Semantic Scholar documentation fetch limits
remain recorded; no live API availability or academic coverage claim is made. All Provider
responses were local fixtures. Logs: `.artifacts/research-optimization/pr04-provider-contract-*.log`.

## PR-04.2B — per-source HTTP request receipts

Status: `Verified passing` for returned search outcomes and the complete native consumer
chain. Cache/quota/health, later paging and independently durable cancelled-inflight
request records remain pending, along with the rest of PR-04.

Search snapshot v3 retains each actual GET attempt: exact query URL and first-page
parameters, start/end times, HTTP status, Retry-After, raw-response-byte SHA-256 and
transport/HTTP failure code. Every source has its own AsyncLocal request context. HTTP
backoff waits occur outside each attempt; retries remain separate. HTTP200 schema errors
retain their actual transport receipt while the source records payload failure. Network
failure has no invented status or hash. Missing internal request context refuses explicitly.
The duplicate default fetch wrapper was removed; all requests still cross the common
URL allowlist and explicit GET/redirect:error boundary. Headers/credentials and response
bodies are not added to the receipts. Old snapshots are not upgraded with guessed fields.

Changed: literature-service.ts, literature-import-service.ts, literature-import schema,
focused regressions and research-literature-fusion.md. No dependency or migration added.

Commands from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `node --test tests/unit/literature-import.test.mjs` | Focused 17/17 passed |
| `pnpm typecheck` | Passed; final repeated inside production build |
| `pnpm test:unit` | Final 650/650 passed |
| `pnpm harness:eval` | 94/94 passed |
| `pnpm check:ipc` | Current generated contracts |
| `pnpm test:research-p0` | Fresh production build/typecheck and 12/12 native P0 passed |
| `git diff --check` | Passed |

Tests query actual persisted snapshots after HTTP429/200 retry, verify exact response
hashes, distinguish transport and payload errors, and force out-of-order concurrent
responses without cross-source receipts. Native P0 retained updated searches in its DB
backups. Logs: `.artifacts/research-optimization/pr04-provider-receipt-*.log`.
No live Provider/model request, credential access or external write.

## PR-04.2C1 — bounded validated-response cache and parent-first shutdown

Status: `Verified passing` for project-scoped cache and actual plugin/stage lifecycle.
Provider quotas/health, paging and independently durable cancelled-inflight receipts
remain pending. No academic retrieval metric or live availability claim.

Snapshot v4 records cache miss or hit with original retrieval timestamp and response
hash. The process-local LRU permits 32 entries, 8 MiB UTF-8 response text and a five-minute
TTL; its key includes trusted project, exact URL/query/page and response format. Only
validated results enter it. Hits make zero HTTP attempts and preserve metadata identity.
The import service persists the project supplied by trusted execution context.

Shutdown now starts actual parent interruption before search/import/native cleanup.
All cleanup runs through the existing aggregate helper. Search waits for active requests,
clears its cache and rejects new reads; late role output cannot publish an artifact.
No obsolete snapshot adapter, disk cache, dependency or migration was introduced.

Changed: literature-response-cache.ts, literature-service.ts, literature-import-service.ts,
research-plugin-lifecycle.ts, index.ts, literature-import schema, focused tests and
research-literature-fusion.md.

Commands from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `node --test --test-name-pattern='plugin shutdown interrupts' tests/unit/literature-import.test.mjs` | Red: closed service still accepted a new read |
| `node --test tests/unit/literature-import.test.mjs` | Final 21/21 passed |
| `pnpm typecheck` | Passed |
| `pnpm test:unit` | 654/654 passed |
| `pnpm harness:eval` | 94/94 passed |
| `pnpm check:ipc` | Current generated contracts |
| `pnpm test:research-p0` | Fresh production build/typecheck and 12/12 native cases passed |
| `LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false ROC_SMOKE_TARGET=dist node scripts/smoke-electron.mjs` | 12/12 passed, zero renderer errors, exit 0 |
| `git diff --check` | Passed |

Retained logs: `.artifacts/research-optimization/pr04-cache-*.log`.

## PR-04.2C2 — shared host quota, concurrency and health

Status: `Verified passing` for application admission and local Provider fault fixtures.
Paging, durable cancelled-inflight receipts, strong aliases, candidate UI and independent
retrieval quality metrics remain pending.

Snapshot v5 records source host health, consecutive failures, local remaining requests
and quota reset, enforced interval, cooldown and observed success/failure timestamps.
Existing FIFO network resource claims serialize each host through payload validation;
unrelated hosts continue concurrently. PubMed/Europe PMC share the EBI gate and quota.
Application policy permits 300 attempts per host per fixed hour, one active connection,
one-second spacing and three-second arXiv spacing. Retry attempts consume quota. Cached
responses and denied admission do not. This process-local policy is not a remote quota
claim and resets on restart.

Retry-After applies to other projects and queued searches. Response rate headers can
tighten spacing, never increase local allowance. Three consecutive actual HTTP, transport,
timeout or payload failures open a 60-second breaker. Validated new responses restore
health; cached reads do not. User cancellation/shutdown do not count as source failures.
Queued cancellation prevents HTTP dispatch. Admission failures retain explicit errors
and no invented HTTP receipts.

Removed the unused unscoped search wrapper and its obsolete shared request type/schema;
the only production consumer uses the bounded, trusted-context import request. No alias,
dependency, migration, renderer flow or credential was added.

Changed: literature-provider-governor.ts, literature-service.ts, literature-import-service.ts,
literature-import/research schemas, research types, focused regressions and fusion docs.

Commands from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `node --test --test-name-pattern='concurrent searches share one host' tests/unit/literature-import.test.mjs` | Red: two simultaneous same-host dispatches |
| `node --test tests/unit/literature-import.test.mjs` | Final 27/27 passed |
| `pnpm typecheck` | Passed |
| `pnpm test:unit` | 660/660 passed before final unused API deletion |
| `pnpm harness:eval` | 94/94 passed before that deletion |
| `pnpm check:ipc` | Current after deletion |
| `pnpm test:research-p0` | Final fresh build/typecheck and all 12 native cases passed after deletion |
| `git diff --check` | Passed |

Initial focused19/26 failures were outdated test fixtures lacking required governance and
one v4 assertion; fixtures now record explicit unknown health. No guard or check weakened.
Newest official Crossref July21,2026 list-query guidance and arXiv API ToU were verified
on2026-11-03. Docs link both and distinguish stale generic Crossref limits. No live search,
paid model, account email or external write. Logs:
`.artifacts/research-optimization/pr04-governance-*.log`.

## PR-04.2D — durable owned-search execution and request receipts

Status: `Verified passing` for persisted cancellation, restart, write failures and native
consumers. Paging, strong aliases, candidate metadata UI and independent quality metrics
remain pending. Inspector/read surfaces for this backend ledger are also subsequent scope.

Research migration7 adds trusted owner/project/run-scoped search executions and original
transport receipts. Executions are saved before search; dispatched receipts are saved
before HTTP; local outcomes become received. Unknown HTTP status is never invented.
Snapshot v6 requires executionId, and candidate publication shares the transaction that
finishes its execution. Cancelled/interrupted searches retain chronology without a
candidate. Preview expiry leaves execution and receipt history intact.

Receipt write failures propagate: before dispatch they prevent HTTP; after dispatch they
prevent candidate publication and retain unknown transport state. Restart marks unfinished
requests unknown without inventing end times/hashes/status, terminates execution and fences
late receipt writes. Search drains every source promise; import shutdown awaits all search
audits. Existing old-stage migration test now pins its actual <6 baseline instead of a
moving slice. Migration does not fabricate executions for old candidates.

Changed: database-schemas.ts, literature-search-ledger.ts, literature-service.ts,
literature-import-service.ts, search result schema, literature and identity regressions,
fusion documentation. No dependency or renderer change.

Commands from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `node --test --test-name-pattern='owned search cancellation' tests/unit/literature-import.test.mjs` | Red: no durable execution/receipt table |
| `node --test tests/unit/literature-import.test.mjs tests/unit/research-task-identity.test.mjs` | Initial 36/36 passed before five final persistence/upgrade/shutdown cases |
| `pnpm typecheck` | Passed; final included in fresh build |
| `pnpm test:unit` | Final 666/666 passed, including all final cases |
| `pnpm harness:eval` | 94/94 passed |
| `pnpm check:ipc` | Current generated contracts |
| `pnpm test:research-p0` | Fresh production build/typecheck and 12/12 native cases passed |
| `LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false ROC_SMOKE_TARGET=dist node scripts/smoke-electron.mjs` | 12/12 passed, zero renderer errors, exit 0 |
| `git diff --check` | Passed |

Read-only SQLite inspection of retained native standard-workflow backup confirmed one
complete owned search, one received hashed request and one atomically linked candidate
snapshot. The figure-only scenario correctly has none. Evidence:
`.artifacts/research-optimization/pr04-durable-native-ledger.log`; full logs:
`.artifacts/research-optimization/pr04-durable-*.log`.

## PR-04.3A — reported API coverage and continuation provenance

Status: `Verified passing` for single-page coverage metadata. Actual later-page fetching
remains the next increment; independent Recall/nDCG, aliases and candidate UI remain pending.

Snapshot v7 records declared API hit counts, validated page count, unknown/limited/
reported_end/failed coverage and typed page/offset/opaque-cursor continuation. Missing
statistics stay null with an explicit warning. Counts are never inferred from record
length as academic Recall. A known uncollected API remainder marks truncated and warns.
Invalid counts, impossible homepage totals and oversized pages fail the source while
retaining HTTP200/body-hash receipts. Cached snapshots preserve original counts/cursors.
Tool descriptions distinguish request success from academic coverage.

Changed: literature-provider-schemas.ts, literature-service.ts, literature-import-service.ts,
literature-import result schema, literature tools, focused regressions and fusion docs.
No migration or dependency change; research DB remains7 and agent DB15.

Commands from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `node --test --test-name-pattern='Provider coverage preserves' tests/unit/literature-import.test.mjs` | Red: coverage metadata absent |
| `node --test tests/unit/literature-import.test.mjs` | 36/36 passed |
| `pnpm typecheck` | Passed |
| `pnpm test:unit` | Final 669/669 passed |
| `node --test --test-name-pattern='template reader preserves extraction errors' tests/unit/research-archive-libraries.test.mjs` | Existing unchanged timeout case 1/1 passed in10ms |
| `pnpm harness:eval` | 94/94 passed |
| `pnpm check:ipc` | Current generated contracts |
| `pnpm test:research-p0` | Fresh production build/typecheck and12/12 native cases passed |
| `node --test --test-name-pattern='model tools preview\|main-process tool context' tests/unit/literature-import.test.mjs` | Final tool consumers2/2 passed |
| `pnpm build` | Final description update build/typecheck passed |
| `git diff --check` | Passed |

Initial fullunit668/669 hit the existing archive close test's30ms wall-clock deadline
while build ran concurrently. Its unchanged focused run passed, and the full rerun with
no overlapping build passed669/669. No check or timeout weakened.

Primary current OpenAlex/Semantic docs and Crossref Swagger2.0 /swagger-docs verified
pagination/count fields. One anonymous read-only Europe PMC official-example query
(`EXT_ID:28620943 AND SRC:MED`, pageSize1, JSON) returned current6.9 shape with one hit,
one record and omitted terminal cursor. HTTP status was not captured and stays null in
probe evidence. The same raw bytes then passed the actual adapter offline. This proves
one response shape, not a production-network integration or scientific quality score.
Sanitized evidence: `.artifacts/research-optimization/pr04-coverage-live-contract.json`;
logs: `.artifacts/research-optimization/pr04-coverage-*.log`. No model/credential/write call.

## PR-04.3B — bounded provider paging and exact cross-page ranks

Status: `Verified passing` for bounded paging. Frozen questions/confirmed plans, identity
aliases, candidate review UI and independent retrieval annotations remain subsequent work.

Snapshot8 replaces source-level cache with per-page position, exact URL, rankOffset,
returned count, coverage and cache provenance. maxPages defaults1 and caps3; limit caps
both each source page and final candidates. OpenAlex page, Crossref/arXiv offset,
Semantic reported offset and EBI opaque cursors retain the original query and page size.
RRF consumes explicit original ranks, including duplicates and offset gaps. Repeated
cursors and backward/overlapping offsets fail. Semantic stops before crossing1000.
Page caps, provider caps, unavailable continuation, reported endpoint and failed pages
have distinct stopReason values. Endpoint count mismatch downgrades aggregate coverage
to unknown. Later failures retain validated earlier records and publish partial,
with every attempt audited. Cancellation prevents later dispatch and snapshot publication.
Cached pages preserve original hashes/timestamps and create no new HTTP receipts.

Changed: search/fusion/import service, shared schema, tools, existing renderer action,
unit and renderer regressions, fusion documentation. Research DB7 and agent DB15;
no migration, new dependency or compatibility adapter.

Commands from `/Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `node --test --test-name-pattern='bounded search fetches' tests/unit/literature-import.test.mjs` | Initial red: maxPages rejected |
| `node --test --test-name-pattern='repeated cursors' tests/unit/literature-import.test.mjs` | Regression red: overlapping offset dispatched an extra page |
| `node --test tests/unit/literature-import.test.mjs` | Final46/46 passed |
| `pnpm typecheck` | Passed |
| `pnpm test:unit` | 679/679 passed |
| `pnpm harness:eval` | 94/94 passed |
| `pnpm check:ipc` | Generated contracts current |
| `node --test --test-name-pattern='literature search action' tests/renderer/lifecycles.test.mjs` | Actual Electron hook/IPC seam1/1 passed, no renderer errors |
| `pnpm test:research-p0` | Fresh production build/typecheck and12/12 native cases passed |
| `git diff --check` | Passed |

Initial draft type errors were resolved with independent per-page contexts and explicit
renderer maxPages1. Three new test fixtures were corrected to actual contracts: required
arXiv author, null unread HTTP error body hashes, cancellation at the streamed-body
cleanup boundary. No timeout or existing safety assertion was weakened. Native build
ran after fullunit, avoiding the unrelated archive deadline contention. No new live
Provider/model call; current official contracts were verified in PR-04.3A.
Evidence: `.artifacts/research-optimization/pr04-paging-*.log`.

## PR-04.3C — original question and human-confirmed search strategy

Status: `Verified passing` for typed proposals, actual human review, fixed query execution
and durable plan provenance. Identity aliases, candidate review metadata/UI and independently
reviewed retrieval metrics remain subsequent PR-04 work.

Discovery preserves its exact stored instruction as researchQuestion, separately from the
model's refinedQuestion, keywords, synonyms, domain, excludedTerms and up to3 fixed queries.
Queries freeze sources, year range, page/count limits and total candidates<=60. Original
stage instruction is preserved; it is not labelled as a missing verbatim original chat.
Excluded terms are screening criteria, not invented API filtering. Invalid/missing proposals,
question changes and searchPlan in other stages fail before publication.

All stages now require real artifacts and the existing human gate; the old automatic-approval
branch and artifact-free shortcut are removed. Discovery displays the complete typed plan
in the assistant's existing approval card. Keyboard approval submits the hash of the displayed
artifact content. Actual LangGraph resume re-reads the plan and refuses changed content or
missing hashes; the human capability gate also requires expectedSearchPlanHash. No new
approval service, shell, route, credentials, dependency or database migration.

Retrieval starts only with one typed, human-approved search_strategy. Its model tool accepts
queryIndex only; the main process supplies and verifies exact frozen parameters. Before every
HTTP audit start, it checks that the approved plan/current run still applies. Supersession
stops the next attempt, preserves original receipts and prevents a candidate snapshot.
Snapshot9 and durable execution request JSON retain artifact ID/content hash, original
question, approvedAt and query index. Ad hoc searches retain strategy:null; old data is not
reinterpreted as an independently confirmed plan. Research DB7 and agent DB15 stay unchanged.

Changed: search-plan schema/strategy helper, discovery/retrieval skills and prompts,
run/artifact/human-gate/search/tool consumers, shared HITL/workflow contracts, existing
assistant approval card, fixtures/regressions and scoped docs.

Commands from `/Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `node --test tests/unit/research-search-plan.test.mjs` | Red: untyped discovery output published |
| `node --test tests/unit/research-search-plan.test.mjs tests/unit/literature-import.test.mjs` | Initial52/52 passed |
| `node --test tests/unit/research-search-plan.test.mjs` | Final7/7, including actual interrupt/resume and candidate budget contract |
| `pnpm test:unit` | Final686/686 passed after obsolete automatic approval removal |
| `pnpm harness:eval` | 94/94 passed |
| `pnpm check:ipc` | Generated contracts current |
| `pnpm test:research-p0` | Final fresh production build/typecheck and12/12 native cases passed |
| `node --test tests/renderer/research-search-plan.test.mjs` | Actual Electron approval display/keyboard/invalid/long-layout3/3 passed; no renderer errors |
| `node --test --test-name-pattern='literature search action' tests/renderer/lifecycles.test.mjs` | Actual search action1/1 passed |
| `pnpm check:renderer-chunks` | Passed, eager JS1131076 bytes/6 files |
| `git diff --check` | Passed |

Inspected actual plan-review/light and long-plan/dark1099 screenshots. Light/dark at1100,
1099 and800px retained native keyboard scrolling, visible focus and no horizontal overflow.
Six shadow audits had cut0/hidden0. Evidence:
`.artifacts/research-optimization/search-plan-ui/` and `pr04-plan-*.log`.
Current official LangChain structured-output and LangGraph interrupt docs were checked via
Context7; installed packages remain pinned. Tests execute deterministic local tools and real
native workers, with no paid model or new live provider request. Reviewed200-task/L2 blockers
remain unchanged; no scientific-quality claim follows from these engineering tests.

## PR-04.4A — declared scholarly IDs, observed revisions and durable source records

Status: `Verified passing` for this declared-ID increment. PR-04 remains in progress.
Research DB8, agent DB15, search snapshot10.

Normalize modern and old arXiv IDs with exact observed vN. Four/five-digit sequence rules,
valid months, historical archive dates and positive safe revision numbers are enforced.
An unversioned ID retains version:null. Equivalent arXiv revisions contribute once; original
records/ranks remain in the candidate, and hash-linked version relationships connect only
adjacent observed revisions. PubMed and Europe PMC MED share PMID; Europe PMC retains all
other source namespaces. Non-MED PubMed results fail before cache/publication. Distinct DOIs
stay distinct; no publication/preprint relation is inferred from equal IDs or titles.

Candidate import freezes every distinct provider record. All bibliography preparations must
succeed without changing identity before one atomic library write. Sources retain the raw
providerRecord separately from normalized metadata/bibliography, including original hashes
and observed versions after the preview expires. File/DOI imports and historical observations
use providerRecord:null when original provider bytes/records were not retained.

DB8 replaces the obsolete unique identity constraint with an indexed canonical identity.
One-time data migration retains item IDs, bibliography, source metadata, archive state and
project/attachment references. Europe PMC's historical namespace comes only from the exact
retained article URL; absent matching evidence aborts and rolls back. Colliding historical
rows remain separate and automatic lookup/import fails with an actionable conflict.
There is no old-key fallback scan. Table replacement runs with FK enforcement temporarily
off outside the transaction, validates all references before commit and restores its prior
setting. Existing migration checksums remain unchanged; DB8 dataVersion is part of its ledger.

Changed: identity/migration/fusion/search/import/library consumers and failure messages,
library/search schemas, regression fixtures, renderer snapshot fixture and scoped docs.

Commands from `/Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc`
(also exposed at `/Users/Apple_501/Desktop/Roc/Roc`):

| Command | Actual result |
| --- | --- |
| `node --test tests/unit/literature-import.test.mjs` | Red: MED/PMC namespace collision and arXiv revisions split |
| `node --test tests/unit/literature-import.test.mjs tests/unit/database-migrations.test.mjs` | Initial58/58, expanded67/67 passed |
| `pnpm test:unit` | Final699/699 passed; raw-provider normalization and identity-change regressions included |
| `pnpm harness:eval` | 94/94 passed |
| `pnpm generate:ipc` and `pnpm check:ipc` | Generated files unchanged; contracts current |
| `pnpm test:research-p0` | Final fresh build/typecheck and12/12 actual native cases passed |
| `node --test --test-name-pattern='literature search action' tests/renderer/lifecycles.test.mjs` | Actual Electron hook1/1 passed |
| `pnpm check:renderer-chunks` | Passed, eager JS1131076bytes/6files |
| `LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false ROC_SMOKE_TARGET=dist node scripts/smoke-electron.mjs` | Application startup/UI12/12, zero renderer errors, exit0 |
| `git diff --check` | Passed |

Evidence: `.artifacts/research-optimization/pr04-identifiers-*.log`. Tests cover actual DB7→8
upgrade, repeated migration, missing namespace rollback, colliding row preservation, project
links, archive refusal, alternate-preparation failure and foreign-key-invalid rollback.
Current arXiv/NLM identity documentation was verified; pinned better-sqlite3 13.0.3 transaction
and pragma API docs checked via Context7. No new live literature query, paid model call,
remote write or real-user database migration. External-ID graph, complete review metadata/UI,
independent annotated retrieval metrics and all L2 prerequisites remain unfinished.

## PR-04.4B — uniquely anchored declared-ID graph and persistent library aliases

Status: `Verified passing` for this declared-ID graph increment. PR-04 remains in progress.
Research DB9, agent DB15, search snapshot11.

The prior fusion split DOI-free PubMed/arXiv observations from an observation of the same
declared identity with one DOI. The graph now connects these records only when exactly one
DOI is observed for that source identity. Competing DOIs retain separate candidates and
explicit identityConflicts, with DOI-free records still separate. Candidate aliases and
conflicts retain their actual declaration; titles never create edges and primary provider
metadata remains unchanged.

Search, frozen candidate import and library import share the graph. Canonical library
metadata/bibliography can acquire a uniquely witnessed DOI while retaining its item ID,
citation key, primary metadata selection and every raw origin. A later DOI-free import
resolves the persisted alias and never downgrades that DOI. Distinct known DOIs stay separate;
shared DOI-free aliases become explicitly ambiguous. Archive state remains authoritative.

DB9 adds a persistent alias index seeded from current primary metadata and actual retained
providerRecord observations. It does not rewrite DB8 rows or infer unknown historical
observations. Data-only migration transformations have an immutable dataVersion; existing
applied SQL/name/checksums remain unchanged. A matching table schema cannot prove an
unrecorded data/rebuild migration ran, so that fast path now refuses missing ledger evidence
without modifying data or recording success.

Changed: identity graph/alias migration, migration engine/schema, fusion/search/import/library
consumers, search schema and renderer fixture, focused regressions and scoped docs.

Commands from `/Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc`
(also exposed at `/Users/Apple_501/Desktop/Roc/Roc`):

| Command | Actual result |
| --- | --- |
| `node .artifacts/research-optimization/pr04-alias-graph-baseline.mjs` | Fixed f73fc26 baseline red: expected one same-PMID candidate, received two |
| `node --test tests/unit/literature-import.test.mjs tests/unit/database-migrations.test.mjs` | Initial75/75 passed |
| `pnpm test:unit` | Final709/709 passed, including unproven ledger and competing stored-anchor regressions |
| `pnpm harness:eval` | 94/94 passed |
| `pnpm check:ipc` | Generated contracts current |
| `pnpm test:research-p0` | Fresh production build/typecheck and12/12 native cases passed |
| `LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false ROC_SMOKE_TARGET=dist node scripts/smoke-electron.mjs` | Final application startup/UI12/12, zero renderer errors, exit0 |
| `node --test --test-name-pattern='literature search action' tests/renderer/lifecycles.test.mjs` | Actual Electron hook1/1 passed |
| `pnpm check:renderer-chunks` | Eager JS1131076bytes/6files passed |
| `git diff --check` | Passed |

Evidence: `.artifacts/research-optimization/pr04-alias-graph-*.log`. Provider docs research
verified OpenAlex ids.pmid in its current primary dictionary. Semantic graph docs remained
429 and its tutorial403; Ai2's authored code confirms externalIds.ArXiv, but the exact PubMed
JSON field remains unverified. Those additional API observations are not implemented here.
No new live literature query, paid model, remote write or real-user DB migration. Complete
candidate review metadata/UI and independent annotated retrieval metrics remain pending.

Final stored-anchor review adds a bounded three-row classification of exact DOI, provisional
identity and competing DOI. A provisional historical row cannot be promoted while another
stored DOI competes for its alias. DOI-free query origins consult stored identities before
attachment; a competing stored anchor rejects the whole candidate import, retains original
rows/sources and reports a conflict with retryable:false. Identity-change errors also do not
invite an automatic retry. Three actual DB/import regressions cover these cases.
Final full unit after this correction:709/709. Fresh production build/typecheck/native P0
after the correction:12/12. Final startup smoke12/12 and renderer hook1/1 passed.


## PR-04.4C — verified Provider external identifiers and durable observations

Status: `Verified passing` for this external-identifier increment.
Research DB10, agent DB15, search snapshot12. Full PR-04 remains in progress.

OpenAlex ids.doi/ids.pmid and Semantic externalIds.DOI/ArXiv now participate in the
identity graph. Each ranked origin retains original values, field names, normalized
identities and the complete identifier dictionary, including unknown keys. The verified
OpenAlex PMID connects direct PubMed/MED observations; Semantic ArXiv connects direct
arXiv observations without claiming that a declared revision was fetched. Unverified
Semantic PubMed keys stay opaque. Invalid known identifiers fail before cache admission.
Primary DOI versus external DOI conflicts retain competing anchors and exclude supplemental
PID edges; DOI-free components attach only to one unique DOI anchor. Original provider
metadata and original source bibliography remain unchanged.

Frozen candidate imports retain full origins and execution IDs. Library import validates
raw Provider hash, source, external ID, retrieval time and recomputed identifier mapping.
DB10 stores paginated observations independently of library list rows; original source
rank and execution provenance survive candidate expiry and library archive. Same execution,
source and rank can replay only with identical data and item identity. Conflicting replay
or persistence failure rolls back the whole candidate import and returns a nonretryable
failure. A canonical DOI witnessed only in external fields updates metadata, bibliography,
BibTeX DOI and existing CSL DOI. Stored provisional canonical keys remain stable on later
DOI-free imports; idempotent external-PMID replay does not increment library revision.

New readonly capability research.library.getIdentifiers and generated preload method
research.getLibraryIdentifiers use offset/limit pages, default20/max50. Missing items fail
explicitly; archived observations remain readable. Model search/read previews omit complete
raw dictionaries while retaining known mapped values. Old snapshots are refused rather
than converted, and DB10 does not infer historical identifier observations.

Changed files: Provider identifier/shared schemas, adapters, identity graph/fusion,
import/library repository/capability and generated IPC, focused regressions, renderer
snapshot fixture and scoped fusion documentation. Existing unrelated docs remain unstaged.

Commands from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `node .artifacts/research-optimization/pr04-external-ids-baseline.mjs` | Fixed8e53377 red: mapped OpenAlex PMID and direct PubMed produce two candidates (expected one) |
| `node --test tests/unit/literature-import.test.mjs tests/unit/database-migrations.test.mjs` | Initial79/79 passed |
| `node --test --test-name-pattern='observations\|external identifiers\|supplemental PMID\|identifier replay\|identifier API\|identifier dictionaries\|identifier persistence' tests/unit/literature-import.test.mjs` | New/related observation regressions10/10 passed |
| `node --test --test-name-pattern='repeated PMID-only' tests/unit/literature-import.test.mjs` | Red: repeated import incremented revision; fixed in final full suite |
| `pnpm test:unit` | Initial718/718; final719/719 passed after canonical-key fix |
| `pnpm harness:eval` | 94/94 passed |
| `pnpm generate:ipc` / `pnpm check:ipc` | Generated preload/registry current; check passed |
| `pnpm typecheck` | First run preceded generation completion and failed on missing preload method; subsequent check/final build passed |
| `pnpm test:research-p0` | Final fresh production build/typecheck and12/12 native cases passed |
| `pnpm check:renderer-chunks` | Passed; exact budget in retained log |

Evidence: `.artifacts/research-optimization/pr04-external-ids-*.log` and fixed baseline
script. Task-created scratch source and temporary baseline bundle removed after verification.
No new live literature query, paid model call, remote write or real-user DB migration.
Remaining: candidate type/license/retraction/conflict review UI, independent retrieval
annotation/metrics and later plan increments. L2/full reviewed corpus remains blocked.

Final application startup/UI smoke12/12, zero renderer errors, exit0; actual renderer literature hook1/1 and whitespace check passed. Eager JS1131076bytes/6files.


## PR-04.4D — candidate review metadata, durable provenance and desktop disclosure

Status: `Verified passing` for this candidate review increment. Full PR-04 remains in progress.
Research DB11, agent DB15, search snapshot13.

Candidate origins now retain declared types, copy-scoped versions/licenses, retraction
observations and update targets. OpenAlex maps type/primary_location/is_retracted; Crossref
maps type/license content-version/update-to; arXiv revisions come from actual entry.id.
Unverified/missing source fields remain unknown. False OpenAlex retraction means the source
has not reported a retraction at that observation time, never a credibility/safety score.
Crossref update-to names the current record's update target and never proves the current
record itself was retracted. Known field/schema failures are refused before caching.

DB11 persists review observations separately from normal library list items, retaining
execution/source/rank/hash/retrieval provenance. research.library.getReviews and generated
research.getLibraryReviews use default20/max50 pages. Old DB10 items remain unchanged and
receive no fabricated reviews; observations survive candidate expiry/archive. Identical
replay is idempotent, conflicting content/mismatched source metadata and persistence failure
roll back the whole import and return nonretryable failures.

The existing import dialog now uses dense candidate rows with all sources, type, version,
license, retraction and update status. Native keyboard details reveal original metadata,
copy scope, update targets, identity/field conflicts and actual arXiv revisions. Explicit
add remains separate; archived candidates stay disabled. Unknown fields do not become
normal/clear. Rows use semantic tokens,12/13px type and hairline boundaries; no second shell,
new route, decorative animation or heavy dependency. Explicit672px dialog width avoids the
conflicting max-width rules that left insufficient shadow room at800px.

Commands from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `ROC_REVIEW_BASELINE=1 node --test --test-name-pattern='candidate review exposes' tests/renderer/literature-review.test.mjs` | Fixed07319ba red: previous dialog has no candidate review rows |
| `pnpm test:unit` | Initial723/723; final724/724 passed |
| `node --test tests/unit/literature-import.test.mjs tests/unit/database-migrations.test.mjs` | Final94/94 passed, including DB10→11 preservation |
| `pnpm harness:eval` | 94/94 passed |
| `pnpm generate:ipc` / `pnpm check:ipc` | Generated contracts current; check passed |
| `pnpm test:research-p0` | Fresh build/typecheck and12/12 native cases passed |
| `pnpm build` | Final build/typecheck passed after dialog width correction |
| `node --test tests/renderer/literature-review.test.mjs` | Final3/3 actual Electron cases passed |
| `node --test --test-name-pattern='literature search action' tests/renderer/lifecycles.test.mjs` | Actual hook1/1 passed |
| `LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false ROC_SMOKE_TARGET=dist node scripts/smoke-electron.mjs` | Final application startup/UI12/12, zero renderer errors, exit0 |
| `pnpm check:renderer-chunks` | Eager JS1131076bytes/6files passed |
| `git diff --check` | Passed |

UI evidence: `.artifacts/research-optimization/review-ui/` contains default, hover,
expanded, long text/light/dark1100/1099/800 screenshots and nine shadow audits; every final
cut0/hidden0. Screenshots inspected at normal light and long dark1099 states. Initial test
fixtures omitted the application's LazyMotion/MotionConfig, leaving panels at transparent
initial state; those invalid screenshots are superseded by actual providers and final-state
waits. Initial early native-details and shadow failures are retained in diagnostic logs.

Provider contract readings: current primary OpenAlex work/location dictionary and Crossref
Swagger4.5.1, as linked in docs/research-literature-fusion.md. No new live paper query, paid
model, remote write, real-user DB migration or fixture corpus modification. Source plan
still requires independent retrieval annotations/Recall@20/nDCG@10/duplicate metrics and
later plan increments. L2/full reviewed task corpus remains externally blocked.


## PR-04.5A — complete captured pools for independent ranking evaluation

Status: `Verified passing` for captured-pool infrastructure. Full PR-04 remains incomplete.
Research DB12, agent DB15, search snapshot13, pool schema1.

Previously, only final top-limit RRF candidates survived; year-excluded records and lower
ranks were lost, and expired candidate snapshots were deleted on a later search. Comparing
source order with RRF using that selected subset would bias the baseline. Successful capture
now saves all validated original ranked records before year filtering/candidate limiting,
including identifiers/review metadata and original ranks. The immutable pool also freezes
request, confirmed strategy, source status/coverage/page/HTTP evidence and observation time.
A SHA-256 content hash covers the full schema1 body. Pool, candidate publication and search
execution completion commit atomically; pool write failure publishes no candidate and leaves
an explicit failed execution. Existing historical executions receive no fabricated pool.

New readonly research.literature.getPool / research.getLiteraturePool paginates by trusted
owner/project and executionId, default20/max30. Candidate expiry/deletion does not delete the
pool; each read verifies the complete pool hash before slicing. Missing/other-owner/other-
project pools fail explicitly and tampered storage is nonretryable degraded data. This API
is not expanded by the model's candidate preview tools and does not import library papers.
Ranked record type now comes from the same shared persisted schema, removing a duplicate
handwritten contract. No candidate-snapshot compatibility branch or inferred old pool.

Commands from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `ROC_POOL_BASELINE=1 node --test --test-name-pattern='complete captured pool retains' tests/unit/literature-import.test.mjs` | Fixedaf32a2c red: zero captured pools after valid search, expected one |
| `node --test tests/unit/literature-import.test.mjs tests/unit/database-migrations.test.mjs` | 98/98 passed |
| `pnpm test:unit` | 728/728 passed |
| `pnpm harness:eval` | 94/94 passed |
| `pnpm typecheck` | Passed |
| `pnpm generate:ipc` / `pnpm check:ipc` | Generated contracts current; check passed |
| `pnpm test:research-p0` | Fresh build/typecheck and12/12 native cases passed |
| `LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false ROC_SMOKE_TARGET=dist node scripts/smoke-electron.mjs` | Application startup/UI12/12, zero renderer errors, exit0 |
| `node --test --test-name-pattern='literature search action' tests/renderer/lifecycles.test.mjs` | Actual hook1/1 passed |
| `pnpm check:renderer-chunks` | Eager JS1131076bytes/6files passed |
| `git diff --check` | Passed |

Four new actual DB regressions cover retained exclusions/lower ranks, stable pagination and
hash reconstruction, expiry/deletion, owner/project isolation, integrity refusal, atomic
publication rollback, DB11→12 without historical fabrication and actual capability/IPC.
Evidence: `.artifacts/research-optimization/pr04-pool-*.log`. No new live literature query,
paid model, remote write, real-user DB migration or frozen workflow-fixture edit.

This is input/provenance preparation, not a Recall/nDCG/duplicate-rate result or independent
annotation. An independently reviewed query set and relevance labels are still missing;
complete scientific retrieval validation and later plan increments remain pending.


## PR-04.5B — offline judgment preparation and retrieval metrics

Status: `Verified passing` for offline tooling. Independent scientific retrieval acceptance:
`Blocked, not run` because independently reviewed queries/judgments are absent.
No product runtime, database version or captured-pool format changes.

Strict local corpus contracts distinguish engineering fixtures from declared independent
human review. Preparation strips ranks/scores/candidate grouping, unions original identifier
observations by metadata hash and retains execution/pool/content hashes. Evaluation compares
source-priority/rank with RRF v1 using the same current identity/year rules; this is not a
complete historical-app comparison. Labels independently group records by human paper ID.
Recall20/nDCG10 count duplicate relevance only once; mixed-paper merges gain nothing and are
reported. Missed labeled papers remain in denominators/ideal rankings. Failed queries stay
in equal-topic averages; duplicate rates pool top20 slots and empty rankings return null.

Reports retain code commit/bundle/corpus/pool hashes, declared sample minimum and explicit
annotation assurance. Human inputs require committed relevant source and capture limit>=20.
Declared reviewer identity/evidence cannot certify independent human review. Complete capture
cannot certify complete relevant-paper ground truth; pool-only Recall must be named as such.
No scientific gain, target value or confidence interval fabricated. CLI only reads explicit
local files; fully written private sibling files are atomically linked to exclusive new
outputs, never overwrite existing outputs, and are removed after publication/refusal.

Commands from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `node --test tests/unit/literature-retrieval-evaluation.test.mjs` | 6/6 passed before final atomic publication; all included in final fullunit |
| `pnpm test:unit` | Final734/734 passed after packet/docs/publication changes |
| `pnpm typecheck` | Final passed |
| `pnpm check:ipc` | Current, passed |
| `pnpm harness:eval` | 94/94 passed before final offline packet/publication edits; Harness runtime unaffected |
| `git diff --check` | Passed |

Actual CLI regressions exercise report/packet startup, exact output, EEXIST preservation and
no report for invalid input. Hand calculations verify graded gains, missed-paper ideal,
duplicates, false merges, failed queries and topic weighting. Evidence:
`.artifacts/research-optimization/pr04-metrics-*.log` and three retained explicitly synthetic
engineering corpus/report/unlabeled-packet JSON files. No live literature query/model call,
remote write, credentials read or frozen workflow fixture edit. Next independent authorized
increment: Zotero read-only adapter and import; PR-04's scientific acceptance remains open.


## PR-05A — instance-bound Zotero read-only local API

Status: `Verified passing` for adapter/capability/IPC foundation; full Zotero import and
real-client interoperability remain pending. Research DB12, agent DB15 unchanged.

Verified current primary Local API/Basics docs (updated2026-07-29), then pinned Zotero main
commit1ca9d58c9aa9aeca1032d3966f3765d4d40ab7b2 source. API3/Zotero10+ server IDs partition
local versions; older missing-ID clients explicitly unsupported. Personal library users/0,
group IDs distinct from local internal IDs. Group metadata has synced versions and no
aggregate Last-Modified-Version, unlike local item/collection pages.

Fixed127.0.0.1:23119 GET-only adapter, no keys/auth/Connector/write calls/redirect following.
Probe reports connected/disabled/unreachable/unsupported/invalid_response, never infers
installation from refused transport. Explicit20/default50/max paging, source raw fields,
local version/instance checks, byte hashes/time/total/next offset. Invalid/incomplete/duplicate
pages fail. Caller cancellation and plugin shutdown abort/drain requests, no late page;
10s timeout/8MiB bytes. Main-only attachment path reference uses file/view/url, validates
local file URI, does not read bytes or confer filesystem authority. Registered4 read-only
capabilities and generated preload IPC; startup itself performs no Zotero read.

Commands from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `node --test tests/unit/zotero-adapter.test.mjs` | Final10/10 passed, actual local HTTP fixture included |
| `pnpm test:unit` | Final744/744 passed |
| `pnpm harness:eval` | 94/94 passed |
| `pnpm generate:ipc` / `pnpm check:ipc` | Generated contracts current, passed |
| `pnpm test:research-p0` | Fresh typecheck/build plus12/12 native scenarios passed |
| `LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false ROC_SMOKE_TARGET=dist node scripts/smoke-electron.mjs` | Actual startup/UI12/12, zero renderer error, exit0 |
| `pnpm check:renderer-chunks` |1131076bytes/6files, passed |
| `git diff --check` | Passed |

Evidence `.artifacts/research-optimization/pr05-adapter-*.log`. Initial fixture export/error
field guesses failed and were corrected to actual ipcRegistry/RocDomainError; guards/checks
unchanged. Primary Jina guessed page401 and old source path404; switched to official docs
and current pinned tree. Standard /Applications/Zotero.app absent; no actual user library,
DB/profile, credentials or global settings read/modified. No Zotero/plugin installation.
No paid model, remote write or frozen workflow fixture edit. Next: durable preview/import
object mapping through existing bounded metadata jobs, then settings/selection/attachments
and incremental checkpoints. Real Zotero client contract acceptance remains unrun.


## PR-05 prerequisite — retain migration application history

Status: `Verified passing`. New preview upgrade regression exposed that the common migration
writer deleted/reinserted all old ledger rows whenever appending a migration, changing their
original applied_at timestamps. A separate deterministic-time regression reproduced the
failure before the fix. Writer now reads validated applied versions and appends only missing
versions. Existing migration names/checksums/application times stay unchanged; checks for
rewritten migrations, unproven data transforms and transactional schema/FK rollback remain.
No applied migration SQL/name/checksum changed and no real-user DB was touched.

Checks from `/Users/Apple_501/Desktop/Roc/Roc`, on the source state including the uncommitted
Zotero preview increment (this correction itself has no dependency on that new migration):

| Command | Actual result |
| --- | --- |
| `node --test --test-name-pattern='preserves complete historical ledger' tests/unit/database-migrations.test.mjs` | Before-fix red: old applied_at replaced by upgrade timestamp |
| `node --test tests/unit/zotero-preview.test.mjs tests/unit/zotero-adapter.test.mjs tests/unit/literature-import.test.mjs tests/unit/database-migrations.test.mjs` | Final114/114 passed, full ledger rows preserved for synthetic append and actual DB12→13 |
| `pnpm test:unit` | Final750/750 passed |
| `pnpm harness:eval` | 94/94 passed |
| `pnpm test:research-p0` | Fresh typecheck/build and12/12 native scenarios passed |
| `pnpm check:ipc` / `pnpm check:renderer-chunks` | Current contracts and eager1131076bytes/6files passed |
| `git diff --check` | Passed |

Evidence `.artifacts/research-optimization/pr05-migration-history-red.log` and
`pr05-preview-focused-latest.log`, `pr05-preview-unit-latest.log`, `pr05-preview-native.log`.
Preview implementation remains for the following separate commit after startup verification.


## PR-05B1 — owned immutable Zotero review previews

Status: `Verified passing` for preview capture/readback. Full Zotero metadata import/object
mapping, settings/selection/attachment authorization and checkpoint acceptance remain pending.
Research DB13, agent DB15. Zotero preview schema1; no old snapshot conversion.

A source page is captured completely before returning a20-object review slice. Original
objects/unknown fields, local server/library/version, request, raw response hash and time are
frozen with a full contentHash and7-day review expiry. Trusted owner/project/run are stored
by main context; input cannot select another scope. Preview readback uses20/default30/max
pagination and checks the complete body before slicing, even for hidden final records.
Source total/nextOffset and capturedTotal/nextPreviewOffset remain distinct. No library import,
attachment read, normalization worker or indexing starts during preview. Database failure,
invalid page, cancellation, closure and late output cannot publish a successful snapshot.
Import service tracks/drains preview jobs; effective snapshots survive service restart.

New research.zotero.preview/getPreview capabilities and generated preload previewZotero/
getZoteroPreview. DB12→13 preserves real-shaped historical library source data and full old
migration ledger rows, and fabricates no Zotero preview. Migration history correction is
separately committed459f30df. Previous latest-schema test assertions now expect13, while
historical fixture version pins and row/hash assertions remain unchanged.

Commands from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `node --test tests/unit/zotero-preview.test.mjs tests/unit/zotero-adapter.test.mjs tests/unit/literature-import.test.mjs tests/unit/database-migrations.test.mjs` | Final114/114 passed |
| `pnpm test:unit` | Final750/750 passed |
| `pnpm harness:eval` | 94/94 passed |
| `pnpm generate:ipc` / `pnpm check:ipc` | Current generated contracts, passed |
| `pnpm test:research-p0` | Fresh typecheck/build and12/12 native scenarios passed |
| `LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false ROC_SMOKE_TARGET=dist node scripts/smoke-electron.mjs` | Startup/UI12/12, zero renderer error, exit0 |
| `pnpm check:renderer-chunks` / `git diff --check` |1131076bytes/6files and whitespace passed |

Five new actual SQLite/capability regressions cover25-original capture, complete hash/paging,
service restart/no second HTTP, owner/project/expiry/hidden-record integrity, database refusal,
invalid remote page, late shutdown fence and DB12 upgrade. Initial fixture guessed wrong
ledger dbName/closed error/capability lexical order; corrected to existing contracts. No
checks weakened. Evidence `.artifacts/research-optimization/pr05-preview-*.log` plus primary
source/contract hash in pr05-zotero-primary-contract.json. No real Zotero DB/user library,
credential, external write, paid model or frozen workflow-fixture edit. Next: user-selected
Zotero items imported through existing bounded jobs with independent object mappings.


## PR-05B2 — Zotero object import and durable scoped receipts

Status: `Verified passing` for this increment. Full PR-05 remains incomplete.
Research DB14, agent DB15, Zotero preview schema2 (`data,csljson`).

User-selected preview objects enter existing owned, idempotent, cancellable metadata jobs.
Native exported CSL supplies complete bibliography fields; title/normalized DOI disagreement,
invalid frozen CSL, version regressions and same-version conflicts fail explicitly. Sync key
is instance/library kind+ID/itemKey, distinct from DOI literature identity. Canonical paper,
object mapping, raw version, scoped receipt and job result commit in one transaction. Tags,
collections, unknown fields and CSL remain in immutable original versions; local note/keywords
and archived state stay intact. Different same-DOI objects retain distinct mappings.

A reproduced fresh-request duplicate-work bug is fixed: unchanged object version reuses saved
bibliography and source revision, adds only a missing project link and a separate observation.
Required notification policy is explicit at all library.link callers; job publication follows
commit. New paginated sources capability checks trusted owner/project and raw key/version/hash;
receipts remain readable after preview expiry/archive. DB13 history/ledger rows stay intact,
old schema1 preview remains stored but is not converted into fabricated CSL.

Commands from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `node --test tests/unit/zotero-import.test.mjs tests/unit/zotero-preview.test.mjs tests/unit/zotero-adapter.test.mjs` | Final26/26 passed |
| `pnpm test:unit` | Final761/761 passed |
| `pnpm harness:eval` | 94/94 passed |
| `pnpm test:research-p0` | Fresh typecheck/build and13/13 native cases passed |
| `pnpm check:ipc` | Generated contracts current, passed |
| `LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false ROC_SMOKE_TARGET=dist node scripts/smoke-electron.mjs` | Startup/UI12/12, zero renderer errors, exit0 |
| `pnpm check:renderer-chunks` | Eager1131095bytes/6files passed |
| `git diff --check` | Passed |

Evidence `.artifacts/research-optimization/pr05-object-*.log`, including deterministic fresh-
request red, plus `pr05-object-native-csl/research.sqlite` and `receipt.json` from actual native
worker. First native fixture was correctly refused for missing approved search plan; fixture
changed to independent user-import context without weakening the gate. No live literature
query, paid model call, remote write, real-user DB migration or frozen workflow fixture edit.
Settings/library/collection/conflict UI, checkpoints/deletions, attachment grants and actual
Zotero client acceptance remain pending. L2/full reviewed corpus/independent scientific labels
remain externally blocked.


## PR-05C1 — Zotero status in existing literature settings

Status: `Verified passing` for this settings increment. Research DB14 and preview schema2
unchanged. Full PR-05 remains incomplete. Click-only standard application-executable detection
and independent API probe expose found/not_found separately from connected/disabled/
unreachable/unsupported/invalid_response. Standard directory scope is explicit; no assertion
of absence elsewhere. Filesystem read errors are failures. No automatic client launch,
settings change or library read. New capability/preload: research.zotero.status/getZoteroStatus.

Actual Electron regression reproduced stale connected state during refresh. Unique probe
resource keys now remove prior data immediately; unmount discards late results. Uses existing
settings literature section with12/13px tokens, keyboard focus and0.5px separator.

Commands from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `node --test tests/unit/zotero-adapter.test.mjs` | 11/11 passed including installation/error path and capability/IPC |
| `pnpm test:unit` | 762/762 passed |
| `pnpm build` | Final production typecheck/build passed |
| `node --test tests/renderer/zotero-settings.test.mjs tests/renderer/radix-settings-dialog.test.mjs` | 4/4 passed |
| `node --test tests/renderer/zotero-settings.test.mjs` | Final3/3 after border-only correction passed |
| `pnpm harness:eval` | 94/94 passed |
| `pnpm check:ipc` / `pnpm check:renderer-chunks` | Current IPC/eager1131095bytes/6files passed |
| `LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false ROC_SMOKE_TARGET=dist node scripts/smoke-electron.mjs` | 12/12, zero renderer errors, exit0 before final border-only correction |
| `git diff --check` | Passed |

Evidence `.artifacts/research-optimization/pr05-settings-*.log` and zotero-settings-ui/:
default/hover/light/dark/reduced-motion1100/1099/800 screenshots, all final cut0/hidden0;
connected default and final dark1099 inspected. Initial full-border utility corrected to
border-t-[0.5px], final production build and actual component checks rerun. No new literature
query, model call, external write or fixture corpus edit. Actual Zotero interoperability,
selection/conflict UI, sync checkpoints/deletions and attachment authorization remain pending.


## PR-05 prerequisite — scope actual preview/source and retrieval-pool IPC

Status: `Verified passing` for this bridge fix. Research DB14/preview2 unchanged.
Actual sender/project bridge tests reproduced failure for Zotero previews and retrieval pools:
the adapter only scoped search/add/get/cancel, leaving new context-dependent methods without
literatureContext. Structural generated-mapping checks did not exercise this runtime boundary.
Now pool and Zotero preview/read/source capabilities receive window sender ownership and
project scope. Required nullable projectId lives in Zotero IPC envelopes; capability entry
strips only that field before core service validation. Core snapshot request/hash stays intact.
No owner/run identity inputs, absent-project fallback, legacy alias or data migration.

Commands from `/Users/Apple_501/Desktop/Roc/Roc` (source includes separately uncommitted UI draft):

| Command | Actual result |
| --- | --- |
| `node --test --test-name-pattern='actual preload' tests/unit/zotero-preview.test.mjs` | Before-fix2/2 failed with internal errors, retained red |
| `node --test tests/unit/zotero-preview.test.mjs tests/unit/zotero-import.test.mjs tests/unit/zotero-adapter.test.mjs` | 30/30 passed |
| `pnpm test:unit` | 765/765 passed |
| `pnpm harness:eval` | 94/94 passed |
| `pnpm test:research-p0` | Fresh typecheck/build and13/13 native passed |
| `LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false ROC_SMOKE_TARGET=dist node scripts/smoke-electron.mjs` | Startup12/12, zero renderer errors, exit0 |
| `pnpm generate:ipc` / `pnpm check:ipc` | Generated contracts current, passed |
| `pnpm check:renderer-chunks` | Eager1131135bytes/6files passed with UI draft |
| `git diff --check` | Passed |

Evidence `.artifacts/research-optimization/pr05-ipc-scope-*.log`. New actual bridge checks
include sender/project row values, foreign window/project refusal, required scope and owner
spoofing refusal, no second HTTP on readback, durable scoped sources and unchanged-object
replay with one CSL worker. UI draft remains separate and uncommitted; its initial renderer
run6/7 passed, native details test must wait for actual expansion. No real Zotero user library,
live paper query, model call, remote write or frozen workflow-fixture edit.


## PR-05C2 — user-reviewed Zotero selection and import UI

Status: `Verified passing` for this UI increment. Full PR-05 remains in progress.
No database/API format changes. Existing literature import dialog gains a Zotero tab with
keyboard Arrow/Home/End navigation, explicit connection, paginated personal/group libraries
and collections,20/30/50 source-page scope and separate frozen-preview pagination. Source
version is carried across pages; errors cannot publish an old preview as the new page.
Native keyboard details reveal complete raw tags/collections/attachment references/unknown
fields. Notes/annotations/attachments and missing title/CSL cannot be selected as papers;
actual metadata validation remains at the main boundary. At most30 papers per import.

Existing owned jobs provide outcomes, partial retry and request idempotency. Lost transport
retries keep requestId; actual failed results allow only declared retryable items. Cancel
looks up that requestId and sends the real operationId, retaining submitted-vs-final state.
Pending cancellation blocks another write and its acknowledgment is tied to the request.
Parent dialog retains active/final receipt across close/tab changes; project key remounts
it so old output cannot enter a new scope. Reopening within the same mounted canvas resumes
receipt display; cross-restart selection/checkpoint recovery is not claimed.

Commands from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `pnpm build` | Final production typecheck/build passed |
| `node --test tests/renderer/zotero-import.test.mjs tests/renderer/literature-review.test.mjs` | Final8/8 passed (new5, existing3) |
| `node --test --test-name-pattern='literature search action' tests/renderer/lifecycles.test.mjs` | Actual hook1/1 passed |
| `LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false ROC_SMOKE_TARGET=dist node scripts/smoke-electron.mjs` | Final startup/UI12/12, zero renderer errors, exit0 |
| `pnpm check:ipc` / `pnpm check:renderer-chunks` | Current contracts/eager1131135bytes/6files passed |
| `git diff --check` | Passed |

Shared backend unit765/Harness94/native13 passed in preceding scoped IPC increment with the
UI draft present; final changes are renderer-only and received fresh build/runtime checks.
Evidence `.artifacts/research-optimization/pr05-ui-*.log` and zotero-import-ui/: default,
hover, expanded, long raw originals, reduced-motion light/dark1100/1099/800 allcut0/hidden0;
normal light and long dark1099 inspected. First details assertion preceded native expansion;
waiting for visible pre corrected the fixture, no product guard weakened. Additional checks
prove exact group/collection/scope/page request, no implicit import, source-vs-review paging,
selected-only import, retry-only failed entry, cancel/reopen/final receipt, explicit read
errors, same-ID lost-transport retry, library-only null scope, old project refusal and distinct
source50/selection30 caps. Temp Electron harness artifacts removed by test cleanup.

No new live literature query, paid model, actual Zotero user library read, external write or
frozen workflow-fixture edit. Next: source/local conflict review, incremental checkpoints and
remote deletion state, attachment input authorization. Actual Zotero interoperability and
independent scientific/L2/full-reviewed-corpus acceptance remain externally blocked.

## PR-05D — readonly source/local comparison

Status: `Verified passing` for this increment. Research DB14 and preview2 unchanged.
Full PR-05 and overall plan remain in progress.

Added scoped `research.zotero.review` / `reviewZotero`: frozen source, canonical current
metadata/bibliography/revision/archive, recorded object version, exact populated-field
differences and latest original receipt from this owner/project. Review performs no HTTP,
worker or DB write. Object states distinguish new/unchanged/new-version/regressed/conflicting/
identity-changed. Direct scoped SQL supports history beyond50; corrupt originals and ambiguous
canonical identity fail explicitly. Global canonical metadata remains distinct from scoped
raw source history.

Existing import dialog waits for current preview/selection review, retains local notes/tags
and both field values, and refuses conflicted/regressed/identity-changed/archived entries.
Stale or failed review cannot enable import. Review is a current read, not a durable approval
or semantic bibliography equivalence claim. Existing main import invariants still apply.

Runtime focus reproduced an outer ModalShell scroll144px and clipped title. The modal outer
panel uses overflow-clip; body remains independently scrollable. Keyboard expansion/wheel
regressions prove panel0, body414 and unchanged title position. Screenshot/audit retained.

Commands from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `pnpm test:unit` | Final769/769 passed |
| `pnpm harness:eval` |94/94 passed |
| `pnpm test:research-p0` | Fresh build/typecheck and actual native13/13 passed |
| `pnpm build` | Final shared-shell production build/typecheck passed |
| `node --test tests/renderer/zotero-import.test.mjs tests/renderer/literature-review.test.mjs` |9/9 passed after shell fix |
| `node --test tests/renderer/zotero-import.test.mjs` | Final wheel/keyboard6/6 passed |
| `node --test --test-concurrency=1 tests/renderer/` | Final shared-shell63/63 passed |
| `LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false ROC_SMOKE_TARGET=dist node scripts/smoke-electron.mjs` | Final12/12, zero renderer errors |
| `pnpm check:ipc` / `pnpm check:renderer-chunks` | Current;1131133bytes/6files passed |
| `git diff --check` | Passed |

Evidence `pr05-review-*.log`, `pr05-review-native-csl/` and zotero-import-ui/ scroll/
screenshots/audits. Parallel full renderer initially62/63 exposed a pre-existing immediate
disabled-state assertion; now it awaits real DOM disabled state before the same assertion.
Next parallel run had Radix Escape contention across Electron windows; serial63/63 passed.
No checks weakened. No live paper query, real Zotero library, paid model call, remote write
or frozen workflow-fixture edit. Next: version checkpoints/recovery/deletion and attachments.

## PR-05E1 — durable reviewed-page checkpoints

Status: `Verified passing` for this backend/API increment. Research DB15; no applied
migration rewritten. Full PR-05 and overall plan remain in progress.

Scoped sync sessions retain mode/full-vs-incremental range, same-instance local baseline,
fixed batch version/total, revision, pending preview, committed position and explicit control.
Captured preview/session publication is atomic. Acknowledge requires all captured keys
to have an actual owned same-preview/version import observation or an explicit skip reason.
Page decisions/seen objects/next offset and the final completed-batch version checkpoint
commit together. Partial imports or errors do not advance. Prior committed literature stays.

Pause/abandon abort actual HTTP; resume is explicit. Concurrent duplicate reads refuse before
dispatch. Pending preview replacement is explicit, stale/expired selection cannot acknowledge.
Version/instance/total change or duplicate across pages requires reset without erasing old
history. Actual DB file reopen preserves paused pending source/offset with no automatic
HTTP/worker. API recovery currently requires saved syncId and the same trusted owner/project;
UI discovery/recovery entry remains next work.

Pinned official source re-read via Agent Reach/Jina on2026-11-04 verifies local since/
versions and trash support, not a permanent-deletion API. Absent incremental objects do not
prove deletion/membership loss. This increment makes no deletion inference or Zotero write.

Commands from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `node --test tests/unit/zotero-sync.test.mjs tests/unit/zotero-import.test.mjs tests/unit/zotero-adapter.test.mjs` | Final37/37 passed |
| `pnpm test:unit` | Final780/780 passed |
| `pnpm harness:eval` |94/94 passed |
| `pnpm test:research-p0` | Fresh production build/typecheck/native13/13 passed |
| `node --test tests/renderer/zotero-import.test.mjs` |6/6 passed |
| `LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false ROC_SMOKE_TARGET=dist node scripts/smoke-electron.mjs` |12/12, zero renderer errors |
| `pnpm check:ipc` / `pnpm check:renderer-chunks` | Current;1131133bytes/6files passed |
| `git diff --check` | Passed |

Evidence `pr05-sync-*.log`, `pr05-sync-native-csl/` DB and native CSL/checkpoint receipts.
Initial test guessed bridge.handle; corrected to actual invoke/enveloped results. First full
suite detected three latest schema14 expectations after migration15; changed only latest
version assertions, preservation checks remain. Final full suite passes. No real Zotero
client/user library, new live literature query, paid model, remote write or frozen fixture edit.
Next: sync UI discovery/recovery, trash/membership state and attachment input grants.

## PR-05E2 — sync discovery, recovery and explicit rebaseline UI

Status: `Verified passing` for this UI/API increment. Research DB15 unchanged.
Full PR-05 and overall plan remain in progress.

Readonly scoped latest-session lookup and pending-page/imported-key read restore the actual
DB state and receipts, including tied timestamps. Existing dialog exposes full/incremental,
pause/resume/abandon, pending preview restore/recapture, authoritative refresh and explicit
page acknowledgement. It requires all captured objects loaded/displayed and actual import
receipts or user-entered skip reasons. Confirmation/source read/import are separate explicit
actions. Close/reopen restores paused state and receipts without automatic source/model work.
Prior-collection lookup cannot replace current scope; errors cannot become completion.

Review found full mode correctly retained the old version floor, leaving same-instance
rollback without an explicit reset entry. Added rebaseline mode/button: completed full-source
decisions may establish a lower latest checkpoint; old sync/library/source history and
object import version/conflict guards remain. Rebaseline is never automatic.

Commands from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `node --test tests/unit/zotero-sync.test.mjs tests/unit/zotero-adapter.test.mjs tests/unit/zotero-import.test.mjs` | Final39/39 passed |
| `pnpm test:unit` | Final782/782 passed |
| `pnpm harness:eval` | Final94/94 passed |
| `pnpm test:research-p0` | Final fresh build/typecheck/native13/13 passed |
| `node --test tests/renderer/zotero-import.test.mjs tests/renderer/literature-review.test.mjs` | Final12/12 passed (Zotero9, existing3) |
| `node --test --test-name-pattern='sync UI restores' tests/renderer/zotero-import.test.mjs` | Final keyboard/paused dark1099 layout1/1 passed |
| `LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false ROC_SMOKE_TARGET=dist node scripts/smoke-electron.mjs` | Final12/12, zero renderer errors |
| `pnpm check:ipc` / `pnpm check:renderer-chunks` | Current;1131133bytes/6files passed |
| `git diff --check` | Passed |

Evidence `pr05-sync-ui-*.log`, current `pr05-sync-native-csl/`, zotero-import-ui/ paused/
complete/long screenshots and audits. Dark1099 paused screenshot inspected; fixed title/
close, counts and source/receipt rows readable, cut0/hidden0. New paused reconnect initially
used a helper that required preview enabled; corrected to wait for the paused resume action.
Rebaseline test initially expected a failed job but the existing guard refuses before job/
worker; corrected assertion verifies that stronger boundary. No production checks weakened.

No real Zotero user library/client, new live literature query, paid model, remote write or
frozen workflow-fixture changes. Next: truthful remote trash/membership state and attachment
path/access grants; actual client interoperability and independent scientific/L2 acceptance
remain externally blocked.

## PR-05E3A — owned current-source observations

Status: `Verified passing` for this backend/API increment. Research DB16 appends
immutable observations linked by composite FK to the actual owned import receipt.
Applied migration SQL/name/checksum and existing library/evidence/attachment data stay intact.
Full PR-05 and overall plan remain in progress; source-state UI and attachment grants follow.

Explicit sourceObserve validates owner/project/operation and original object hash before HTTP.
Single-item GET binds the original instance/library/key and validates its object version.
Present/trash come from actual data; only API/schema/instance-validated404 yields not_found,
which does not prove permanent deletion. Current top-level collections prove membership;
child omitted collections remain unknown. Same-version data equality ignores key order and
unrequested CSL. Immutable raw/hash/timestamp/version observations survive preview expiry.
Readonly replay verifies linkage/hash; transport/write failures preserve prior valid state.
Shutdown aborts actual HTTP and refuses late publication. No automatic source read or deletion.

Commands from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `node --test tests/unit/zotero-import.test.mjs tests/unit/zotero-adapter.test.mjs tests/unit/zotero-sync.test.mjs` | Final46/46 passed |
| `pnpm test:unit` | Final789/789 passed |
| `pnpm harness:eval` | Final94/94 passed |
| `pnpm test:research-p0` | Fresh production build/typecheck/native13/13 passed |
| `node --test tests/renderer/zotero-import.test.mjs tests/renderer/literature-review.test.mjs` |12/12 passed |
| `LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false ROC_SMOKE_TARGET=dist node scripts/smoke-electron.mjs` |12/12, zero renderer errors |
| `pnpm check:ipc` / `pnpm check:renderer-chunks` | Current;1131133bytes/6files passed |
| `git diff --check` | Passed |

Evidence `pr05-source-state-*-complete.log`, `pr05-source-state-native-csl/` DB and receipt.
Regressions include native15→16 history preservation, owned refusal before HTTP,
validated404/key/version/deleted/collections, ordered present→membership removal→trash→missing
history, regressed/conflicting versions, expired-preview receipt access, damaged stored
observations, transport/write failure and shutdown abort. Native CSL proves actual stored
observation version8, readonly replay and unchanged paper revision.

Pinned official commit1ca9d58c9aa9aeca1032d3966f3765d4d40ab7b2 read via Agent Reach/Jina
on2026-11-04 verifies single-item object clientVersion, authenticated404 headers, top-level
collections/child omission and boolean deleted. Contract/read hashes retained. No actual
Zotero user library/client, new live literature query, paid model, remote write or frozen
workflow-fixture changes.

## PR-05E3B — current-source state in original-source details

Status: `Verified passing` for this UI increment. Existing dialog details read the last
owned local observation only on expansion; checking Zotero is an explicit action. Shows
true presence/trash/not-found, membership, original/current object versions and checked time.
Missing source does not prove permanent deletion; library/evidence/attachments stay intact.
Read damage differs from no observation. Check failure retains the valid observation and error.
Reopening reads saved state; scope/receipt keys prevent late old responses replacing current.
No original receipt means no source-check action. No automatic source read/import/checkpoint.

Commands from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `pnpm typecheck` / `pnpm build` | Passed |
| `node --test --test-concurrency=1 tests/renderer/` | Final69/69 passed |
| `node --test --test-name-pattern='source-state details|source-state UI' tests/renderer/zotero-import.test.mjs` | Final keyboard/layout2/2 passed |
| `LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false ROC_SMOKE_TARGET=dist node scripts/smoke-electron.mjs` |12/12, zero renderer errors |
| `pnpm check:ipc` / `pnpm check:renderer-chunks` | Current;1131133bytes/6files passed |
| `git diff --check` | Passed |

Prior backend789 unit/13 native/94 Harness results remain applicable: no service/schema changes.
Evidence `pr05-source-state-ui-*.log`, source-state screenshots/audits in zotero-import-ui/.
Light/dark1100/1099/800 observation states pass cut0/hidden0. Dark1099 inspected: source
status, membership unknown, versions, checked time and preservation copy visible; title fixed.
Initial new3 failures came from focusing the nested summary before parent details visibility;
probe showed outer summary stayed focused. Await visible state retains native Enter assertions.
No checks weakened, task-only debug removed. Full PR-05 remains unfinished; attachment
input grants and actual-client acceptance follow. No actual Zotero/user library, new live
literature query, paid model, remote write or frozen workflow-fixture changes.

## PR-05F1 — owned attachment reference and file inspection

Status: `Verified passing` for this backend/API increment. Research DB17 appends immutable
inspection observations linked to actual parent import receipts. Owner/project/operation
validation happens before HTTP; current child type/parent/linkMode are verified before
requesting the file reference. No source path grants permission to read bytes or import.

Imported file/imported URL/linked file remain distinct. Linked URL/embedded image/trash/
not-found skip file-path requests. Actual lstat/realpath/access distinguish ready/missing/
denied/invalid/unsupported document format or size. Captured file identity includes device,
inode, size and modification/change times; inspection drift fails. Raw/hash/parent/source
receipts and real time are retained. Scoped replay verifies integrity, remains valid after
preview expiry and never issues HTTP. Transport/write failure preserves earlier records;
shutdown aborts actual HTTP and prevents late publication. No canonical/document change.

Commands from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `node --test tests/unit/zotero-import.test.mjs tests/unit/zotero-adapter.test.mjs tests/unit/zotero-sync.test.mjs` |51/51 passed |
| `pnpm test:unit` |794/794 passed |
| `pnpm harness:eval` |94/94 passed |
| `pnpm test:research-p0` | Fresh production build/typecheck/native13/13 passed |
| `node --test --test-concurrency=1 tests/renderer/zotero-import.test.mjs tests/renderer/literature-review.test.mjs` |15/15 passed |
| `LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false ROC_SMOKE_TARGET=dist node scripts/smoke-electron.mjs` |12/12, zero renderer errors |
| `pnpm check:ipc` / `pnpm check:renderer-chunks` | Current;1131133bytes/6files passed |
| `git diff --check` | Passed |

Evidence `pr05-attachment-*.log`, `pr05-attachment-native-csl/` DB/receipt. Regressions use
actual chmod0 denial, real missing/symlink/unsupported files, sender bridge and migration16→17
history preservation, parent/type/mode refusal, corruption, expiry, writes/transport failure
and shutdown cancellation. Native CSL import inspects a real linked-file identity with
readonly replay, unchanged paper revision and zero documents. Prior15→16 regression explicitly
applies migrations through16 to preserve its named scope. Corrected the earlier ledger's
escaped regex separator to the exact executed keyboard/layout command; no product change.

Pinned official attachments.js read via Agent Reach/Jina verifies five exact linkMode names;
Item and Local API source establish parent fields and file/view/url reference semantics.
Source/read hashes retained. No actual Zotero client/user library, new live literature query,
paid model, remote write or frozen workflow-fixture edits. Next F2: native selected-file input
authorization, exact file validation and content import with provenance; UI follows.

## PR-05F2 — explicit native selected-file input grants

Status: `Verified passing` for this backend/API grant increment. Research DB18 appends
immutable scoped single-file grants linked to actual owned attachment inspections. Input
contains inspectionId/requestId/projectId only; renderer-selectedPath cannot authorize reads.
Validates current real path/file identity before opening the trusted sender's native picker,
then verifies the selected file is exactly the captured ready input before storing a grant.
Cancel has no grant; wrong/missing/symlink/changed file refuses. No file bytes or document import.

Grants retain read_one_file/path/device/inode/size/timestamps/inspection hash/granted time and
content hash. Readback validates owner/project/linkage/hash. Same request replays without
reopening; conflicting request reuse and active duplicate selections refuse. Write damage or
shutdown cannot become success. The picker dependency is explicit in production and tests;
agent thread owners cannot open the default native chooser. Electron loaded on user action.

Commands from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `node --test tests/unit/zotero-import.test.mjs tests/unit/zotero-adapter.test.mjs tests/unit/zotero-sync.test.mjs tests/unit/zotero-preview.test.mjs tests/unit/zotero-attachment-dialog.test.mjs` | Final66/66 passed |
| `pnpm test:unit` |801/801 passed |
| `pnpm harness:eval` |94/94 passed |
| `pnpm test:research-p0` | Fresh production build/typecheck/native13/13 passed |
| `node --test --test-concurrency=1 tests/renderer/zotero-import.test.mjs tests/renderer/literature-review.test.mjs` |15/15 passed |
| `LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false ROC_SMOKE_TARGET=dist node scripts/smoke-electron.mjs` |12/12, zero renderer errors |
| `pnpm check:ipc` / `pnpm check:renderer-chunks` | Current;1131133bytes/6files passed |
| `git diff --check` | Passed |

Evidence `pr05-attachment-grant-*.log`, native-csl/ DB/declared-chooser receipt and actual
native-api-complete.json. The native desktop probe runs Electron45 with a real hidden window
and confirms dynamic API import/actual sender lookup/owning window/native dialog function;
its task-created temporary script/report directory was removed. Native CSL grant uses an
explicit synthetic selection seam and keeps zero documents. Two mocked native API contract
tests verify parent/options/cancel/late response. Actual native panel selection is unrun.
Abort ends the job's native-choice wait and refuses publication; the native sheet follows its
owning-window lifecycle, not a claimed active dismissal handle.

First focused63/64 expected the wrong shutdown code; corrected to the actual core closed
refusal. Initial dialog-contract build used unsupported Unicode flags in esbuild Go filters;
removed those flags while retaining the exact match and tests. Final66/66 passes; no product
checks weakened. Migration17→18 preserves inspections and applied ledger without fictional
authorizations; earlier16→17 test explicitly keeps its named migration range. Framework
contract verified using Context7 official Electron docs/local45 types; actual binding proved.
No real Zotero client/user library, new live literature query, paid model, remote write or
frozen workflow-fixture change. Next F3: validate/consume grant, read exact file bytes and
import through existing document service with atomic provenance, then attachment UI.

## PR-05F3 — granted file bytes and atomic document provenance

Status: `Verified passing` for this backend/API import increment. Research DB19 adds scoped
attachment/document receipts linked to actual grants. Explicit library_only/current_project
input, owned grant/inspection/original linkage and nonarchived target are required before
bytes. Canonical O_RDONLY/O_NOFOLLOW descriptor identity is checked before/after bounded read;
missing/denied/changed/cancelled inputs fail. Verified bytes go to existing document persistence
without reopening the original source. No Zotero HTTP, auto parse/index or model work.

Document/source SHA-256/size and scoped raw-parent/inspection/grant/destination/time/hash
receipt commit together. Failed receipt rolls back document/project link and deletes this
operation's private copy, preserving the grant for explicit retry. Project change notification
is deferred until receipt commit; observer failure logs without invalidating committed files.
Request replay reads committed provenance despite later original-file deletion; new requests
for the same paper/content reuse its document with separate receipts. Request rebinding,
foreign scope or corrupt receipts refuse. Cancel signals active copy/publication, and shutdown
propagates into the prepared document job; no late receipt or fake parse completion.

Commands from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `node --test tests/unit/zotero-import.test.mjs tests/unit/zotero-adapter.test.mjs tests/unit/zotero-sync.test.mjs tests/unit/zotero-preview.test.mjs tests/unit/zotero-attachment-dialog.test.mjs tests/unit/research-evidence-invalidation.test.mjs` |76/76 passed |
| `pnpm test:unit` |806/806 passed |
| `pnpm harness:eval` |94/94 passed |
| `pnpm test:research-p0` | Fresh production build/typecheck/native13/13 passed |
| `node --test --test-concurrency=1 tests/renderer/zotero-import.test.mjs tests/renderer/literature-review.test.mjs` |15/15 passed |
| `LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false ROC_SMOKE_TARGET=dist node scripts/smoke-electron.mjs` |12/12, zero renderer errors |
| `pnpm check:ipc` / `pnpm check:renderer-chunks` | Current;1131133bytes/6files passed |
| `git diff --check` | Passed |

Evidence `pr05-attachment-import-*.log`, `pr05-attachment-import-native-csl/` DB/receipt.
Actual native CSL grant consumption copies and reads identical file bytes/hash, retains paper
revision and replays its receipt. Selection remains an explicitly declared injected synthetic
chooser; no actual native panel or real Zotero client is claimed. Regressions cover actual
sender API import/read/cancel and foreign refusal, content reuse/private-copy cleanup, original
loss, permission/change/archival refusal, write-trigger rollback/no early association event,
retry, cancellation/late prepared document, shutdown and native18→19 grant/ledger preservation.
Old17→18 test stays pinned to its named range. Existing direct document import consumers now
supply explicit notification policy; no compatibility alias or obsolete path added.

No real Zotero user library, new live literature query, paid model, remote write or frozen
workflow-fixture edits. Next: scoped attachment child discovery and original-source UI for
check/explicit selected-file grant/content import, then actual-client acceptance and X-UI.
Full PR-05 and overall plan remain unfinished.

## PR-05F4A — owned parent child discovery

Status: `Verified passing` for scoped backend/API discovery. Research DB19 unchanged.
`research.zotero.children` / `getZoteroChildren` require explicit project/source receipt and
pagination/version input. Owned original parent receipt is validated before HTTP; user/group
children endpoint stays on the fixed local API. Raw notes/attachments, exact counts, object
versions and library version remain distinct. Every child must match parentItem. No DB write,
file bytes, grant, worker or automatic HTTP. Shutdown aborts actual read and refuses late output.

Commands from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `node --test tests/unit/zotero-import.test.mjs tests/unit/zotero-adapter.test.mjs tests/unit/zotero-sync.test.mjs tests/unit/zotero-preview.test.mjs` |74/74 passed |
| `pnpm test:unit` |809/809 passed |
| `pnpm harness:eval` |94/94 passed |
| `pnpm test:research-p0` | Fresh production build/typecheck/native13/13 passed |
| `node --test --test-concurrency=1 tests/renderer/zotero-import.test.mjs tests/renderer/literature-review.test.mjs` |15/15 passed |
| `LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false ROC_SMOKE_TARGET=dist node scripts/smoke-electron.mjs` |12/12, zero renderer errors |
| `pnpm check:ipc` / `pnpm check:renderer-chunks` | Current;1131133bytes/6files passed |
| `git diff --check` | Passed |

Evidence `pr05-children-*.log`; native CSL regression reads actual original-parent children
after granted import. Tests cover owned/project refusal before dispatch, raw kinds/pagination/
counts, parent/version mismatch, actual bridge isolation and shutdown abort. Actual native
panel and real Zotero client remain unrun. No real library/live literature/model/remote writes
or frozen fixtures touched. Next F4B: readonly original-source entry for already-imported rows
and child discovery/inspection/explicit native grant/content-import UI. Full plan unfinished.

## PR-05F4B — explicit attachment UI and readonly imported-source access

Status: `Verified passing` for this UI increment. Imported sync rows expose independent
readonly original-source review while their bibliography checkbox stays disabled, including
paused state. Original details contain explicit children discovery/paging, raw kinds/counts/
versions and separate inspection/native single-file grant/destination/content-import steps.
File references, linked/managed modes, missing/denied/invalid/unsupported and source states
remain distinct; notes have no grant action. No eager source check, bytes or automatic parsing.

Dialog-owned source/project-keyed jobs retain inspection/grant/request/receipt during details/
tab/dialog closure. Retry keeps actual request and destination; cancellation acknowledgment
waits for original import exit. Selection cancellation means no grant. Late source/project
output cannot authorize or publish in current scope. Committed receipts display real hashes
and translated document status, including imported/unparsed. Reopen explicitly rediscovers
children and displays saved dialog state without repeating file selection/import. This UI
does not claim automatic pipeline recovery across application restart; backend receipts remain
durable and accessible by formal IDs. No second modal, shell or route.

Commands from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `pnpm build` | Fresh production build/typecheck passed |
| `node --test --test-concurrency=1 tests/renderer/` |77/77 passed |
| `node --test --test-name-pattern='attachment steps' tests/renderer/zotero-import.test.mjs` | Focused retry1/1 passed |
| `LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false ROC_SMOKE_TARGET=dist node scripts/smoke-electron.mjs` |12/12, zero renderer errors |
| `pnpm check:ipc` / `pnpm check:renderer-chunks` | Current;1131153bytes/6files passed |
| `git diff --check` | Passed |

Backend unchanged; previous F4A unit809/native13/Harness94 apply. Evidence
`pr05-attachment-ui-*.log` and `zotero-import-ui/attachment-*` screenshots/audits. Native
Electron renderer tests cover explicit steps, access modes, raw pagination, notes, paused
imported entry, exact input boundaries, selection cancel/new request, failure retry/same
request, real cancellation acknowledgment/exit, pending closure recovery, stale collection/
project/parent and keyboard/long-path light/dark1100/1099/800. Audits cut0/hidden0, fixed
title/close, no horizontal overflow or <12px new text. Initial18 run17 passed; the one new
JSX whitespace assertion was corrected without weakening action/state checks; final77 passed.
Native choice remains synthetic; actual panel/client interoperability unrun. No live model,
real library, remote writes or frozen fixtures. Next X-UI artifact inspector. Overall plan
and external scientific/model acceptance remain unfinished.

## X-UIA1 — project-scoped readonly artifact snapshots

Status: `Verified passing` for this backend/API increment. `research.artifacts.inspect` /
`research.inspectArtifact` require project/artifact IDs and explicit nullable expectedVersion.
One consistent read captures actual artifact/project/stage, saved role content and origin/task,
claims, artifact-local provenance and immutable evidence history. SHA-256 version includes
stored values, excludes read time and reports actual stale/new snapshots even for same-clock
edits. Null saved content remains null. Only real linked tasks expose return_to_task; this
increment cannot approve, edit or run work. It does not read arbitrary artifact.path bytes.

Evidence inspection retains original/hash-checked excerpts and recorded invalidation times;
recorded means no stored invalidation, not scientific or live source verification. Strict
getEvidence publication consumers still reject superseded references. Missing/cross-project/
corrupt sources fail explicitly. No DB migration/write, HTTP, model or worker. Production
files retain their existing inspectProduction/readProductionFile boundaries. Details in
`docs/research-artifact-inspector.md`; assistant/overlay/type modules/gate version binding next.

Commands from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `node --test tests/unit/research-artifact-inspector.test.mjs tests/unit/research-evidence-invalidation.test.mjs tests/unit/research-manuscript-integrity.test.mjs tests/unit/research-citation-integrity.test.mjs` |25/25 passed |
| `pnpm test:unit` |813/813 passed |
| `pnpm harness:eval` |94/94 passed |
| `pnpm test:research-p0` | Fresh production build/typecheck/native13/13 passed |
| `node --test --test-concurrency=1 tests/renderer/zotero-import.test.mjs tests/renderer/literature-review.test.mjs` |23/23 passed |
| `node --test tests/unit/research-artifact-inspector.test.mjs` | Final4/4 including exact missing-project category passed |
| `pnpm build` | Final production build/typecheck passed |
| `LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false ROC_SMOKE_TARGET=dist node scripts/smoke-electron.mjs` | Final12/12, zero renderer errors |
| `pnpm check:ipc` / `pnpm check:renderer-chunks` | Final current;1131153bytes/6files passed |
| `git diff --check` | Passed |

Evidence `xui-inspector-*.log` and actual native workflow
`p0-production/<taskId>/artifact-inspections.json`. Native checks inspect every completed
output with real origin/task/content identity and unchanged total_changes. Unit regressions
cover empty/recorded content, exact origin metadata, source isolation, same-clock edits, claims/
stage/invalidation version change, immutable invalidated excerpt retention, damaged/missing
source refusal, explicit input/actual sender bridge and permission/not_found errors. Final
error-category refinement does not mutate records; final4/build/startup establish that branch.
No frozen fixtures, live literature/model/client/user-data read or remote writes. X-UI and full
plan remain unfinished; next actual artifact references from assistant gate and readonly overlay.

## X-UIA2 — real assistant artifact links and lazy readonly drawer

Status: `Verified passing` for this readonly UI increment. Gate tool emits unique actual
project/artifact/version/title/kind links from current stage snapshots. Title-only payload and
obsolete helpers removed; malformed links cannot authorize approval or invent identity. Required
open callback traverses assistant/transcript/memoized message to AppShell. Project switch drops
old selection. Existing ModalShell hosts the lazy drawer and separately lazy saved Markdown,
real claims/evidence/invalidation/raw source. Refresh preserves reviewed baseline; changed data
requires explicit recapture. Escape restores source focus; actual task link uses management
drawer. No new approval/edit/automatic model/file request, second shell/navigation or route.

Commands from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `node --test tests/unit/research-search-plan.test.mjs tests/unit/research-artifact-inspector.test.mjs` |11/11 passed |
| `pnpm test:unit` |813/813 passed |
| `pnpm harness:eval` |94/94 passed |
| `pnpm test:research-p0` | Fresh production build/typecheck/native13/13 passed |
| `node --test --test-concurrency=1 tests/renderer/artifact-inspector.test.mjs tests/renderer/research-search-plan.test.mjs` |8/8 passed after targeted harness corrections |
| `node --test --test-concurrency=1 tests/renderer/` |82/82 passed |
| `LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false ROC_SMOKE_TARGET=dist node scripts/smoke-electron.mjs` |12/12, zero renderer errors |
| `pnpm check:ipc` / `pnpm check:renderer-chunks` | Current;1132666bytes/6files passed |
| `git diff --check` | Passed |

Evidence `xui-overlay-*.log`, `artifact-inspector-ui/` light/dark1100/1099/800/source screenshot
and audit. Electron checks call actual repository/registered capability/generated bridge from
a Playwright exposure seam in the Node test host with the true desktop sender ID; this is not
a claim of production preload transport. Actual persisted IDs/source/task, zero DB changes,
empty/missing/permission/integrity, invalidation/stale recapture, late response, focus/task
return without approving, keyboard and reduced-motion verified. Native13 covers runtime
persistence; production startup covers assembled shell.

Initial8 run5 passed: native summary text also matched closed raw JSON, selector corrected.
Second8 run6 passed: newly imposed hidden0 audit expectation conflicted with shared full-height
drawer physical top/right/bottom edges. Mandatory cut0 retained; exact3 hidden panel edges/gap0
asserted and all other issues refused. Left shadow visible; dark1099 screenshot inspected. Final
8 and full82 pass. No shared shadow/style changed or source/action guard weakened. Last source
changes only whitespace/comment attachment. No live client/model/literature, remote writes or
frozen workflow fixtures. Next X-UIA3: version-bound human gate context/approve/reject and refresh
back to assistant confirmation, then production type views/reading position. Full plan unfinished.


## X-UIA3A — whole-stage artifact versions bound to human decisions

Status: `Verified passing` for this gate contract increment. Readonly gateReview capability
returns a consistent entire current waiting-stage context with actual artifact versions and
strict discovery plan scope. Archived/missing/foreign/inactive/empty/nonwaiting inputs refuse.
Approve/reject require complete unique SHA versions; approve checks before production IO and
again in its write transaction. All decisions including review revision retain human versions
in audit events. HITL generic decisions carry optional research versions; custom gate requires
them. Cards disable all decisions for malformed IDs instead of accepting a no-op click.

Child review graph has one interrupt per node invocation. Known missing/changed review values
return an explicit failed decision and conditional edge to a new interrupt ID, with no DB
writes. Human must explicitly review and decide again; replay never adopts new values.
Unknown/domain publication failures propagate. No renderer direct approval endpoint introduced.

Commands from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `pnpm generate:ipc` / `pnpm typecheck` | Generated; final fresh build/typecheck passed |
| `node --test tests/unit/research-gate-review.test.mjs tests/unit/research-search-plan.test.mjs` |13/13 passed |
| `pnpm test:unit` |819/819 passed |
| `pnpm harness:eval` |94/94 passed |
| `node --test tests/unit/research-gate-review.test.mjs` | Final6/6 after archived/nonwaiting/selected-stage refinement |
| `pnpm test:research-p0` | Final fresh production build/typecheck/native13/13 passed |
| `node --test --test-concurrency=1 tests/renderer/` |83/83 passed |
| `LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false ROC_SMOKE_TARGET=dist node scripts/smoke-electron.mjs` |12/12;zero renderer errors |
| `pnpm check:ipc` / `pnpm check:renderer-chunks` |Current;1132666bytes/6files passed |
| `git diff --check` |Passed |

Evidence `xui-gate-*.log` and existing native fault source receipt. Unit6 covers missing/empty/
duplicate/extra/foreign/stale versions, same-clock body change, source invalidation, set change,
readonly actual bridge and current-stage constraints, exact event payloads, pre/post async
verification, all stale decision kinds, distinct interrupt IDs and explicit reread/reconfirmation.
Synthetic production signature and incomplete review cycle seams are explicit; native13 covers
actual published production/evidence/review path. Initial fixture setup errors were corrected
without loosening production guards. Latest official LangGraph docs require conditional edges
instead of node-local repeated interrupt loops. Native initial12/13 expected old superseded
boundary: final version guard now rejects first, exact review_changed assertion plus separate
strict superseded getter retained. Final13 passes. Last repository status/selected-stage checks
verified by final6/fresh native and assembled UI. No frozen workflow fixtures, new live queries,
model spending, client operations or remote writes. Next A3B inspector/card whole-context refresh
and return to original confirmation, then production type views/reading location. Full plan pending.


## X-UIA3B — explicit whole-stage reread and return to assistant confirmation

Status: `Verified passing` for the version-bound inspector/assistant UI. Inspector explicitly
reads all stage artifacts and versions, then returns that context only on a separate action.
The displayed selected snapshot must match captured review version before return; stale body
requires explicit refresh and actual new content inspection. Card state is keyed by real
interrupt/project/stage, replaces all links/versions/discovery plan/hash, and requires another
explicit decision through existing chat resume. Pending/failed card reads disable all decisions;
malformed links can recover from real project/stage only. No title aliases or guessed identities.

Type-only open/context callbacks stay outside eager inspector graph; stable reader crosses
AssistantPanel/transcript/message memo. Escape returns actual source focus. Context return
focuses original card's reread control with preventScroll. Selection/project/interrupt changes
reject late response scope. No renderer direct approval API, DB write/model/worker on reads.

Commands from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `pnpm typecheck` / `pnpm build` | Final production build/typecheck passed |
| `node --test --test-concurrency=1 tests/renderer/artifact-inspector.test.mjs tests/renderer/research-search-plan.test.mjs` | Final13/13 passed |
| `node --test --test-concurrency=1 tests/renderer/` | Final87/87 passed |
| `LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false ROC_SMOKE_TARGET=dist node scripts/smoke-electron.mjs` | Final12/12;zero renderer errors |
| `pnpm check:ipc` / `pnpm check:renderer-chunks` | Current;1132803bytes/6files passed |
| `git diff --check` |Passed |

A3A unit819/Harness94/native13 backend evidence applies unchanged; no backend files changed.
Evidence `xui-review-ui-*.log` and artifact-inspector-ui/gate-whole-context.png plus returned card.
Actual repository/registered/generated read bridge and real parent+child LangGraph interruptions
are called via declared Playwright-to-Node seam, not production chat/preload transport. Explicit
whole reread/return keeps total_changes unchanged and original interrupt ID; keyboard approval
then commits actual stage advancement. Stale original click returns a new actual interrupt with
no writes; explicit reread and rejection succeeds. Late context reads drop on selection/project.
Discovery synthetic reader covers malformed-link repair, read failure/pending refusal and complete
new plan/hash/versions. Light/dark1100/1099/800,reduced-motion,keyboard/actual source focus and
strict full-height cut0/three physical-edge hidden audit remain passing. Final screenshot exposed
new gate hashes with old body; added return guard, explicit new-body regression and rebuilt/reran
full87/startup. Final screenshot inspected: selected review/display hashes and latest body match.
No frozen fixtures/client/model/live queries/remote writes. Next production type views and reading
location; X-UI/full plan unfinished.


## X-UIA4 prerequisite — actual figure production file reader

Status: `Verified passing`. Production input file reads dispatch figure-run identities to the
figure reader, experiment identities to experiment reader and export identities to export reader.
Previously figure reads called experiment.read and actual approved PNG failed with
research_experiment_not_found. Required figure reader dependency replaces that incorrect route;
existing approved-artifact/path/preview-size/hash checks remain. No expanded draft/role authority.

Commands from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `node scripts/run-research-p0.mjs --test-name-pattern='trusted chat task spans'` | Red1/1 research_experiment_not_found; green1/1 passed |
| `pnpm test:unit` |819/819 passed |
| `pnpm harness:eval` |94/94 passed |
| `pnpm test:research-p0` |Fresh production build/type/native13/13 passed |
| `LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false ROC_SMOKE_TARGET=dist node scripts/smoke-electron.mjs` |12/12;zero renderer errors |
| `pnpm check:ipc` / `pnpm check:renderer-chunks` |Current;1132803bytes/6files passed |
| `git diff --check` |Passed |

Evidence xui-production-read-*.log and real native task production-input-previews.json. Native
workflow now reads actual approved output files for experiment/figure/export, verifies returned
bytes SHA/size against saved file metadata and unchanged total_changes, and explicitly refuses
preapproval reads. Figure selection requires actual output PNG. Existing renderer87 from A3B
applies unchanged; no renderer files changed. No frozen workflow fixture modifications, client
operations, live queries, paid model or remote writes. Production reviewer contract/type views
and reading location still pending; full plan unfinished.


## X-UIA4B1 — source-aware versions and readonly human production inspection

Status: `Verified passing` for this backend contract increment. Artifact snapshots include
actual saved experiment/figure/export source/execution/publication/validation/file metadata;
SHA covers it without filesystem reads. Real production kinds require their saved publication,
no empty production fallback. Human production inspection/read accepts explicit current artifact
SHA and file read also requires exact selected file SHA. Draft access requires actual current
waiting gate, approved access remains available; archived/superseded/foreign/stale/nonwaiting
refuse before IO. Artifact SHA is checked again after async verify/read; current file metadata
and actual returned bytes must match. Existing role endpoints remain approved-only; new human
review capabilities are not added to role allowlists.

Experiment inspection verifies the existing published manifest and file hashes read-only.
It no longer calls the publication snapshot writer; missing manifest cannot regenerate.
Publication writer remains in the actual publish flow. New review IPC errors retain specific
validation/permission/conflict/not_found/degraded categories; unknown errors still propagate.
No DB migration, model, worker launch, arbitrary renderer path or production write introduced.

Commands from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `pnpm generate:ipc` / `pnpm typecheck` |Generated;final build/typecheck passed |
| `node --test tests/unit/research-production-review.test.mjs tests/unit/research-gate-review.test.mjs tests/unit/research-artifact-inspector.test.mjs tests/unit/research-search-plan.test.mjs` |22/22 passed |
| `pnpm test:unit` |824/824 passed |
| `pnpm harness:eval` |94/94 passed |
| `node --test tests/unit/research-production-review.test.mjs` |Final5/5 with generated-bridge error category assertions |
| `pnpm test:research-p0` |Final fresh production build/type/native13/13 passed |
| `node --test --test-concurrency=1 tests/renderer/` |87/87 passed before final error mapping refinement |
| `node --test --test-concurrency=1 tests/renderer/artifact-inspector.test.mjs tests/renderer/research-search-plan.test.mjs` |Final13/13 passed |
| `LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false ROC_SMOKE_TARGET=dist node scripts/smoke-electron.mjs` |Final12/12;zero renderer errors |
| `pnpm check:ipc` / `pnpm check:renderer-chunks` |Current;1132803bytes/6files passed |
| `git diff --check` |Passed |

Evidence xui-production-review-*.log and real native production-review-previews.json. New unit5
uses actual local renderer, saved publication and captured fixed input evidence. Source metadata
edits at same clock change review SHA; actual draft PNG bytes hash/size and zero DB changes,
strict role refusal, invalid/foreign/stale/out-of-gate before-IO refusals, during-read/version
changes and real generated bridge contracts/categories pass. Previous synthetic timing source
is replaced by actual saved figure source. Initial fixture omitted required evidence; added
actual capture of copied synthetic input, without loosening figure evidence guards. Test-only
run_id typo and strict inspect/read envelope misuse corrected. Native reviewer reads actual
experiment/figure/export before approval with matching bytes/SHA/size and no writes. Removes
only its own resolved temporary experiment manifest, asserts ENOENT and no regeneration, then
restores exact bytes. Approved original role reads continue passing. No frozen fixture changes,
live clients/queries/model spending or remote writes. Lazy production type UI and reading position
remain next; X-UI/full plan unfinished.


## X-UIA4B2 — lazy production source and verified file views

Status: `Verified passing` for this UI increment. Explicit production opening loads actual
experiment/figure/export source modules on demand. Metadata reflects saved execution,
publication, validation and export identities. Files remain explicit readonly selections,
scoped by artifact version and file hash; escaped text and verified raster data have no Blob
URL. Old file/version/project responses cannot replace current content. Errors have explicit
retry; >4MiB reads are disabled. PDF positioning is visibly pending PR-07, ZIP is metadata-only.
No backend or role permission changes. Reading-location recovery remains next.

Commands from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `pnpm build` |Final fresh build/type passed |
| `node --test --test-concurrency=1 tests/renderer/artifact-production.test.mjs` |Initial6/6 passed |
| `node --test --test-concurrency=1 tests/renderer/` |Final94/94 including production7 passed |
| `LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false ROC_SMOKE_TARGET=dist node scripts/smoke-electron.mjs` |Final12/12;zero renderer errors |
| `pnpm check:ipc` / `pnpm check:renderer-chunks` |Current;1132803bytes/6files passed |
| `git diff --check` |Passed |

Logs xui-production-ui-*.log. Electron actual saved figure preview verifies PNG216x144,
returned bytes SHA/size, original CSV, no DB changes and still-draft status. Typed synthetic
experiment/export cases isolate renderer presentation and explicit requests; A4B1 native13
establishes all three actual source/read contracts. Retry/failure/no-read limit regressions
passed. Final light800 and dark1099 source/PNG screenshots inspected; keyboard focus visible,
fixed title/close, wrap and nested scroll readable. Audit cut0, only full-height physical
panel top/right/bottom shadows hidden. Frozen workflow fixtures and unrelated docs untouched.
Full plan unfinished; reading-location recovery then evidence relationships next.


## X-UIA4B3 — version-bound window-local reading recovery

Status: `Verified passing`. One AppShell-owned Map retains per-project/artifact current-version
scroll, expanded native details, focus and production area/file metadata. Close/task/review
return captures position; reopening always inspects and re-reads actual production bytes.
Only verified identical SHA restores. New-version pending inspection cannot retain old file
metadata. Actual DOM/size changes restore lazy content; reader pointer/key/wheel stops
observers so delayed file delivery cannot overwrite a manual position. Shared ModalShell
accepts an explicit bodyRef, preserving existing overlay stack/Escape/return-focus behavior.
No localStorage, cached source bytes, review decisions, backend or role permission changes.

Commands from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `pnpm typecheck` |Initial undefined Map entry error fixed;second/final passed |
| `node --test --test-concurrency=1 tests/renderer/artifact-inspector.test.mjs tests/renderer/artifact-production.test.mjs` |Third17/17 passed |
| `pnpm build` |Final2 fresh build/type passed |
| `node --test --test-concurrency=1 tests/renderer/` |Final2 96/96 passed |
| `LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false ROC_SMOKE_TARGET=dist node scripts/smoke-electron.mjs` |Final2 12/12;zero renderer errors |
| `pnpm check:ipc` / `pnpm check:renderer-chunks` |Current;1132980bytes/6files passed |
| `git diff --check` |Passed |

Evidence xui-reading-*.log. Same-version real source details restore expansion/scroll/focus
without a decision. Actual draft figure selected CSV revalidates bytes, restores area/body
and focus after Escape, retains manual pointer position on delayed response, rejects old
reading state after source changes and close-during-new-inspection. First broader UI test
expected old production visibility across a version change; updated it to require explicit
new-version opening. Early screenshot suspicion resolved by actual553/553px scroll-container
measurement with no overflow descendants, and final CSS-scale panel screenshot inspected.
All light/dark1100/1099/800 audits remain cut0 with only three physical full-height edge
shadows hidden. A4B1 unit824/Harness94/native13 backend evidence applies unchanged.
X-UI local offline acceptance complete; actual repository/parent-child gate path uses a named
Playwright-to-Node seam and does not claim production chat/preload transport. Next PR-06 evidence
semantics/locators; whole plan and external scientific/live-client acceptance remain unfinished.


## PR-06A1 — immutable managed-document source locators

Status: `Verified passing` for this source contract increment. DB20 sidecars capture the actual
managed document/parse/block association, source and canonical parsed-content SHA, parser
fingerprint, original locator and saved page/regions. Exact nonblank indexed block ordering,
excerpt and locator match prevents duplicate-prose mislocation. Current ready parse and
source hash required. Evidence/metadata/locator commit together. Re-capture idempotent; saved
location conflicts refuse replacement. Reparse preserves old evidence/coordinates and strict
consumers still refuse superseded references. Historical evidence is not backfilled or assigned
fake coordinates/reviewers. Unmanaged sources explicitly have nullable locator. HTML zero
geometry records page-only null region; invalid pages/inverted geometry refuse. Inspector
includes source locator in existing artifact SHA with no file read/write or worker launch.

Commands from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `pnpm generate:ipc` |Current generated contract |
| `pnpm typecheck` |Initial and final fresh build passed |
| `node --test tests/unit/research-source-locator.test.mjs tests/unit/research-artifact-inspector.test.mjs tests/unit/research-evidence-invalidation.test.mjs tests/unit/database-migrations.test.mjs tests/unit/research-manuscript-integrity.test.mjs tests/unit/research-citation-integrity.test.mjs` |Third43/43 passed before final geometry case |
| `pnpm test:unit` |Final3 830/830 passed including locator6 |
| `pnpm harness:eval` |Final2 94/94 passed; no harness changes after geometry check |
| `pnpm test:research-p0` |Final3 fresh build/type/native13/13 passed |
| `node --test --test-concurrency=1 tests/renderer/artifact-inspector.test.mjs tests/renderer/artifact-production.test.mjs tests/renderer/research-search-plan.test.mjs` |Final3 22/22 passed |
| `LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false ROC_SMOKE_TARGET=dist node scripts/smoke-electron.mjs` |Final3 12/12;zero renderer errors |
| `pnpm check:ipc` / `pnpm check:renderer-chunks` |Current;1132980bytes/6files passed |
| `git diff --check` |Passed |

Logs pr06-source-locator-*.log. Unit synthetic parse input is clearly separate from native
actual PDF parsing. Native full workflows save evidence-source-locator.json and verify actual
document/parse/source/canonical parse hash/block/excerpt/regions plus zero inspection DB writes.
Initial test failures were expected digest before canonical schema ordering and incorrect
migration fixture stage/kind; fixed tests to actual persisted parse and discovery/search_strategy.
Three older literature migration tests expected final DB19 while applying all migrations;
updated final version to20 retaining every data/provenance assertion. No frozen fixture, live
query/client, paid model or remote write. Coordinate projection/preview belongs to PR-07.
Next PR-06 semantic relation proposal/review/history and consumers/UI; whole plan unfinished.

## ROC-PR-06A2 — versioned relation proposals, human decisions and history

DB21 stores complete claim/source snapshots and supports/contradicts/qualifies/depends_on/
supersedes proposals. User-only reviews bind relation/claim/source versions; confirmed
supersession invalidates the prior relation atomically. Claim/source writers invalidate active
relations in their existing transaction and retain original reviewers plus system reasons.
History-write failure rolls back every affected change. Historical evidenceIds migrate without
invented semantic reviews or changed claim status; invalid endpoints roll back to DB20.
Required inspector relations participate artifact SHA and stale the original gate capture.
User metadata review works at the current waiting gate; content editing remains stage locked.

Verification from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `pnpm typecheck` |Final2 passed |
| `pnpm test:unit` |Final2 841/841 passed |
| `pnpm harness:eval` |94/94 passed; subsequent change only adds waiting-gate user review boundary |
| `pnpm test:research-p0` |Final2 fresh build/type/native13/13 passed |
| `node --test --test-concurrency=1 tests/renderer/` |Clean96/96 passed |
| `LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false ROC_SMOKE_TARGET=dist node scripts/smoke-electron.mjs` |Clean12/12; zero renderer errors |
| `pnpm check:ipc` / `pnpm check:renderer-chunks` |Current;1132980bytes/6files passed |
| `git diff --check` |Passed |

Logs pr06-relations-*.log. Native actual parsed PDF writing claim records explicit synthetic
local-user repository proposed→confirmed seam and retained evidence-relation-history.json;
old gate approval refuses without writes, then explicit new versions allow the original gate.
Model transport, strict semantic consumers and matrix UI remain next; PR-06 is not complete.
Two early full renderer runs timed out on the unchanged settings second Escape. Standalone1,
preceding pair4, prefix53, instrumented96 and final original clean96 passed. Temporary tagged
traces removed; settings source/test unchanged; intermittent cause not established or claimed
fixed. Name-filtered directory probe hung in an unmatched before hook and was terminated;
not counted as verification. Frozen research-workflow fixtures remain untouched. No remote
writes, paid models or live literature requests.

## ROC-PR-06A3A — trusted human relation IPC and exact source reads

Generated source inspection, relation listing/history and human proposal/review APIs. Main
adapter binds sender window+project+capability in asynchronous context; schemas accept no
caller-provided actor. Missing sender/direct capability calls/cross-scope context refuse.
Actual source digest and actionable permission/conflict/not_found/degraded errors remain
explicit. Concurrent windows keep separate requester identities. No agent review capability
added to role tools; model proposals, matrix UI and strict semantic consumers remain next.

Verification from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `pnpm generate:ipc` |Generated source contract and preload methods |
| `node --test tests/unit/research-evidence-relation-ipc.test.mjs tests/unit/research-evidence-relations.test.mjs tests/unit/research-artifact-inspector.test.mjs tests/unit/ipc-*.test.mjs` |Initial21/21 passed before extra forgery/no-write assertions |
| `pnpm test:unit` |Final845/845 passed |
| `pnpm harness:eval` |Final94/94 passed |
| `pnpm test:research-p0` |Final fresh build/type/native13/13 passed |
| `node --test --test-concurrency=1 tests/renderer/artifact-inspector.test.mjs tests/renderer/artifact-production.test.mjs tests/renderer/research-search-plan.test.mjs` |Final22/22 passed |
| `LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false ROC_SMOKE_TARGET=dist node scripts/smoke-electron.mjs` |Final12/12; zero renderer errors |
| `pnpm check:ipc` / `pnpm check:renderer-chunks` |Current;1132980bytes/6files passed |
| `git diff --check` |Passed |

Logs pr06-relation-ipc-*.log. Native full workflow now invokes actual registered capabilities
through generated adapter for actual parsed-PDF source→proposal→review; direct capability
refusal/no-write checked, proposer window91/reviewer window92 recorded. Window IDs are
explicit synthetic main inputs; actual renderer user path is the next UI increment. Existing
old-gate refusal and new exact-version approval remain verified. No frozen fixture changes,
paid/live requests or remote writes. PR-06 and overall plan remain incomplete.

## ROC-PR-06A3B — actual inspector relation matrix and human review

Lazy matrix shows current confirmed/proposed support, contradiction and qualification counts,
with original-order weak/contradiction/pending filters and explicit historical association
labels. Details preserve fixed excerpts, conditions, source/claim hashes, actors and explicit
readonly history. Human source selection re-inspects digest before proposing; qualification
needs conditions and supersession needs a prior relation. Explicit confirm/reject bind the
shown versions. Success refreshes artifact, requires current recapture and separate whole-
stage gate reread; confirmation retains hypothesis status. Old/inactive sources refuse.
Late responses after selection change cannot refresh another project. Inspector now includes
relation evidence endpoints beyond old claim evidenceIds, without rewriting the associations.

Verification from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `pnpm build` |Final2 fresh type/build passed |
| `node --test tests/unit/research-evidence-relations.test.mjs tests/unit/research-evidence-relation-ipc.test.mjs tests/unit/research-artifact-inspector.test.mjs` |20/20 passed |
| `pnpm test:unit` |Final846/846 passed |
| `pnpm harness:eval` |Final94/94 passed |
| `pnpm test:research-p0` |Final fresh build/type/native13/13 passed |
| `node --test --test-concurrency=1 tests/renderer/artifact-inspector.test.mjs` |Finalscope14/14 passed |
| `node --test --test-concurrency=1 tests/renderer/` |Final2 101/101 passed |
| `LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false ROC_SMOKE_TARGET=dist node scripts/smoke-electron.mjs` |Final2 12/12; zero renderer errors |
| `pnpm check:ipc` / `pnpm check:renderer-chunks` |Final2 current;1132980bytes/6files passed |
| `git diff --check` |Passed |

Logs pr06-relation-ui-*.log. New Electron tests exercise actual registered adapter with the
actual Electron webContents sender: source→proposal→user review→history→fresh context→original
LangGraph gate. Synthetic scientific content is explicitly labelled. Source invalidation
between display and decision refuses without writes; late actual write response cannot refresh
new project. Source endpoints beyond associations retain actual invalidation/no-write checks.
Light1100, dark1099 and light800 reduced-motion screenshots/audits retained at
.artifacts/research-optimization/artifact-inspector-ui/relations-*.png and *-audit.json;
cut0, only three known physical drawer-edge shadows hidden, no horizontal overflow or fonts<12.
Final light800 screenshot reviewed after nonshrinking 查看 label correction.

First UI failures mixed synchronous focus retargeting onto summary and test actions before
expanded native details painted. Matrix jumps now focus a noninteractive details group with
visible focus; test controls wait for visibility and assert actual focus before Enter. Reader
probe had no saved location/restore callbacks; reading restoration code unchanged. Temporary
probes removed, original assertions/timeouts preserved. Model proposals, strict semantic
consumers, migration candidates and historical exports remain next; PR-06 is incomplete.

## ROC-PR-06A3C — bound model support proposals and readonly role facts

Actual stage completion records model supported declarations as proposed supports per real
evidenceId, inside the original artifact/claim/content/run transaction. Proposer is the actual
running stage/active lineage. Hypothesis/pending associations remain nonsemantic and their
status is unchanged. History failure rolls back the whole output; duplicate completion or
completed/foreign producer cannot write another proposal. No output schema aliases or frozen
fixture edits. Role tools expose paginated fixed source/digest and relation facts under bound
project/active-run checks; no human review tool. User-reviewed snapshots remain distinct.

Verification from `/Users/Apple_501/Desktop/Roc/Roc`:

| Command | Actual result |
| --- | --- |
| `pnpm typecheck` |Initial and final fresh build passed |
| `node --test tests/unit/research-model-relation-proposals.test.mjs tests/unit/research-evidence-relations.test.mjs tests/unit/research-evidence-relation-ipc.test.mjs tests/unit/research-search-plan.test.mjs tests/unit/research-figure-owned.test.mjs` |33/33 passed |
| `pnpm test:unit` |Final849/849 passed |
| `pnpm harness:eval` |Final94/94 passed |
| `pnpm test:research-p0` |Final fresh build/type/native13/13 passed |
| `node --test --test-concurrency=1 tests/renderer/artifact-inspector.test.mjs tests/renderer/artifact-production.test.mjs tests/renderer/research-search-plan.test.mjs` |Final27/27 passed |
| `LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false ROC_SMOKE_TARGET=dist node scripts/smoke-electron.mjs` |Final12/12;zero renderer errors |
| `pnpm check:ipc` / `pnpm check:renderer-chunks` |Current;1132980bytes/6files passed |
| `git diff --check` |Passed |

Logs pr06-model-relations-*.log. Actual native PDF/stage model output saves
model-relation-proposals.json alongside human evidence-relation-history.json. Inspected two
actual writing-run proposed supports, null reviewers/times, one fixed native PDF locator and
one actual unmanaged experiment source. Native gate version changes still refuse old captures.
No paid/live model query, remote writes or fixture changes. Existing scientific quality and
actual Zotero-client limitations remain. Strict semantic approval/export consumers, invalidation
seals, source-migration candidates and historical exports are next; PR-06 remains incomplete.


## ROC-PR-06A4A — semantic approval and current export

Verified passing for this increment. Complete permits draft review; final approve transaction
requires current confirmed supports/qualifies covering each declared source and refuses
confirmed contradictions. Historical/proposed/rejected/invalidated/dependency/superseding
relations cannot count as support. Conditions remain captured. Draft manuscript writes and
inspection retain source integrity; approved body/current export and selected figures also
require reviewed semantics. Claim/source changes revoke effective reviews while inspection
retains original source and reviewer. Known semantic refusals produce a fresh original gate
interrupt without writes; explicit human review and whole-stage reread then permit approval.

Native offline scenarios now confirm actual model proposals through separate synthetic
window:93 user registry/generated adapter. This proves transport and consumers, not real
scientific conclusions. Frozen research-workflow fixtures were not changed.

All commands from /Users/Apple_501/Desktop/Roc/Roc:

| Check | Result |
| --- | --- |
| node --test tests/unit/research-semantic-publication.test.mjs | Red: missing rejection; green8/8 |
| node --test tests/unit/research-semantic-publication.test.mjs tests/unit/research-export-body-gate.test.mjs tests/unit/research-evidence-relations.test.mjs tests/unit/research-gate-review.test.mjs | Final32/32 |
| pnpm test:unit | Final857/857 |
| pnpm harness:quality:check | Offline16-task audit passed; no model/external calls |
| pnpm harness:eval | 94/94 |
| pnpm build | Typecheck and fresh production build passed |
| node scripts/run-research-p0.mjs | 13/13 native |
| node --test --test-concurrency=1 tests/renderer/artifact-inspector.test.mjs tests/renderer/artifact-production.test.mjs tests/renderer/research-tasks.test.mjs tests/renderer/research-search-plan.test.mjs | 37/37 actual Electron |
| node scripts/smoke-electron.mjs --full | Base startup12/12, zero renderer errors; additional P4 failed |
| pnpm check:ipc / pnpm check:renderer-chunks / git diff --check | Passed; eager1132980 bytes6files |

Expanded P4 waited30s for visible assistant running state at gate1. The same unchanged
script reproduces that failure both standalone and in clean detached b47dab11 baseline
with fresh build; baseline working directory was task-owned
.artifacts/research-optimization/pr06-p4-baseline. No script/assertion/timeout relaxation.
Exact reports/logs retained as pr06-semantic-p4-* under the task artifact directory;
task-owned temporary checkout removed. This pre-existing broad check remains unresolved.

Strict source-review seals, export captured relation/locator snapshots and migration candidates
are next. PR-06 and the whole execution plan remain incomplete. Independent scientific
judgments, reviewed200-task corpus, L2 spend and actual Zotero-client acceptance remain unrun.


## ROC-PR-06A4B — sealed export scientific review and historical reads

Verified passing. New manifestv2 archives include provenance/scientific-review.json with
strict required source/claim/relations/history arrays, real captured sourceLocator and human
review versions. Canonical bytes/hash/size bind the review file to original sources.sourceHash.
Independent relation evidence endpoints are included even outside claim.evidenceIds. New ready
finish/publication, final gate transaction and delivery after async copy reject missing/changed
seals; known refusal returns a new original LangGraph interrupt. Export jobs retain domain codes.

Historical sources, files and archives are not rewritten or backfilled. Fixed historical
inspect/read/source verify original content seals, while current verification/publication/delivery
requires valid current sources/relations/review seal. This uses existing versioned immutable
file contracts without a DB migration, compatibility alias or invented historical reviewer.

Commands from /Users/Apple_501/Desktop/Roc/Roc:

| Check | Result |
| --- | --- |
| node --test tests/unit/research-semantic-publication.test.mjs | Final9/9, including bad sourceHash/missing seal/independent endpoint decision |
| pnpm test:unit | 858/858 before final direct sourceHash assertion; final focused/native check covers it |
| pnpm build | Final typecheck and fresh production build passed |
| node scripts/run-research-p0.mjs | Final13/13 native |
| node --test --test-concurrency=1 tests/renderer/artifact-inspector.test.mjs tests/renderer/artifact-production.test.mjs tests/renderer/research-search-plan.test.mjs | 27/27 Electron |
| node scripts/smoke-electron.mjs | 12/12, zero renderer errors |
| pnpm harness:eval | 94/94 |
| pnpm check:ipc / pnpm check:renderer-chunks / git diff --check | Passed, eager1132980bytes6files |

Native evidence under .artifacts/research-optimization/p0-production/<taskId> retains
provenance/scientific-review.json, manifest.json and historical-export-audit.json. Actual
PDF parse/block/source locator, synthetic window:93 confirmation and full revisions are
captured. Tampered task-created review file rejects inspect/read; exact byte/mode restoration
passes. After source invalidation, original record/review/PDF/sourceHash/archiveHash remain
unchanged, current delivery refuses without a destination, and reads/refusals produce zero DB writes.

Initial fullunit hit missing installed Electron45 dist/path.txt (ENOENT); no new source
assertion failed. Restored the existing local electron-v45.0.0-darwin-arm64.zip after checksum
896c3a50b148e89a158dca08a6996a022ddf39b23aac871e107f5b4087f8caa9 matched package
checksums. Shipped extractor restored bytes; optional absent zip dts caused a rename error,
then exact path metadata was restored. Stopped only task-owned automatic download processes.
No tracked dependency/lock change. Missing-runtime origin remains undetermined.

PR-06 source migration candidates remain next, then PR-07. The earlier baseline-confirmed
expanded P4 assistant smoke defect and external scientific/client/L2 acceptance remain unresolved.


## ROC-PR-06A5A — immutable same-document source migration proposals

Verified passing for the backend increment. DB22 adds proposal snapshots/SHA and indexed
document locator lookup. Actual reparse completion creates candidates in the same transaction
as parse/index replacement and evidence invalidation. Exact full text then whitespace-only
matching is explicit; duplicates remain ambiguous in actual chunk order, changed prose no_match.
Real old source/digest and target source/parse/fingerprint/raw block data remain fixed. No old
evidence replacement, claim status upgrade, scientific confirmation or historical backfill.
Readonly project/evidence list marks replaced target versions stale and rejects current source
or parse hash drift and corrupt snapshots.

Regression exposed delayed knowledge queue publication after candidate-write rollback. Old
pre-commit queue placement goes red with externalWrites=['document:rollback-new']; queue now
receives the indexed DTO only after successful transaction. Parse/index/invalidation and
external queue all retain old state on failure. Task-only mutation backup removed; red log retained.

Commands from /Users/Apple_501/Desktop/Roc/Roc:

| Check | Result |
| --- | --- |
| node --test --test-name-pattern='migration persistence failure' tests/unit/research-source-locator.test.mjs | Red on old queue placement; final focused green |
| node --test tests/unit/research-source-locator.test.mjs tests/unit/research-evidence-relations.test.mjs | Final24/24 |
| pnpm test:unit | 864/864 before final current sourceHash guard; final focused/native covers guard |
| pnpm harness:eval | 94/94 |
| pnpm build | Final typecheck/fresh build passed |
| node scripts/run-research-p0.mjs | Final13/13 native |
| node --test --test-concurrency=1 tests/renderer/artifact-inspector.test.mjs tests/renderer/artifact-production.test.mjs tests/renderer/research-search-plan.test.mjs | 27/27 actual Electron |
| node scripts/smoke-electron.mjs | 12/12, zero renderer errors |
| pnpm check:ipc / pnpm check:renderer-chunks / git diff --check | Passed, eager1132980bytes6files |

Initial fullunit860/863 had only three old latest-version assertions expecting21 after all
migrations; updated latest22 while preserving original history/no-invented-observation tests.
New DB21→22 test proves sources/claims/locators unchanged and no backfilled proposals.
Native stale-approval scenario reparses actual frozen PDF, retains old captured parse/new
current target hashes and needs_review candidate data in task fault evidence, with zero list writes.
Frozen research-workflow fixtures remain unchanged.

Trusted user target capture/review, inspector presentation, explicit source replacement and
experiment rerun lineage remain next. PR-06 and the whole plan remain incomplete. Earlier
expanded P4 baseline defect and external scientific/client/L2 acceptance remain unresolved.


## ROC-PR-06A5B1 — trusted user source migration capture and rejection

Verified passing for this backend/IPC increment. DB23 stores one immutable user decision per
DB22 proposal. list/get expose required proposalHash and current target/captured-reference
status separately from saved history. Strict capture/reject requests bind proposal/source/parse
hashes, requestId, nullable note and explicit capture chunkId. Main adapter binds actual
window actor/project/capability; no wire actor, source payload, direct model approval or aliases.
The generic research-human-context replaces the relation-only module and consumers.

Capture validates current actual chunk/parse/block/source and invokes existing evidence.capture
inside the decision transaction. Failure rolls back evidence/locator/decision. Reject creates no
evidence and can bind stale/no_match snapshots. Exact request and actor replay is readonly;
changed note/selection/action/window or repeated different request refuses. New location never
changes original evidence, Claim evidenceIds/status/version, manuscript or scientific review.
Original reviewed supports stay invalidated and current publication remains blocked.

Commands from /Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc:

| Check | Result |
| --- | --- |
| pnpm generate:ipc / pnpm typecheck | Passed; generated adapter/contract current |
| node --test tests/unit/research-source-migration-ipc.test.mjs tests/unit/research-source-locator.test.mjs tests/unit/research-evidence-relation-ipc.test.mjs | Final24/24 |
| pnpm test:unit | 872/872 |
| pnpm harness:eval | 94/94 |
| pnpm build | Fresh production build and typecheck passed |
| node scripts/run-research-p0.mjs | 13/13 native |
| node --test --test-concurrency=1 tests/renderer/artifact-inspector.test.mjs tests/renderer/artifact-production.test.mjs tests/renderer/research-search-plan.test.mjs | 27/27 actual Electron |
| node scripts/smoke-electron.mjs | 12/12, zero renderer errors |
| pnpm check:ipc / pnpm check:renderer-chunks / git diff --check | Passed, eager1132980bytes6files |

Initial focused1 was22/23: forged indexed text reached inner capture INSERT before locator
rollback (total_changes177 versus176). Exact pre-capture index validation fixes cause; original
zero-write assertion retained. Actual decision-insert failure still proves complete rollback.
Genuine DB22→23 migration retains pending snapshot/hash, evidence/locator/claims/revisions/relations
and invents no user decisions. Native stale-approval fault reparses frozen actual PDF and records
explicit synthetic window94 capture/request/target/source, readonly replay, unchanged old claims
and review, and renewed gate refusal. Evidence saved in native fault.json; no frozen fixtures changed.

Candidate inspector remains next, then explicit source replacement/experiment rerun lineage.
PR-06 and full plan remain incomplete. Existing expanded P4 baseline defect and external
scientific/client/L2 acceptance remain unresolved.


## ROC-PR-06A5B2 — source migration candidate inspector

Verified passing for this inspector/contract scope, with the independent broad unit defect
recorded below. Superseded managed sources open lazy candidate details in the single inspector.
Actual original-order matching outcomes/blocks/pages/locators/hashes stay readable; targets
have no default selection. Current artifact recapture precedes capture/reject, stale/no_match
targets refuse capture, pending fields/buttons disable, and saved decisions/history/current
reference invalidation come from the real registry/generated adapter. Identical selection
retries keep requestId; late reads/writes cannot refresh a different artifact or project.
No new scientific support, claim replacement, approval, dependency, global CSS or motion preset.

Screenshot review found a real native disclosure bug: focusing the note made the hidden
::details-content anonymous scroll container hide candidate headings and then the outer source
locator/excerpt. Geometry regressions were written before fixes. Candidate first paragraph
430.37 versus summary658.37 and source first locator191.53 versus summary255.03 were red.
Scoped important overflow:clip utilities on the two disclosures fix the internal scrolling;
original motion is retained. Tests wait for actual body containment, because getAnimations().finished
can report no animations while the native disclosure still has an intermediate block size.
Final first-source/candidate paragraphs remain8px below summaries and all controls fit.

Commands from /Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc:

| Check | Result |
| pnpm build | Final sourceclip fresh typecheck/production build passed |
| node --test tests/unit/research-source-migration-ipc.test.mjs tests/unit/research-source-locator.test.mjs tests/unit/research-evidence-relation-ipc.test.mjs | 24/24 after strict captured/current-status contract |
| node --test --test-name-pattern='migration inspector requires current' tests/renderer/artifact-inspector.test.mjs | Geometry red before fixes; final ready1/1 |
| node --test --test-concurrency=1 tests/renderer/artifact-inspector.test.mjs tests/renderer/artifact-production.test.mjs tests/renderer/research-search-plan.test.mjs | Final3 clean32/32 |
| node scripts/run-research-p0.mjs | 13/13 after final backend schema change; later changes only renderer/geometry |
| pnpm harness:eval | 94/94 |
| node scripts/smoke-electron.mjs | Final3 12/12, zero renderer errors |
| pnpm check:ipc / pnpm check:renderer-chunks / git diff --check | Final3 passed, eager1132980bytes6files |
| pnpm test:unit | 871/872; unchanged review-origin order defect reproduced at clean c520a0e baseline |

Broad unit failure is literature-import1967: getReviews order intermittently flips the two
actual observations relative to origins. Exact single test at clean detached c520a0e baseline
passes twice then reproduces identical failure on third attempt. Evidence in
pr06-a5b2-review-order-baseline.json/logs; task-owned symlink/worktree removed, library
code/assertions unchanged. No claimed fix or blanket full-unit pass.

Initial late-selection test supplied extra title/kind link fields to strict inspect input;
fixed its request to declared fields. One same-SHA recapture test blindly retoggled expanded
state; helper now checks/asserts actual native expansion before keyboard activation.
One old relation/gate test tried approval before inspector closure; it now waits for detached
panel and asserts rendered native focus before the original Enter/approval outcome.
No backend assertions, timeouts or product gate behavior weakened. All DEBUG-a5b2 probes removed.

Evidence under .artifacts/research-optimization/artifact-inspector-ui includes selected-target,
captured-history, light800/dark1099 long-layout screenshots, shadow audits and source/candidate
geometry JSON. Final screenshots inspected: original locator/excerpt retained, complete
targets/note/decisions visible, no anonymous inner scrolling or horizontal overflow, title fixed.

Explicit source replacement and experiment rerun lineage remain next, then PR-07 projection
audit. PR-06 and full plan remain incomplete. Existing expanded P4 baseline defect and
external independent scientific/client/L2 acceptance remain unresolved.


## ROC-PR-06A5C1 — explicit document replacement and completed experiment rerun lineage

Verified passing for the backend/IPC scope. DB24 stores immutable user-selected predecessor
links between two actual project Evidence records. Importing another attachment or running an
experiment with the same label does not infer replacement. Strict requests bind both source
digests, kind, requestId and nullable note; actual main-process window identity supplies actor.
Document replacement requires different managed documents and a current exact parse/chunk.
Experiment rerun requires two real completed managed executions and records full request,
input, environment and output snapshots/hashes. No new execution is scheduled by selection.

Replacement, selected-reference invalidation and relation-review history share a transaction.
Only selected project/evidence invalidates; original Evidence/locator, Claims/status/evidenceIds,
run bytes and saved export seals remain fixed. Failed insert rolls back the complete change.
Exact request/actor replay and reads perform zero writes. New target needs separate scientific
review; scientificReviewAtSelection is a fixed needs_review fact, never current approval.
Current target status is read separately from immutable selection history.

Commands from /Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc:

| Check | Result |
| --- | --- |
| pnpm generate:ipc / pnpm typecheck | Passed |
| node --test tests/unit/research-source-replacement-ipc.test.mjs tests/unit/research-source-locator.test.mjs tests/unit/research-source-migration-ipc.test.mjs tests/unit/research-evidence-relation-ipc.test.mjs | Final32/32 |
| pnpm test:unit | 880/880 |
| pnpm harness:eval | 94/94 |
| pnpm build | Final fresh typecheck/production build passed |
| node scripts/run-research-p0.mjs | 13/13 native |
| node --test --test-concurrency=1 tests/renderer/artifact-inspector.test.mjs tests/renderer/artifact-production.test.mjs tests/renderer/research-search-plan.test.mjs | 32/32 actual Electron |
| node scripts/smoke-electron.mjs | Final12/12, zero renderer errors |
| pnpm check:ipc / pnpm check:renderer-chunks / git diff --check | Final passed; eager1132980bytes6files |

Final message-only correction describes source replacement as well as reparse invalidation,
and states that capture requires renewed scientific review. Focused32/build/startup/IPC/chunks
reran after that wording change; earlier fullunit/native/renderer/Harness results remain relevant.
DB23→24 regression preserves actual migration decisions/source/claim/relation history without
inventing predecessor links. Frozen tests/fixtures/research-workflow files remain unchanged.

Actual native source-replacement-lineage.json under p0-production records synthetic window95
selecting a distinct parsed PDF document/source SHA and window96 selecting completed original
and rerun executions. Actual changed frozen inputs produce A3/B5 versus original A2/B4;
original claims, execution and historical exports remain saved, replayWrites0. Historical sealed
PDF/archive read succeeds while current verify/delivery refuses without creating a destination.

Source replacement inspector and readonly role lineage facts remain next, followed by PR-07.
PR-06 and the full plan remain incomplete. Earlier independent unit review-order defect remains
recorded despite this fullunit pass; expanded P4 and external scientific/client/L2 gaps remain.


## ROC-PR-06A5C2A — readonly role source lineage facts

Verified passing. Existing readonly migration/replacement capabilities now have actual role
tools read_source_migrations/read_source_replacements. Strict schemas accept Evidence ID and
explicit character offset/limit only; project and active stage-run come from the bound service.
Full fixed proposal/decision/replacement/execution snapshots paginate without invented summaries
or science equivalence. Roles receive no human selection/review authority. Cancellation and
terminated run reads refuse. Prompt states location capture and predecessor selection are facts
requiring separate scientific relation review.

Replacement list includes either selected endpoint in original insertion order, allowing the new
source to discover its actual predecessor. Current target status stays separate from selection-time
needs_review and immutable snapshot/hash. Missing/foreign sources and damaged records remain
errors, never empty success fallbacks.

Commands from /Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc:

| Check | Result |
| --- | --- |
| node --test tests/unit/research-source-replacement-ipc.test.mjs tests/unit/research-model-relation-proposals.test.mjs tests/unit/research-source-migration-ipc.test.mjs | Final19/19 |
| pnpm typecheck / pnpm build | Passed; fresh production build |
| pnpm test:unit | 881/881 before final additional migration-tool regression |
| pnpm harness:eval | 94/94 |
| node scripts/run-research-p0.mjs | 13/13 native |
| node scripts/smoke-electron.mjs | 12/12, zero renderer errors |
| pnpm check:ipc / pnpm check:renderer-chunks / git diff --check | Passed; eager1132980bytes6files |

Final added migration-tool regression reads an actual saved ambiguous capture, reparses again,
and checks fixed decision/proposal/hash, stale target, superseded captured source and unchanged
invalidated scientific support with zero read writes. Final19 includes that regression. Existing
rerun test reads complete actual repository execution snapshots through1000-character pages.
No renderer code, dependency, frozen fixture or DB version change. Source replacement inspector
remains next; PR-06/full plan and external/P4 acceptance gaps remain unfinished.


## ROC-PR-06A5C2B — explicit source replacement inspector

Verified passing for renderer/consumer scope. Single inspector sources lazily open replacement
history and actual project Evidence choices. No default target or similarity-based selection.
Fresh two-endpoint inspection binds submitted source digests; document IDs must differ, or two
actual completed experiment executions are shown with full input/environment/output records.
Same-document positions, unmanaged source pairs, stale targets and unfinished runs disable
selection. Stale artifact first requires explicit current recapture; archived project is readonly.
Fixed history identifies predecessor versus new endpoint, selection-time needs_review and
separate current target reference status. Original source/excerpt and snapshot hashes stay readable.

Successful user selection refreshes current artifact and requires renewed version review.
No scientific confirmation, automatic rerun, historical Claim/figure/body rewrite or current gate
approval. Exact selection/note retry preserves requestId. Pending controls disable synchronously;
mounted guards and keyed reads prevent late responses from touching another artifact/project.
Source banner now describes reference invalidation, including replacement/rerun, not only position.

Commands from /Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc:

| Check | Result |
| --- | --- |
| pnpm typecheck / pnpm build | Fresh final product build/type passed |
| node --test --test-concurrency=1 tests/renderer/artifact-inspector.test.mjs tests/renderer/artifact-production.test.mjs tests/renderer/research-search-plan.test.mjs | 38/38 actual Electron |
| node --test --test-name-pattern='replacement inspector\|late replacement\|replacement long' tests/renderer/artifact-inspector.test.mjs | Final6/6 after screenshot containment waits |
| node scripts/smoke-electron.mjs | 12/12, zero renderer errors |
| pnpm check:ipc / pnpm check:renderer-chunks / git diff --check | Passed; eager1132980bytes6files |

Backend unchanged from21195f5a: prior final19/unit881/Harness94/native13 remain relevant; no
blanket new full-unit/native run claimed for this renderer-only increment. Six new renderer flows
cover actual registry/generated adapter user document replacement/review invalidation/history,
unchanged original claims; stale target zero writes/exact retry; completed rerun full snapshots;
late history/pending response isolation; same-document/unmanaged/unfinished refusal; long layouts.

First focused4/5 exposed real pending propagation lag: inner saving status rendered before parent
dropdown disabled. Moved pending update into submit before action.run; original assertion retained,
focused5/5 then full38/38 passed. Screenshot containment check waits for real open disclosure end
bounds before capture; CSS/motion tokens unchanged. Final additional wait changes affect only
verification, final6/6 passed. Screenshots/audits/layout JSON under artifact-inspector-ui show
light800/dark1099 fixed title, readable hashes/focused note/save, no horizontal overflow or hidden
native disclosure headers; cut0. Frozen research-workflow fixtures remain unchanged.

PR-06 source-locator/relation/review/invalidation/history/migration/replacement and readonly
consumer integration is verified offline. PR-07 PDF coordinate-basis audit and implementation
follow next; full plan remains incomplete. Earlier expanded P4/review-order defects and external
scientific/client/L2 acceptance gaps remain recorded.


## ROC-PR-07A1 — measured parse coordinate frames and PDF region projection

Verified passing for parser/shared geometry scope. Actual parser audit found native and OCR
boxes are XYXY raster pixels, not PDF points. Request scale1.5 is clamped for large pages;
CropBox offsets, rotation and UserUnit participate in the PDF.js viewport transform.
New strict PDF frames retain actual raster extent plus viewport dimensions/scale/rotation/
UserUnit/viewBox/six affine values. Native image omission and actual OCR raster rendering share
that measured path. Structured/middle pages save coordinateFrameContractVersion1 and each
processed page frame; image frames use their own raster, HTML explicitly has no region basis.

projectParsedRegionToPdf validates a nonempty in-raster region, reflects bottom-left input
against the recorded raster and inverts the captured affine transform. Missing/invalid basis,
singular/nonfinite matrices and outside/empty regions refuse. No fixed-scale guess, source
migration, scientific approval, DB rewrite or historical SourceLocator/parse-content mutation.
Text/location contract4 and frozen research-workflow fixture files stay unchanged.

Commands from /Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc:

| Check | Result |
| --- | --- |
| node --test --test-name-pattern='high-quality text-only pages preserve' tests/unit/architecture-repair-corpus.test.mjs | Red before fix: required frame undefined |
| node --test --test-name-pattern='actual rotated cropped\|high-quality text-only\|OCR raster bytes\|native-text PDF with vector' tests/unit/architecture-repair-corpus.test.mjs | Final4/4 |
| pnpm test:unit | 883/883 |
| pnpm typecheck / pnpm build | Fresh production build/type passed |
| node scripts/run-research-p0.mjs | 13/13 native |
| node --test --test-concurrency=1 tests/renderer/artifact-inspector.test.mjs tests/renderer/artifact-production.test.mjs tests/renderer/research-search-plan.test.mjs | Final38/38 |
| node scripts/smoke-electron.mjs | Final12/12, zero renderer errors |
| pnpm harness:eval | 94/94 |
| pnpm check:ipc / pnpm check:renderer-chunks / git diff --check | Passed; eager1132980bytes6files |

Generated actual PDFs cover crop[20,30,500,700]/rotation90/UserUnit2, rotation270 and a
12000x15000 clamped page. Captured frames/projected rectangles independently match actual
PageViewport.convertToPdfPoint with less than1e-9 error. Large page records scale
0.37267799624996495, raster4472x5590. Frame/error/rounding facts retained in
pr07-coordinates/actual-parser-frames.json; no source fixture files modified.

Initial related renderer37/38 exposed existing test ordering after returning whole gate context:
acceptContext schedules actual refresh-button focus in requestAnimationFrame; old relation test
focused approval before that restoration. Existing whole-context test already waits actual refresh
focus. Added the same wait at relation test283, retaining active-focus/Enter/final approval assertions
and product code/timeouts. Final38 passes; earlier independent P4/review-order defects unchanged.

Safe coordinate snapshot/hash publication, renderer preview metadata/dual reader, annotations
and large-PDF resource acceptance remain next PR-07 increments. Full plan remains incomplete;
external scientific/client/L2 acceptance still unrun.


## ROC-PR-07A2A — atomic coordinate snapshot and artifact seals

Verified passing. Research DB25 adds separate measured-coordinate snapshots plus a parse-level
coordinate_snapshot_hash marker. Original parse JSON/content, SourceLocator/Evidence and user
predecessor snapshots remain unchanged. Historical rows get null marker and no fabricated frames.
New snapshot binds canonical parse/source SHA, actual structured artifact path/hash/size and
processed-page frames. Missing/deleted captured row is an explicit error; malformed/moved/changed
snapshot or parse/source/page/region binding refuses with zero read writes.

collectDocumentContent returns explicit data and nullable coordinate capture; complete requires
that fourth input. All six synthetic direct callers pass null explicitly, with no old-signature alias.
Current marked artifacts must match actual parser blocks/content/fingerprint and provide valid
frames; markerless historical artifacts have no captured region basis. Persisted schema normalizes
content before SHA. Parse publication, frame row/marker, index replacement and prior-source
invalidation share one transaction, with queue publication only after success.

Commands from /Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc:

| Check | Result |
| --- | --- |
| node --test tests/unit/research-document-coordinates.test.mjs | Initial actual publication red: coordinate binding changed; normalized schema hash fixes cause |
| node --test tests/unit/research-document-coordinates.test.mjs tests/unit/research-source-locator.test.mjs tests/unit/research-source-migration-ipc.test.mjs tests/unit/research-source-replacement-ipc.test.mjs tests/unit/architecture-repair-corpus.test.mjs | Final49/49 |
| pnpm test:unit | Final888/888 |
| pnpm typecheck / pnpm build | Final fresh production build/type passed |
| node scripts/run-research-p0.mjs | Final13/13 native |
| node --test --test-concurrency=1 tests/renderer/artifact-inspector.test.mjs tests/renderer/artifact-production.test.mjs tests/renderer/research-search-plan.test.mjs | Final38/38 |
| node scripts/smoke-electron.mjs | Final12/12, zero renderer errors |
| pnpm harness:eval | Final94/94 |
| pnpm check:ipc / pnpm check:renderer-chunks / git diff --check | Passed; eager1132980bytes6files |

Five new actual parser/repository tests cover canonical source/parse/file seal publication, insertion
rollback retaining old source/index/frame, malformed binding and tampered/deleted snapshot errors,
marked artifact mutation/refusal/restoration, and DB24→25 retaining actual old parse and explicitly
selected replacement snapshots without frame backfill. Migration test uses readonly frozen PDF
plus task-owned appended-comment successor. Old parse JSON bytes remain unchanged; added
metadata column is null. No frozen research-workflow fixture files changed.

Initial expanded47/48 had test-only restore setup discarding the real page-image asset; changed
that setup to use the retained actual parser DTO, preserving full equality assertion. Production
canonical-hash red was separately reproduced and corrected before green. Final checks above ran
after required missing-snapshot marker/native assertions; subsequent edits only renamed latest
migration tests and removed one unused test import, with no behavior/assertion change.

Actual native document-coordinate-snapshot.json inspected under p0-production: sourceSHA
matches captured Evidence, parseSHA matches exact content, saved structured file2092bytes/hash
and frame918x1188 match actual PDF. Reads perform no writes. Safe preview metadata and file-byte
validation at the service/protocol boundary remain next; PR-07 and full plan still incomplete.
Earlier independent P4/review-order and external scientific/client/L2 gaps remain unchanged.

## ROC-PR-07A2B — project-scoped preview metadata and byte boundary

Verified passing. Added research.previewDocument through the generated renderer/preload registry.
Requests bind projectId/documentId/parseId/sourceHash and explicit nullable caller-known parseHash.
Responses return verified parse/source hashes, actual page count, original/PNG protocol URLs,
asset metadata and measured frame/snapshotHash without absolute filesystem paths or write authority.
Known Evidence/Claim locators can request their fixed parseHash; first ordinary reading explicitly
passes null to obtain the actual hash. No latest-parse substitution occurs in this boundary.

Original and asset byte requests now require project scope, checked against library membership
before filesystem reads and after async IO. Actual file hashes/sizes, immutable parse content and
coordinate artifact seal are checked; missing/tampered/symlink/foreign reads fail. Historical parses
retain fixed measured snapshots, uncaptured history is explicit null, and marked missing/corrupt
snapshots cannot become a successful page-only fallback. Deleted old unscoped document URL routes.
No compatibility aliases, dependency additions or source fixture changes.

Actual Chromium fetch was red because roc-preview had supportFetchAPI but lacked corsEnabled.
The exact console repro reported a scheme absent from the CORS-supported protocol list. Enabling
corsEnabled alone made the same frozen-PDF bytes/hash check pass. No webSecurity/CSP bypass or
wildcard origin header added; every protocol capability failure remains a failed response.

Commands from /Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc:

| Check | Result |
| --- | --- |
| pnpm generate:ipc / pnpm typecheck | Generated bridge and type checks passed |
| node --test tests/unit/research-document-coordinates.test.mjs tests/unit/zotero-import.test.mjs | 49/49 |
| node --test tests/renderer/document-preview-protocol.test.mjs | Initial0/3 red; clean final3/3 |
| pnpm test:unit | 893/893 |
| pnpm harness:eval | 94/94 |
| pnpm build | Fresh production build passed |
| node scripts/run-research-p0.mjs | Native13/13 |
| node --test --test-concurrency=1 tests/renderer/artifact-inspector.test.mjs | 25/25 |
| node --test tests/renderer/artifact-production.test.mjs | 8/8 |
| node scripts/smoke-electron.mjs | 12/12, zero renderer errors |
| pnpm check:ipc / pnpm check:renderer-chunks / git diff --check | Passed; eager1132980bytes6files |

Five additional actual parser/repository/adapter tests cover exact source/parse/frame identity,
original and PNG bytes, foreign scope, malformed request/path authority, version drift, missing or
modified source/artifact/snapshot, historical preservation/no invented geometry and async unlink.
The native P0 saves document-preview.json from actual registry/adapter/source/asset operations
with explicitly synthetic sender97. Separate actual Electron/Chromium protocol tests inject the
PDF capability response and verify the encoded route/hash/404 contract; they do not claim an
actual user or end-to-end production main-kernel transport. Artifacts/logs retained under
.artifacts/research-optimization/pr07-a2b-* and pr07-preview-protocol/.

Renderer-check command initially named a nonexistent second file; Node ran only the real inspector
file. The separate actual artifact-production8 check above completes the intended relevant scope.
After broad checks, preview pageCount was aligned to the existing nonnegative document-content
contract; final focused/type/build and static checks recorded before commit.
Next: actual reader fixed parse/source selection, lazy PDF/structured view, bidirectional location,
annotation capture and large-PDF memory acceptance. Full plan and external acceptance remain open.

## ROC-PR-07A3A — explicit reader parse and project/source identity

Verified passing. Ordinary reader requests the selected document's currentParseId. Historical
requests resolve parse→document through a project-scoped main capability, verify current library
membership, then read that exact parse. Versioned content requests require projectId/documentId/
parseId/sourceHash/nullable caller-known parseHash; the old unscoped content request is removed.
The preview and content boundaries share exact identity validation. No replacement-parse or
substring locator fallback remains, and duplicate exact locators stay unmatched.

The old exported latest helper chose at(-1) from newest-first runs. Executed its actual body from
4528c6f3: expected current, actual old. Red assertion and exact request/result retained under
pr07-a3a-legacy-repro.log/json. Removed helper and unused renderer runs wrapper, without aliases.
A request-keyed React hook suppresses stale content on project/library/document/parse/hash change
and late responses after cleanup. Explicit retry rereads the same selection, never reparses it.
Document tabs support native arrows/Home/End; choosing a document clears historical focus.
Removed obsolete parse-tier descriptions and middle-dot metadata separators in the touched reader.

Commands from /Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc:

| Check | Result |
| --- | --- |
| pnpm generate:ipc / pnpm typecheck | Passed |
| node --test tests/unit/research-document-coordinates.test.mjs tests/unit/zotero-import.test.mjs | Final50/50 |
| pnpm test:unit | 894/894 |
| pnpm harness:eval | 94/94 |
| pnpm build | Final fresh production build passed |
| node scripts/run-research-p0.mjs | Native13/13 with actual resolver/content/preview seam |
| node --test tests/renderer/paper-reader.test.mjs | Final clean7/7 |
| node --test --test-concurrency=1 tests/renderer/artifact-inspector.test.mjs tests/renderer/artifact-production.test.mjs tests/renderer/research-search-plan.test.mjs tests/renderer/literature-review.test.mjs tests/renderer/document-preview-protocol.test.mjs | 44/44 |
| node scripts/smoke-electron.mjs | Final12/12, zero renderer errors |
| pnpm check:ipc / pnpm check:renderer-chunks / git diff --check | Passed; eager1131738bytes6files |

Actual reader tests exercise current vs historical data, missing/foreign/superseded failure,
ambiguous/prefix locators, native tab keys, late responses, incorrect returned identities, explicit
retry and light1100/dark1099/light800 layouts with reduced motion. Source snapshots/window98 and
Node-host bridge are explicitly synthetic. Real frozen PDF resolver/content consumption is asserted
through native P0's generated adapter/registry; full PDF viewer is a later increment.

Initial reader5/7 used wrong test role for ErrorBar (blocked renders note, not alert). Corrected
selectors without changing semantic assertions/timeouts; final clean7 passes. Task-only native
shadow audit returned cut0/hidden0 for five default/hover/large-text states; saved clip-audit.json,
then restored clean test and removed backup. Dark1099 screenshot inspected. After full checks,
removed unused wrapper/duplicate error handling and corrected error-state keyboard tab entry;
focused50/build/type/cleanreader7/startup12/IPC/chunks rerun passed. Final diff caught one blank
EOF after deleting helper; trimmed it and diff now passes. No product debugging or fixture edits.

Next: lazy original PDF/structured reader, measured region projection, evidence/claim source links,
annotation capture and large-PDF resource records. Full PR-07/roadmap and external scientific,
actual-client, independent reviewed200 corpus and model-spending acceptance remain unfinished.

## ROC-PR-07A3B — lazy original PDF and structured comparison

Verified passing. Existing reader now opens the exact original PDF beside its selected parsed
content. Original/worker/PDF.js load only on comparison or block-source selection; pdfjs-dist is
forbidden from the eager graph. Uses generated project/document/parse/source/content-hash preview
request, protocol original bytes, one native PDFWorker and one visible page canvas. Block locations
project through the sealed frame and actual PDF.js viewport, including crop/rotation/UserUnit.
Missing frame is explicitly page-only; whole-page parser bounds are labelled whole-page, not a
precise paragraph. Multiple locations, native page keys, page input and0.5–3x fit-width zoom added.
Render/page/document/worker/fetch resources release on changes and close; bitmap<=4M pixels.

A development-origin test exposed actual foreign HTTP fetch200 rather than refusal. Electron45
custom protocol requests omit Origin headers, but expose native page-independent initiatorOrigin.
The handler now refuses foreign/opaque initiators before capability invocation, allows file renderer,
configured dev renderer and native/browser requests, and grants CORS only to configured dev origin.
No header/referrer fallback, wildcard origin, webSecurity/CSP bypass or unscoped URL alias.

Commands from /Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc:

| Check | Result |
| --- | --- |
| pnpm build (includes typecheck) | Final2 fresh production build passed |
| node --test tests/renderer/paper-reader.test.mjs | Final clean12/12 using actual Vite8.3.5 worker build |
| node --test tests/renderer/document-preview-protocol.test.mjs |5/5; file/dev/foreign-no-referrer/opaque/native bytes |
| pnpm test:unit |894/894 |
| pnpm harness:eval |94/94 |
| node scripts/run-research-p0.mjs |13/13 |
| node --test --test-concurrency=1 tests/renderer/artifact-inspector.test.mjs tests/renderer/artifact-production.test.mjs tests/renderer/research-search-plan.test.mjs tests/renderer/literature-review.test.mjs tests/renderer/document-preview-protocol.test.mjs |46/46 |
| node scripts/smoke-electron.mjs | Final2 12/12, zero renderer errors |
| pnpm check:ipc / pnpm check:renderer-chunks / git diff --check | Passed; eager1131738bytes6files |

PDF tests use actual frozen original or explicitly generated rotated/32-page originals, actual
parser/collector/repository/registry/generated adapter and Chromium protocol/real compiled worker.
Node-host registry transport and sender98 are explicitly synthetic; not full production kernel/
preload user E2E. No Vite worker import shim remains. Large original has32 pages with only page1
parsed; actual page2/8/16/24/32/1 bitmaps each735150pixels,67–77ms,one canvas/worker; close removes
all DOM canvases/workers. Process memory records are observations, not a hard RSS limit.

Initial resource sampling captured zero/default bitmaps during redraw. Native mutation investigation
showed inline hidden state while immediate computed-style observations still reported visible.
The attempted canvas-identity product change did not establish a cause and was removed. Final
readiness/sample requires actual published visibility plus nonzero bitmap; retained observer records
no published default canvas. No product diagnostics or speculative lifecycle patch remains.
Seven compare/hover/zoom clip states cut0/hidden0; dark1099 screenshot inspected. Evidence retained
under pr07-reader-selection/ and pr07-a3b-*; initial API/type/regex errors are in the local ledger.

Next: reverse PDF→block location, fixed Evidence/Claim source deep links, research annotations,
parsed table/formula assets and remaining PR07 acceptance. Full roadmap/external acceptance open.

## ROC-PR-07A3C — original PDF to exact parsed block/location

Verified passing. PDF pointer hits use every block region on the actual selected page projected
through its sealed frame/current PDF viewport. A unique hit selects exact block/location; overlapping
regions require explicit choice and zero hits never select a nearby block. Page-only histories show
actual page-block choices without a spatial guess. Native keyboard page-block list retains selected
cross-page location index; destination focus goes to the content group and scrolls it into view.
Selected block has visible background/focus. Same-page candidates remain present but disabled while
repainting; stable scrollbar gutter prevents loading/candidate heights changing the PDF width.
No evidence, annotation, scientific-review or other database writes introduced.

Commands from /Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc:

| Check | Result |
| --- | --- |
| pnpm build (includes typecheck) | Final2 fresh production build passed |
| node --test --test-concurrency=1 tests/renderer/paper-reader.test.mjs tests/renderer/artifact-inspector.test.mjs tests/renderer/artifact-production.test.mjs tests/renderer/research-search-plan.test.mjs tests/renderer/literature-review.test.mjs tests/renderer/document-preview-protocol.test.mjs |61/61 |
| node --test --test-name-pattern='rotated PDF hit\|cross-page location\|without measured regions' tests/renderer/paper-reader.test.mjs | Focused audit3/3 |
| node --test tests/renderer/paper-reader.test.mjs | Final2 15/15 after gutter/candidate repaint changes |
| node scripts/smoke-electron.mjs | Final2 12/12, zero renderer errors |
| pnpm check:ipc / pnpm check:renderer-chunks / git diff --check | Passed; eager1131738bytes6files |

UI-only increment: backend unit894/Harness94/native13 from preceding A3B remain applicable to
unchanged backend paths; not rerun or presented as fresh results here. Actual Electron/Vite tests
cover measured crop90/UserUnit2 unique/overlap/no-hit regions, original2-page cross-page index1 and
keyboard focus, and absent coordinate history. Layout blocks are explicitly synthetic on actual
PDF bytes/viewports, published in separately hashed synthetic-reverse artifacts; this validates
interaction geometry, not parser quality. Tests assert zero DB writes and worker teardown.
Five overlap/hover/light/dark/destination-focus clip states cut0/hidden0. Overlap800light screenshot
inspected; final screenshots and audit stored in pr07-reader-selection/reverse-*.

Next: Evidence/Claim fixed parse/source links, annotations/capture, table/formula assets and full
PR07 resource/scanned-source acceptance. Remaining roadmap and external acceptance unfinished.

## ROC-PR-07A4A — captured Evidence original-source reading

Verified passing. Existing artifact Evidence disclosure opens its captured document/parse/source/
parseHash, checks normalized returned hash/parser/unique block/excerpt/locator/full location array,
then uses the shared lazy original-PDF view. A newer parse never replaces the captured version.
Superseded reference state and old excerpt remain visible; readonly context navigation/cross-page
selection never restores scientific approval or writes Evidence/Claim records. No second shell,
route, frontend or unscoped source URL. Non-PDF logical sources use saved block text and do not
load the PDF engine. Browser content hash helper is shared by both actual document consumers.

Commands from /Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc:

| Check | Result |
| --- | --- |
| pnpm build (includes typecheck) | Final fresh production build passed |
| node --test --test-concurrency=1 tests/renderer/paper-reader.test.mjs tests/renderer/artifact-inspector.test.mjs tests/renderer/artifact-production.test.mjs tests/renderer/research-search-plan.test.mjs tests/renderer/literature-review.test.mjs tests/renderer/document-preview-protocol.test.mjs |65/65; reader19, inspector25, production8 plus related13 |
| node --test --test-name-pattern='captured Evidence\|fixed-source\|late fixed-source' tests/renderer/paper-reader.test.mjs | Initial3/3, then actual ModalShell3/3 |
| node scripts/smoke-electron.mjs | Final12/12, zero renderer errors |
| pnpm check:ipc / pnpm check:renderer-chunks / git diff --check | Passed; eager1131738bytes6files |

UI-only change: preceding backend unit894/Harness94/native13 still apply to unchanged backend
contracts, and are not reported as new runs. Final source coverage uses actual parser/captured
Evidence and real reparse invalidation, exact original request/hash/bytes, eight wrong project/doc/
source/parse/parser/block/text/region refusals, different-project/original late-result suppression,
and explicit synthetic crosspage source location1/page2 with group focus. Reads assert zero writes.
Original/crosspage tests use actual Vite/Chromium/protocol and shared560px ModalShell; Node-host
registry/window98 transport is explicitly synthetic, not full production kernel/preload user E2E.

Inspector, production and reader fixtures now share Vite compilation so nested lazy PDF/worker
imports run through actual emitted assets rather than esbuild worker emulation. Owned build input
folders are removed after build; fixture outputs/original copies cleaned by existing teardown.
Dark1099 source screenshot inspected; source/hash/invalidation/page controls remain visible with
bounded native scrolling. Three drawer hover/theme/width clip states cut0/hidden0 and no horizontal
overflow. Artifacts: pr07-reader-selection/evidence-fixed-original.json, evidence-original-*.png,
evidence-original-clip-audit.json and pr07-a4a-* logs. Final change after checks only JSX indentation
and documentation; no semantic source change or fixture alteration.

Next: direct original-source entry from Claim relation records, research annotations/capture,
parsed table/formula asset comparison and remaining full PR07 acceptance. Roadmap still open.

## ROC-PR-07A4B — Claim relation captured original-source entry

Verified passing. Claim relation's fixed-source disclosure now opens the shared lazy source reader
from its immutable relation.source, including after reparse invalidates the relation. Does not
substitute another current Evidence, change the Claim, restore a relation/review or write DB data.

Commands from /Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc:

| Check | Result |
| --- | --- |
| pnpm build (includes typecheck) | Final fresh production build passed |
| node --test --test-concurrency=1 tests/renderer/paper-reader.test.mjs tests/renderer/artifact-inspector.test.mjs tests/renderer/artifact-production.test.mjs tests/renderer/research-search-plan.test.mjs tests/renderer/literature-review.test.mjs tests/renderer/document-preview-protocol.test.mjs |66/66; reader20 |
| node scripts/smoke-electron.mjs |12/12, zero renderer errors |
| pnpm check:ipc / pnpm check:renderer-chunks / git diff --check | Passed; eager1131738bytes6files |

Actual parser→Evidence→explicit synthetic hypothesis/user98 relation→reparse→invalidated relation
fixture retains original source/hash/text, uses generated readonly document bridge and actual
Vite/Chromium/protocol in shared560px ModalShell/ArtifactRelations, checks zero DB writes and
unchanged full Claim/relation records. Node-host/window98 remains an explicit test seam. Native
nested summary/metadata geometry and destination group focus pass. Light/dark body clip audits
cut0/hidden0; dark source/context screenshot inspected. Artifacts: claim-fixed-original.json and
claim-original-*.png under pr07-reader-selection/. First focused test entered a hidden nested
summary before outer details painted; explicit open/visible-state assertions fixed test timing
without changing timeout or introducing speculative product CSS. Backend unchanged: prior
unit894/Harness94/native13 remain prior evidence, not new runs.

Next: PDF selection annotations and capture, parsed table/formula image comparison and remaining
PR07 scanned/large-source acceptance. Full execution plan and external acceptances remain open.


## ROC-PR-07A5A — annotation target contract and measured geometry

Verified passing. Strict source/parse/parser/page/block identity and nullable sealed measured PDF basis; explicit page-only or nonempty PDF-user-space XYXY region bounded by captured CropBox. Six note/problem kinds and required note; no wire actor or scientific confirmation. Added measured PDF→raster projection. Storage/capture/selection UI remain next.

Commands from /Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc:

| Check | Result |
| --- | --- |
| pnpm typecheck / pnpm build | Passed; fresh production build |
| node --test --test-name-pattern='actual rotated cropped UserUnit' tests/unit/architecture-repair-corpus.test.mjs | 1/1 actual PDF parser/PDF.js scenario; crop90/270/UserUnit2/large clamp, full crop and roundtrip, invalid requests |
| pnpm test:unit | 894/894 |
| pnpm check:ipc / pnpm check:renderer-chunks / git diff --check | Passed; eager1131738bytes6files |

No renderer behavior changed; preceding UI/native acceptances are prior evidence, not new runs. Logs pr07-a5a-* and actual-parser-frames.json retain the actual basis, targets and projections. No historical sources/backfill/compatibility aliases. Next: trusted human annotation storage/read and current-block Evidence conversion, then actual selection UI. Full PR07 and roadmap remain open.


## ROC-PR-07A5B — trusted human annotations and exact current-block Evidence conversion

Verified passing. DB26 immutable user annotation/request/block/basis seals and separate Evidence conversion receipts. Four generated preload methods extend the existing document capability registry and main-only human context. Actual preview bytes/coordinate artifact checked before synchronous write binding; old notes readable after reparse, new conversion requires actual current indexed block. Evidence/SourceLocator and receipt commit atomically; no scientific writes. Region belongs to the linked user note; Evidence retains parser location rather than claiming the user region was parsed.

Commands from /Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc:

| Check | Result |
| pnpm generate:ipc / pnpm typecheck / pnpm build | Passed; generated contracts and fresh build |
| node --test tests/unit/research-document-annotations.test.mjs tests/unit/research-document-coordinates.test.mjs tests/unit/research-source-locator.test.mjs | Final34/34, new actual annotation9 |
| pnpm test:unit / pnpm harness:eval | 903/903 and94/94 |
| node scripts/run-research-p0.mjs | 13/13 native; actual annotated PDF/current Evidence reuse, synthetic window99 |
| node --test --test-concurrency=1 tests/renderer/paper-reader.test.mjs tests/renderer/artifact-inspector.test.mjs tests/renderer/artifact-production.test.mjs tests/renderer/research-search-plan.test.mjs tests/renderer/literature-review.test.mjs tests/renderer/document-preview-protocol.test.mjs | 66/66 |
| node scripts/smoke-electron.mjs | 12/12; zero renderer errors |
| pnpm check:ipc / pnpm check:renderer-chunks / git diff --check | Passed; eager1131738bytes6files |

Initial capture tests correctly rejected extra write fields passed into strict get schemas; explicit get arguments fixed all three calls, without weakening schemas/assertions. Logs pr07-a5b-* and p0-production/research_task_fef4c59e-4ed3-4314-b16d-ff237f74bc06/document-annotation.json retain results. Native transport/window99 remains a test seam. Current-index refusal, old version reads, strict actor/project checks, captured invalidation, snapshot tampering and actual DB25→26 no-backfill preservation verified. No UI save/selection entry yet. Next: actual PDF region selection, keyboard page/block note workflow, list/capture UI, then assets and remaining PR07 acceptance. Full roadmap/external acceptances remain open.


## ROC-PR-07A5C — actual PDF selection and annotation UI

Verified passing. Existing lazy PDF view adds measured pointer region selection, explicit keyboard page note, optional user-selected page block, problem/note form, sealed note history and exact current-block Evidence action. Source/parse/page/paint/request keys isolate drafts and late results; failed unchanged requests reuse IDs. Missing measured frame disables region selection and offers explicit page note. Empty selection refused. Original Evidence/Claim view reads notes without write entry. No scientific mutation/confirmation, second shell/route or eager PDF dependency.

Commands from /Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc:

| Check | Result |
| pnpm typecheck / pnpm build | Final passed; fresh production build |
| node --test --test-name-pattern='annotation\|pointer selection\|page-only annotation' tests/renderer/paper-reader.test.mjs | 6/6 |
| node --test --test-concurrency=1 tests/renderer/paper-reader.test.mjs tests/renderer/artifact-inspector.test.mjs tests/renderer/artifact-production.test.mjs tests/renderer/research-search-plan.test.mjs tests/renderer/literature-review.test.mjs tests/renderer/document-preview-protocol.test.mjs |72/72; reader26 |
| node --test --test-name-pattern='annotation form and long' tests/renderer/paper-reader.test.mjs | Final layout1/1, default/hover/open/final audits |
| node scripts/smoke-electron.mjs |12/12; zero renderer errors |
| pnpm check:ipc / pnpm check:renderer-chunks / git diff --check | Passed; eager1131770bytes6files |

Actual rotated90/cropped/UserUnit2 pointer event observations independently compared with native PDF.js convertToPdfPoint within1e-8 and saved/reopened dashed region geometry checked. Actual current Evidence reuse/source/index refusal, original request retries, late acknowledgment/new project and old invalidated notes tested through Node-host/window98 seam, not full production kernel/preload E2E. No backend changes: preceding unit903/Harness94/native13 are previous evidence, not reruns. Logs pr07-a5c-*; annotation-actual-rotated.json, four cut0/hidden0 audits and form/saved-details/original-page screenshots inspected. Saved screenshot now explicitly scrolls actual row into view; no claim that the original-page screenshot covered offscreen notes. Next: actual parsed table/formula assets and quality/scan/large acceptance; PR07 and full roadmap still open.


## ROC-PR-07A6A — fixed parsed assets and grounded quality facts

Verified passing. Lazy table/formula PNG comparison next to unchanged raw text, one open PNG, fixed Evidence/Claim source reuse. Exact preview source/parse/hash and captured asset metadata/URL checked; bytes validated by existing main asset capability. Missing asset and corrupt source/image surface explicit facts/errors without substitutes. OCR mode, saved parser warnings and empty-block facts shown; no invented calibrated scores/percentages or HTML/LaTeX execution.

Commands from /Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc:

| Check | Result |
| pnpm typecheck / pnpm build | Final passed; fresh production build |
| node --test --test-name-pattern='parsed table formula\|parsed asset corruption\|historical parsed asset\|asset text comparison' tests/renderer/paper-reader.test.mjs | Final4/4 |
| node --test --test-concurrency=1 tests/renderer/paper-reader.test.mjs tests/renderer/artifact-inspector.test.mjs tests/renderer/artifact-production.test.mjs tests/renderer/research-search-plan.test.mjs tests/renderer/literature-review.test.mjs tests/renderer/document-preview-protocol.test.mjs |76/76; reader30 |
| node --test --test-name-pattern='historical parsed asset' tests/renderer/paper-reader.test.mjs | Final1/1 after post-decode/figure visibility strengthening |
| node scripts/smoke-electron.mjs |12/12; zero renderer errors |
| pnpm check:ipc / pnpm check:renderer-chunks / git diff --check |Passed; eager1131770bytes6files |

The four asset scenarios use explicit synthetic recognition layout and real native parser page pixels/PNG bytes/Vite/Chromium/generated registry/adapter through Node-host/window98 seam. They do not establish actual scanned/complex scientific table/formula OCR accuracy. Nonzero displayed image ink measured from actual compositor screenshot: first browser canvas readback correctly raised cross-origin taint, and policy remained unchanged. Actual native-only warning tested in genuine parser state separately from synthetic mixed mode. PNG/source corruption refuses with raw text retained; restored retry works; fixed historical/captured Evidence images and late project isolation verified. Light800/dark1099 original/raw formula/PNG and560px fixed source screenshots inspected; four comparison and source audits cut0/hidden0. Source screenshot waits decoded natural geometry/figure visibility; an ambiguous test patch insertion was detected by scoped read and corrected before executing. Logs pr07-a6a-* and assets-fixed-pixels.json/asset-compositor-table.png/asset-* artifacts retained. Backend unchanged: previous unit903/Harness94/native13 are prior evidence. Next: actual scanned-source and larger-resource PR07 acceptance, then PR09. Roadmap/external acceptances remain open.


## ROC-PR-07A6B — actual scanned-source acceptance and asset-entry correction

Verified passing. Actual complete CPU sandbox OCR of controlled raster-only3page source, retained merged-header table/formula images and raw text, strict original/version/coordinates/indexed Evidence. Reader and captured-source asset entries now follow actual imageAssetId, keeping figure classification. No model threshold change, interpretation or calibrated accuracy claim.

Commands from /Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc:

| Check | Result |
| node scripts/verify-research-pdf-scanned.mjs --models-root .artifacts/research-optimization/pr07-scanned/models --evidence-root .artifacts/research-optimization/pr07-scanned/acceptance-final |1/1; actual complete CPU OCR4.37s,10blocks/13images/2formulas/0tables |
| ROC_SCAN_MODELS_ROOT="$PWD/.artifacts/research-optimization/pr07-scanned/models" ROC_SCAN_EVIDENCE_ROOT="$PWD/.artifacts/research-optimization/pr07-scanned/acceptance-final" node --test tests/acceptance/research-pdf-scanned-reader.test.mjs |3/3; actual recognized table/incorrect formula/captured Evidence assets |
| pnpm build |Passed; includes typecheck |
| node --test --test-concurrency=1 tests/renderer/paper-reader.test.mjs tests/renderer/artifact-inspector.test.mjs tests/renderer/artifact-production.test.mjs tests/renderer/research-search-plan.test.mjs tests/renderer/literature-review.test.mjs tests/renderer/document-preview-protocol.test.mjs |76/76; includes32page bounded bitmap/worker lifecycle and crosspage selection |
| node scripts/smoke-electron.mjs |12/12; zero renderer errors |
| pnpm check:ipc / pnpm check:renderer-chunks / git diff --check |Passed; eager1131770bytes6files |

Red test retained missing figure asset entry. Initial sandbox EPERM from output outside jobDir fixed in fixture only. Expanded Evidence test initially queried nonexistent block_id; corrected to actual unique indexed content/locator after DB schema inspection. Actual native pipeline uses synthetic window100; Vite/Chromium/protocol/registry/generated adapter uses Node-host/window101. Recognition-observations retains two missed body lines, figure table classification and malformed formula output. Source/raw/PNG remains verifiable; science/OCR quality is not declared passing.800light/1099dark and fixed560px screenshots retained and reviewed, hover cut0/hidden0. Logs pr07-a6b-*; final native/reader evidence at pr07-scanned/acceptance-final.

PR07 local engineering scope is complete: safe metadata/URLs, lazy original PDF, measured bidirectional/page/crosspage positioning, fixed Evidence/Claim versions, trusted human note/Evidence conversion, raw images/quality facts, scan and bounded32page resource checks. Prior backend unit903/Harness94/native13 are earlier evidence, not rerun for this UI-only change. Next PR09 systematic-review workflow; external scientific retrieval/Zotero client/200-task corpus/live spending and later roadmap remain open.


## ROC-PR-07A6B follow-up — preserve the frozen fixture corpus

Verified passing. Full unit run during PR09 detected that the new scan generator was placed inside the manifest-locked workflow corpus. Move it to tests/fixtures/research-scanned-source.mjs, retain frozen manifest and source bytes, update native import/documentation. No relaxed corpus assertion.

Commands from /Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc: node --test tests/unit/research-workflow-fixture.test.mjs passed2/2; node scripts/verify-research-pdf-scanned.mjs --models-root .artifacts/research-optimization/pr07-scanned/models --evidence-root .artifacts/research-optimization/pr07-scanned/acceptance-corpus-layout passed1/1, actual OCR3.81s with10blocks/13images/2formulas/0tables. Logs pr07-a6b-corpus-layout*. Source/raw/image contract unchanged. PR09 DB27 migration test expectations handled in the separate PR09 commit.


## ROC-PR-09A1 — immutable protocol versions and frozen human receipts

Verified passing. Strict explicit systematic-review protocol content, append-only revisions with current-parent/hash/deviation, immutable snapshot/request identity and separate atomic confirmation receipt/marker. Archived history reads remain available; missing marked receipt, corrupt bytes, stale revision or request/actor drift refuse. No historical protocol/decision backfill, scientific mutation or compatibility aliases.

Commands from /Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc:

| Check | Result |
| node --test tests/unit/research-systematic-review.test.mjs |Final9/9; actual SQLite disk reopen/DB26→27 and marker transaction rollback |
| pnpm test:unit |Final912/912 |
| pnpm harness:eval |94/94 |
| pnpm build |Final passed; fresh build/typecheck |
| node scripts/run-research-p0.mjs |13/13; real native workflows retain boundaries |
| node scripts/smoke-electron.mjs |12/12; zero renderer errors |
| pnpm check:ipc / pnpm check:renderer-chunks / git diff --check |Passed; eager1131770bytes6files |

First full unit found three older literature migration tests with expected latest26 rather than new27; corrected expectations while keeping all source preservation assertions. Separate PR07 fixture placement correction570187f restored frozen corpus. Final diff review removed non-null assertion chains and scoped historical version rows before returning them; focused9 and fresh build rerun, full912 uses final source. Protocol repository actors are explicit test users; public generated IPC human binding, actual search lineage, screening/extraction and UI still next. Full PR09 and later roadmap remain open.


## PR09 prerequisite — source observation ordering regression

Verified passing. Full A2 unit run exposed an existing timestamp assumption in the review-provenance test: getReviews orders observations by newest retrieval time, while fusion orders origins by source priority. Make the fixture produce distinct timestamps with an asynchronous10ms OpenAlex delay, then compare exact source/rank/retrievedAt/review values in declared observation order. All copy/license/update/retraction, paging, cache and execution provenance checks remain. No product ordering change or weakened corpus/security assertion.

From /Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc: node --test --test-name-pattern='candidate review retains' tests/unit/literature-import.test.mjs passed1/1; pnpm test:unit final916/916 passed. Initial915/916 evidence retained in pr09-a2-unit-full.log; final pr09-review-order.log/pr09-a2-unit-full-final.log.


## ROC-PR-09A2 — generated protocol API and trusted human binding

Verified passing.5 declared/registered research-plugin capabilities and generated preload methods saveReviewProtocol/freezeReviewProtocol/getReviewProtocol/getReviewProtocolHistory/listReviewProtocols. Existing main human context validates strict requests, then binds sender/project/capability for save/freeze. Direct tools, missing sender or forged wire reviewer cannot write; fixed reads/replays are readonly. Error categories distinguish permission, version conflict, absent records and damaged receipts.

Commands from /Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc:

| Check | Result |
| pnpm generate:ipc / pnpm build |Passed; generated contracts and fresh type/build |
| node --test tests/unit/research-systematic-review.test.mjs tests/unit/research-systematic-review-ipc.test.mjs tests/unit/research-evidence-relation-ipc.test.mjs tests/unit/research-source-migration-ipc.test.mjs tests/unit/research-source-replacement-ipc.test.mjs |33/33 |
| pnpm test:unit |Final916/916 |
| pnpm harness:eval / node scripts/run-research-p0.mjs |94/94 and13/13 |
| node scripts/smoke-electron.mjs |12/12; zero renderer errors |
| pnpm check:ipc / pnpm check:renderer-chunks / git diff --check |Passed; eager1131770bytes6files |

Source-observation test timing issue corrected in separate f645b05. Shared explicit protocol fixture now used by storage/API tests. docs/research-systematic-review.md was ignored by existing docs/* policy onA1; force-added only that authorized task doc here, no ignore/rule edits. Main registry/generated adapter tests use explicit windows17/23; production native suite and startup passed, but no new review UI/kernel E2E claim. NextA3 actual frozen-protocol search execution, raw pool lineage and failure/cancellation/restart checkpoints; screening/extraction/UI follow. Full PR09/later roadmap remains open.


## PR09 prerequisite — watcher assertion at the synchronous boundary

Verified passing. Existing watcher test checked that a5ms debounce had not published after awaiting filesystem search. A loaded full-unit run legitimately completed that timer during the await. Move the unchanged empty-publication assertion immediately after the synchronous invalidation callback; keep the actual refreshed search result and20ms eventual single-event/value checks. Product watcher unchanged.

From /Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc: node --test --test-name-pattern='watcher events invalidate immediately' tests/unit/file-name-search-snapshot.test.mjs passed1/1; pnpm test:unit final930/930. Initial929/930 in pr09-a3-unit-full.log, corrected pr09-watcher-order.log/pr09-a3-unit-full-final.log.


## ROC-PR-09A3 — frozen query execution and authoritative raw-pool lineage

Verified passing. One declared database/query per immutable request, exact frozen version/receipt/derived parameters; actual existing import service/governor/cache/request ledger/raw pool.5 generated search start/get/list/pool/cancel methods, main sender binding and actual plugin registration/lifecycle. Provider reported-end coverage required for complete; page limits/unknown coverage partial, failures retained. Atomic cancellation intent/marker then actual abort and terminal receipt. Explicit immutable retry parent/hash, no scope expansion. Crash/lost-write state cannot masquerade as success; raw pools remain readable beyond candidate expiry.

Commands from /Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc:

| Check | Result |
| pnpm generate:ipc / pnpm build |Final passed; fresh type/build/generated API |
| node --test tests/unit/research-review-search.test.mjs tests/unit/research-systematic-review.test.mjs tests/unit/research-systematic-review-ipc.test.mjs |27/27; new search14 |
| pnpm test:unit |Final930/930 |
| pnpm harness:eval / node scripts/run-research-p0.mjs |94/94 and13/13 |
| node scripts/smoke-electron.mjs |12/12; zero renderer errors |
| pnpm check:ipc / pnpm check:renderer-chunks / git diff --check |Passed; eager1131770bytes6files |

Actual offline Provider processing retained raw4 records vs filtered preview2, source paging/request SHA/receipt state, limited/unknown/failed status, explicit retry cache reuse, pending cancel + actual abort, expiry reads, corrupted pools/ledger/cancel/terminal receipts, lost terminal write and recovery with actual completed pool, cross-project release and real SQLite crash-copy restart with zero new requests. DB27→28 preserves fixed protocol bytes and migration receipts without search backfill; older upgrade latest-version assertions now28 while keeping all preservation assertions. Main transport uses explicit synthetic windows; HTTP responses are offline, no independent scientific retrieval/actual-client/full-kernel review UI claim. Parent shutdown precedes child cleanup, and project deletion/archival awaits query release.

Pre-existing watcher timing assumption fixed separately275746d; full930 final retains all assertions. Logs pr09-a3-* and pr09-watcher-order.log. NextA4 fixed review corpus and explicit dedup/screening decisions, then source-based extraction/quality evaluation, review inspector UI and count-conserving PRISMA/query appendices. Full PR09 and later roadmap remain open.


## ROC-PR-09A4A — immutable raw corpus references

Verified passing. DB29 captures exactly one terminal execution for every declared database/query, with frozen protocol/request/source receipt hashes and full original pool record references. Four generated/registered corpus create/get/list/hit capabilities bind human creation in main. Repeated/unknown-year/out-of-range hits remain; incomplete/failed sources remain explicit. Historical corpus reads verify actual pools/ledgers, archive forbids capture, request replay is readonly, source drift after insert rolls back the transaction. No second paper library or automatic deduplication.

Commands from /Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc:

| Check | Result |
| --- | --- |
| pnpm generate:ipc / pnpm typecheck / pnpm build | Passed; fresh generated API/type/build |
| node --test tests/unit/research-review-corpus.test.mjs tests/unit/research-review-search.test.mjs tests/unit/research-systematic-review.test.mjs tests/unit/research-systematic-review-ipc.test.mjs | 37/37; corpus10 |
| pnpm test:unit / pnpm harness:eval | 940/940 and94/94 |
| node scripts/run-research-p0.mjs | 13/13 |
| node scripts/smoke-electron.mjs | 12/12; zero renderer errors |
| pnpm check:ipc / pnpm check:renderer-chunks / git diff --check | Passed; chunks1131770bytes6files |

Logs pr09-a4a-* retained under .artifacts/research-optimization. Actual offline Provider/service/governor/ledger/pool/repositories and SQLite disk reopen exercised; window51 is main adapter seam. No external scientific retrieval or review UI E2E claim. Shared search fixture extracted; older latest migration expectations follow declared last version while preserving original data assertions. NextA4B explicit human duplicate decisions/freeze, followed by separate two-stage screening, extraction/quality, inspector and count-conserving reporting. Whole roadmap remains in progress.


## ROC-PR-09A4B — human duplicate revisions and immutable corpus-wide freeze

Verified passing. DB30 append-only pair decisions bind both original hit/source hashes, explicit duplicate direction or distinct result, rule/version/reason, parent/hash/revision reason and trusted caller. Four generated/declared/registered APIs. Freeze requires the complete latest decision/hash set; resolves human chains, refuses cycles/ambiguous removal/distinct conflicts, conserves identified = duplicate removed + to screen. Independent receipt/marker is atomic and missing/corrupt receipt cannot reset review. Immutable frozen/history state survives query shutdown and disk restart; archive/obsolete protocol refuse new writes. No automatic DOI/title matching or paper-library duplication; duplicate removal is not full-text exclusion.

Commands from /Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc:

| Check | Result |
| --- | --- |
| pnpm generate:ipc / pnpm typecheck / pnpm build | Passed; fresh generated/type/build |
| node --test tests/unit/research-review-deduplication.test.mjs tests/unit/research-review-corpus.test.mjs tests/unit/research-review-search.test.mjs tests/unit/research-systematic-review.test.mjs tests/unit/research-systematic-review-ipc.test.mjs | Final51/51; dedup14 |
| pnpm test:unit / pnpm harness:eval | 954/954 and94/94 |
| node scripts/run-research-p0.mjs | 13/13 |
| node scripts/smoke-electron.mjs | 12/12; zero renderer errors |
| pnpm check:ipc / pnpm check:renderer-chunks / git diff --check | Passed; chunks1131770bytes6files |

Logs pr09-a4b-* retained. Actual offline Provider/pool/ledger/repositories/DB29 migration/reopen and injected transactional corruption covered; main sender61 is adapter seam and calling provenance, not independent researcher authentication. No new UI or external scientific retrieval claim. Initial patch failed atomically at a mismatched IPC line; split patch applied, first type/focused38 and final51/full checks all passed without weakening assertions. Next separate title-abstract/full-text screening, model suggestions versus human final decisions and protocol-specific reviewer/conflict handling, then extraction/quality/inspector/count-conserving reporting. Whole roadmap remains in progress.


## ROC-PR-09A4C1 — fixed reviewer declarations before phased screening

Verified passing. DB31 immutable screening plan and separate corpus marker pin exact protocol/corpus/dedup freeze, both phase reviewer IDs/names, explicit adjudicator and main caller provenance. Counts1/2 match each frozen protocol phase; duplicate IDs/inconsistent names refuse. Two generated/declared/registered create/get APIs bind main human creation. No default roster, identity authentication or screening decisions invented. Exact replay readonly, historical/archive reads retained, new writes refused; missing/corrupt plan and upstream drift fail with transactional rollback.

Commands from /Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc:

| Check | Result |
| --- | --- |
| pnpm generate:ipc / pnpm typecheck / pnpm build | Passed; fresh generated/type/build |
| node --test tests/unit/research-review-screening-plan.test.mjs tests/unit/research-review-deduplication.test.mjs tests/unit/research-review-corpus.test.mjs tests/unit/research-review-search.test.mjs tests/unit/research-systematic-review.test.mjs tests/unit/research-systematic-review-ipc.test.mjs | 60/60; reviewer plan9 |
| pnpm test:unit / pnpm harness:eval | 963/963 and94/94 |
| node scripts/run-research-p0.mjs | 13/13 |
| node scripts/smoke-electron.mjs | 12/12; zero renderer errors |
| pnpm check:ipc / pnpm check:renderer-chunks / git diff --check | Passed; chunks1131770bytes6files |

Logs pr09-a4c1-* retained. Actual offline Provider/corpus/dedup/main adapter71/SQLite DB30 upgrade/reopen and fault injection covered. Shared actual corpus/dedup test fixture extracted; DB29 upgrade still compares every original column and new-null markers, preserving all byte/history assertions. Caller provenance and user-declared researcher IDs are separate; no verified independent reviewer identity/complete screening/UI claim. NextA4C2 phased immutable human decisions and separate model suggestions/conflict handling, then source extraction/quality/inspector/reporting. Whole roadmap remains in progress.


## PR09 prerequisite — ZIP close-error test measures the actual close boundary

Verified passing. Existing test started its30ms close/error deadline before filesystem/archive enumeration. Full-unit975/976 exposed timeout before close invocation; focused original passed1/1. A controlled50ms delay in the actual ZipFile.eachEntry prototype reproduced red. Retain this delay in the regression, wait for actual close invocation with bounded5s setup, then keep the unchanged30ms rejection deadline and exact primary/cleanup-error assertions. Add explicit no-close-event assertion. No product ZIP or security changes.

From /Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc: controlled red/green1 and node --test tests/unit/research-archive-libraries.test.mjs10/10; clean pnpm test:unit976/976. Logs pr09-archive-close-* and pr09-a4c2a-unit-clean-final.log retained. The first rerun accidentally discovered the task-only repro copy (986, failed only that red-copy file); deleted the exact task-created copy and reran clean976, without changing production or weakening assertions.


## ROC-PR-09A4C2A — immutable title-abstract reviewer decisions and separate agent suggestions

Verified passing. DB32 separate phase-keyed reviewer decision revisions and agent proposal rows. Strict frozen plan/raw hit/source/record/pool/receipt/declared reviewer/criterion refs, explicit include/exclude/uncertain reason and nullable considered-suggestion hash. Actual missing abstract preserved. Human save main-gated; proposal capability derives actual operation/tool-call/capability-version provenance from main context, never wire model/run identity. Four new generated human/read APIs and independent tool-only suggestion capability registered. Suggestions cannot become reviewer decisions or counts; human may explicitly disagree. Current phase states conserve counts, show missing reviewer/uncertainty/verdict conflict/different primary exclusion reasons, and retain history across shutdown/reopen. Arbitration/phase freeze/fulltext still next.

Commands from /Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc:

| Check | Result |
| --- | --- |
| pnpm generate:ipc / pnpm typecheck / pnpm build | Final passed; fresh generated/type/build |
| node --test tests/unit/research-review-screening-decisions.test.mjs tests/unit/research-review-screening-plan.test.mjs tests/unit/research-review-deduplication.test.mjs tests/unit/research-review-corpus.test.mjs tests/unit/research-review-search.test.mjs tests/unit/research-systematic-review.test.mjs tests/unit/research-systematic-review-ipc.test.mjs | Final73/73; decisions13 |
| pnpm test:unit / pnpm harness:eval | Clean final976/976 and94/94 |
| node scripts/run-research-p0.mjs | 13/13 |
| node scripts/smoke-electron.mjs | 12/12; zero renderer errors |
| pnpm check:ipc / pnpm check:renderer-chunks / git diff --check | Passed; chunks1131770bytes6files |

Logs pr09-a4c2a-* retained. Actual offline Provider/raw pool/DB31 migration/reopen, post-insert corruption/lost row rollback and main window81/operation-context registry seam covered; no external model call/spending or review UI E2E. Initial72/type/build passed; final review added explicit DB phase keys/read contract/capability-version replay and different-primary-reason conflict before final73. Full-unit prior ZIP deadline issue corrected separatelye2dbfb2 with controlled red/green and same30ms actual-close assertion; final976 run excludes cleaned task-only repro. Shared screening-plan fixture extracted without changing preserved data/security assertions. NextA4C2B human adjudication/current version binding and immutable whole title-abstract freeze, followed by full-text source binding/decisions, extraction/quality/inspector/reporting. Whole roadmap remains open.


## ROC-PR-09A4C2B — immutable human adjudication with current reviewer-set binding

Verified passing. DB33 arbitration revisions bind complete exact current reviewer decision refs, declared adjudicator, final explicit criterion/outcome/reason, fixed material and main caller. Two generated/registered adjudication/history APIs; existing phase read now returns resolved states, no alias. Missing reviewers/agreement/stale refs/unknown adjudicator/criteria refuse. Reviewer revision leaves old adjudication visible with currentDecisionSet=false; only latest matching judgment resolves current conflict/uncertainty and changes conserved counts. Post-insert current plan/ref check rolls back even a valid new reviewer revision. Original votes/suggestions unchanged; historical/archive reads retained, writes denied.

Commands from /Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc:

| Check | Result |
| --- | --- |
| pnpm generate:ipc / pnpm typecheck / pnpm build | Final passed; fresh generated/type/build |
| node --test tests/unit/research-review-screening-arbitration.test.mjs tests/unit/research-review-screening-decisions.test.mjs tests/unit/research-review-screening-plan.test.mjs tests/unit/research-review-deduplication.test.mjs tests/unit/research-review-corpus.test.mjs tests/unit/research-review-search.test.mjs tests/unit/research-systematic-review.test.mjs tests/unit/research-systematic-review-ipc.test.mjs | Final82/82; arbitration9 |
| pnpm test:unit / pnpm harness:eval | 985/985 and94/94 |
| node scripts/run-research-p0.mjs | 13/13 |
| node scripts/smoke-electron.mjs | 12/12; zero renderer errors |
| pnpm check:ipc / pnpm check:renderer-chunks / git diff --check | Passed; chunks1131770bytes6files |

Logs pr09-a4c2b-* retained. Actual reviewer/proposal/source repositories, trigger-created valid new reviewer revision and invalid source rollback, DB32 migration/reopen and main window91 exercised. No external model/spending, independent researcher authentication or review UI E2E claim. First82/build passed, final current-ref commit recheck added before final82/full checks. Next whole title-abstract freeze, fulltext source binding/decisions, extraction/quality/inspector/count-conserving reporting. Whole roadmap remains open.


## ROC-PR-09A4C2C — complete title-abstract authority freeze

Verified passing. DB34 independent whole-phase receipt and plan marker bind exact displayed review hash, fixed corpus/plan/ordered hits/current reviewer refs/applied arbitration/primary exclusion reasons/counts. Proposal counts and current-protocol presentation do not become human authority. All records must be resolved; empty failed-source subset still requires explicit freeze and retains incomplete search coverage. One generated freeze API; existing phase inspection includes receipt/hash. New votes/proposals/arbitration denied after freeze, exact old requests replay readonly. Deleted/corrupt marker/receipt or live authority drift fails; valid new reviewer revision during storage rolls back receipt/marker/revision. Historical/archive read stays exact, current hash gates later fulltext.

Commands from /Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc:

| Check | Result |
| --- | --- |
| pnpm generate:ipc / pnpm typecheck / pnpm build | Passed; fresh generated/type/build |
| node --test tests/unit/research-review-screening-freeze.test.mjs tests/unit/research-review-screening-arbitration.test.mjs tests/unit/research-review-screening-decisions.test.mjs tests/unit/research-review-screening-plan.test.mjs tests/unit/research-review-deduplication.test.mjs tests/unit/research-review-corpus.test.mjs tests/unit/research-review-search.test.mjs tests/unit/research-systematic-review.test.mjs tests/unit/research-systematic-review-ipc.test.mjs | Final91/91; title freeze9 |
| pnpm test:unit / pnpm harness:eval | 994/994 and94/94 |
| node scripts/run-research-p0.mjs | 13/13 |
| node scripts/smoke-electron.mjs | 12/12; zero renderer errors |
| pnpm check:ipc / pnpm check:renderer-chunks / git diff --check | Passed; chunks1131770bytes6files |

Logs pr09-a4c2c-* retained. Actual raw/ref/reviewer/arbitration repositories, absent/broken receipt and valid-new-vote transaction triggers, main101, DB33 canonical old snapshot seeding/upgrade/reopen covered. Current runtime does not write old schemas; migration fixture seeds explicit canonical pre-freeze votes/arbitration and new code verifies all original columns/values after upgrade. Prerequisite30/31 failed only test restore7-values versus new8-column table; explicit all8 original fields restored, no assertion relaxed. Initial91/build passed; last regression adds valid late revision before final91/full checks, no later production edits. No full review UI/external scientific/model-spend claim. Next fulltext source binding and two-stage decisions, then extraction/quality/inspector/count-conserving reporting; whole roadmap open.


## ROC-PR-09A4C3A — explicit fulltext retrieval and existing source binding

Verified passing. DB35 immutable binding revisions only for title-frozen included hits. Existing managed document/source SHA with explicit optional current published parse/hash/coordinate basis; no paper duplication or inferred scientific matching. Human not-retrieved reason remains separate from eligibility exclusion. Four generated/registered APIs extend actual trusted main sender boundary. Real source/preview verification, exact preflight snapshot retained across await, transactional scope/title/parent/source checks and postinsert drift rollback; main-only verifyCurrent rereads actual bytes before later scientific writes. History distinguishes latest/protocol/reference status and preserves source-only across reparse.

Commands from /Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc:

| Check | Result |
| --- | --- |
| pnpm generate:ipc / pnpm typecheck / pnpm build | Passed; fresh generated/type/build |
| node --test tests/unit/research-review-fulltext.test.mjs | Initial9/9; final10 included below |
| node --test --test-name-pattern='coordinate metadata replaced' tests/unit/research-review-fulltext.test.mjs | Before fix:1 failed, Missing expected rejection; final regression passed |
| node --test tests/unit/research-review-fulltext.test.mjs tests/unit/research-review-screening-freeze.test.mjs tests/unit/research-review-screening-arbitration.test.mjs tests/unit/research-review-screening-decisions.test.mjs tests/unit/research-review-screening-plan.test.mjs tests/unit/research-review-deduplication.test.mjs tests/unit/research-review-corpus.test.mjs tests/unit/research-review-search.test.mjs tests/unit/research-systematic-review.test.mjs tests/unit/research-systematic-review-ipc.test.mjs tests/unit/research-document-coordinates.test.mjs tests/unit/research-document-annotations.test.mjs | Final121/121; fulltext10 |
| pnpm test:unit / pnpm harness:eval | 1004/1004 and94/94 |
| node scripts/run-research-p0.mjs | 13/13 |
| node scripts/smoke-electron.mjs | 12/12; zero renderer errors |
| pnpm check:ipc / pnpm check:renderer-chunks / git diff --check | Passed; chunks1131770bytes6files |

Logs pr09-a4c3a-* retained. Real frozen PDF/parser/collector/publication/source/preview, canonical coordinate replacement after actual preview, postinsert rollback, history/corruption/archive/project unlink/new protocol, main111 and DB34 upgrade/reopen covered. Initial9 passed; added actual async source seal red regression and minimum exact snapshot comparison before final121/full build/checks. No new eligibility decisions, review UI, independent scientific matching or model spending claim. Next fulltext reviewer decisions and separate source-bound suggestions, arbitration/freeze, extraction/quality/inspector/reporting; whole roadmap open.


## ROC-PR-09A4C3B1 — source-bound fulltext reviewer decisions and separate proposals

Verified passing. Existing phase-keyed DB32 votes/proposals store full_text records with exact title/plan/binding refs, declared fulltext reviewer and immutable parent lineage. Actual original/coordinate bytes verified before new human/proposal writes; post-await/transaction/postinsert source state checks reject drift. Suggestions use actual capability operation/call/version provenance and never count as human decisions. Different primary exclusion criteria remain conflict. Retrieval gaps and stale-source votes remain distinct from eligibility; every reviewer must explicitly revise to the new binding after source revision. Five generated/registered APIs; main121 human authority preserved through real file awaits. Synchronous source batch/history inspection threads one verified title snapshot while retaining all individual seals/parents and fresh postawait/postinsert reads.

Commands from /Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc:

| Check | Result |
| --- | --- |
| pnpm generate:ipc / pnpm typecheck / pnpm build | Passed; final fresh build/type |
| node --test tests/unit/research-review-fulltext-screening.test.mjs | Initial12/12 |
| node --test tests/unit/research-review-fulltext-screening.test.mjs tests/unit/research-review-fulltext.test.mjs tests/unit/research-review-screening-freeze.test.mjs tests/unit/research-review-screening-arbitration.test.mjs tests/unit/research-review-screening-decisions.test.mjs tests/unit/research-review-screening-plan.test.mjs tests/unit/research-review-deduplication.test.mjs tests/unit/research-review-corpus.test.mjs tests/unit/research-review-search.test.mjs tests/unit/research-systematic-review.test.mjs tests/unit/research-systematic-review-ipc.test.mjs tests/unit/research-document-coordinates.test.mjs tests/unit/research-document-annotations.test.mjs | Final133/133; fulltext reviewer12 |
| pnpm test:unit / pnpm harness:eval | 1016/1016 and94/94 |
| node scripts/run-research-p0.mjs | 13/13 |
| node scripts/smoke-electron.mjs | 12/12; zero renderer errors |
| pnpm check:ipc / pnpm check:renderer-chunks / git diff --check | Passed; chunks1131770bytes6files |

Logs pr09-a4c3b1-* retained. Real PDF/publication/source/preview, one/two reviewers/reasons conflict/replay/parent, unavailable and superseded source refusal, explicit all-reviewer source-version revision, physical/async drift and transaction corruption/rollback, main121 actual operation provenance and disk reopen covered. Initial12/build passed; synchronous repeated-title read cleanup then final133/freshbuild/fullchecks all passed. No new DB version/backfill, persistent cache, legacy alias, model spend or full review UI/scientific independence claim. Next exact-current-reviewer human arbitration then fulltext whole-round freeze; extraction/quality/inspector/count-conserving reporting and whole roadmap remain.


## ROC-PR-09A4C3B2 — exact-current-reviewer/source fulltext adjudication

Verified passing. Existing phase-keyed DB33 arbitration records pin all current declared fulltext votes, exact plan/title/binding hashes and declared adjudicator. Actual source bytes verified before transaction and entire current reviewer/source set rechecked after insert. Valid newly appended reviewer revision during storage causes complete arbitration/revision rollback. Only latest currentDecisionSet-matched arbitration resolves derived uncertain/conflict state; revised votes or sources retain stale adjudication/history. Explicit parents/replay and main131 async human authority.2 generated APIs; existing phase transport becomes resolved view. Incomplete/agreed/unavailable/superseded/strict-forged requests refuse without writes.

Commands from /Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc:

| Check | Result |
| --- | --- |
| pnpm generate:ipc / pnpm typecheck / pnpm build | Passed; fresh current build/type |
| node --test tests/unit/research-review-fulltext-arbitration.test.mjs tests/unit/research-review-fulltext-screening.test.mjs tests/unit/research-review-fulltext.test.mjs | Initial31/31; before10th arbitration disk reopen case was appended |
| node --test tests/unit/research-review-fulltext-arbitration.test.mjs tests/unit/research-review-fulltext-screening.test.mjs tests/unit/research-review-fulltext.test.mjs tests/unit/research-review-screening-freeze.test.mjs tests/unit/research-review-screening-arbitration.test.mjs tests/unit/research-review-screening-decisions.test.mjs tests/unit/research-review-screening-plan.test.mjs tests/unit/research-review-deduplication.test.mjs tests/unit/research-review-corpus.test.mjs tests/unit/research-review-search.test.mjs tests/unit/research-systematic-review.test.mjs tests/unit/research-systematic-review-ipc.test.mjs tests/unit/research-document-coordinates.test.mjs tests/unit/research-document-annotations.test.mjs | Final143/143; fulltext arbitration10 |
| pnpm test:unit / pnpm harness:eval | 1026/1026 and94/94 |
| node scripts/run-research-p0.mjs | 13/13 |
| node scripts/smoke-electron.mjs | 12/12; zero renderer errors |
| pnpm check:ipc / pnpm check:renderer-chunks / git diff --check | Passed; chunks1131770bytes6files |

Logs pr09-a4c3b2-* retained. Real byte verification, complete current votes, stale arbitration after valid reviewer revision/reparse/unavailable binding, immutable parents/ref-matched historical conclusions, exact declared adjudicator/main131, corrupt material/source drift and valid-new-vote transaction trigger rollback, actual disk reopening covered. First31/build passed;10th test added before final143/fullunit1026, runtime unchanged after build. No new DB/backfill, UI/scientific independence or model spend claim. Next fulltext whole-round freeze then extraction/quality/inspector/count-conserving reporting; whole roadmap remains open.


## ROC-PR-09A4C3B3 — complete fulltext authority freeze with independent live source state

Verified passing. DB36 independent full_freeze_hash and existing phase full_text receipt fix exact current binding/vote/applied arbitration refs, primary exclusion reason and human counts. All reports explicitly not_retrieved or current-source final included/excluded; real bytes verified for all retrieved sources before transaction review-hash/completeness recheck. Valid new vote/source drift during insert rolls back receipt/marker/drift. All new binding/vote/proposal/arbitration writes guard persisted freeze, exact original requests replay readonly. Missing/corrupt marker/receipt cannot reopen. Frozen human authority reconstructed from exact same-binding votes/arbitration refs stays fixed across later doc reparse; live phase exposes source_changed/sourcesCurrent:false and requireFrozen refuses expired scientific use. Source metadata state is not a claim that readonly inspection read current disk bytes.

Commands from /Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc:

| Check | Result |
| --- | --- |
| pnpm generate:ipc / pnpm typecheck / pnpm build | Passed; fresh current build/type |
| node --test tests/unit/research-review-fulltext-freeze.test.mjs tests/unit/research-review-fulltext-arbitration.test.mjs tests/unit/research-review-fulltext-screening.test.mjs tests/unit/research-review-fulltext.test.mjs tests/unit/research-review-screening-plan.test.mjs | Initial50/51; only old DB34 full-row migration comparison failed on newly added null column; all10 new freeze cases passed |
| node --test tests/unit/research-review-fulltext-freeze.test.mjs tests/unit/research-review-fulltext-arbitration.test.mjs tests/unit/research-review-fulltext-screening.test.mjs tests/unit/research-review-fulltext.test.mjs tests/unit/research-review-screening-freeze.test.mjs tests/unit/research-review-screening-arbitration.test.mjs tests/unit/research-review-screening-decisions.test.mjs tests/unit/research-review-screening-plan.test.mjs tests/unit/research-review-deduplication.test.mjs tests/unit/research-review-corpus.test.mjs tests/unit/research-review-search.test.mjs tests/unit/research-systematic-review.test.mjs tests/unit/research-systematic-review-ipc.test.mjs tests/unit/research-document-coordinates.test.mjs tests/unit/research-document-annotations.test.mjs | Final153/153; fulltext freeze10 |
| pnpm test:unit / pnpm harness:eval | 1036/1036 and94/94 |
| node scripts/run-research-p0.mjs | 13/13 |
| node scripts/smoke-electron.mjs | 12/12; zero renderer errors |
| pnpm check:ipc / pnpm check:renderer-chunks / git diff --check | Passed; chunks1131770bytes6files |

Logs pr09-a4c3b3-* retained. Actual original/coordinate byte checks, displayed-hash race from independent human binding revision, valid new vote/source drift triggers, missing and canonically changed receipt, new-write guards/replay, frozen history after reparse with refused current scientific use, main141/history/archive, explicit canonical DB35 binding upgrade/no new final data, disk reopen/failed empty coverage covered. Existing DB34 preservation now captures all original columns through PRAGMA and compares every original field/row, separately asserts new full marker null; no compatibility bypass or assertion weakened. No review UI/scientific independence/spending claim. Next source-Evidence/unit-bound extraction with distinct missing/unjudgeable, per-design frozen quality/human review, inspector and actual reports; whole roadmap remains open.


## ROC-PR-09A5A — existing Evidence/source/unit-bound human extraction

Verified passing. DB37 immutable human-confirmed extraction revisions pin exact fulltext frozen included hit/binding/protocol/field definitions/units, actual current existing Evidence+managed locator static digest/coordinate hash, declared reviewer and trusted main actor. Numeric/text/missing/unjudgeable remain distinct; required fields explicit, optional omitted fields uncollected, no numeric/unit fallback. Source-only frozen original can bind separately explicit current Evidence parse. Actual bytes/unique selected parse previews checked, asynchronous source seal comparison and exact postinsert payload hash/current-source checks reject canonical value tampering or Evidence invalidation with full transaction rollback. Existing Evidence source capture factored into readonly readCurrentEvidenceSourceLocator; every real current indexed block/parse/source/excerpt/location check retained, no evidence publication in extraction verification.4 generated/main human APIs and immutable histories.

Commands from /Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc:

| Check | Result |
| --- | --- |
| pnpm generate:ipc / pnpm typecheck / pnpm build | Passed; fresh current build/type |
| node --test tests/unit/research-review-extraction.test.mjs tests/unit/research-document-annotations.test.mjs | Initial19/19; extraction10 |
| node --test tests/unit/research-review-extraction.test.mjs tests/unit/research-review-fulltext-freeze.test.mjs tests/unit/research-review-fulltext-arbitration.test.mjs tests/unit/research-review-fulltext-screening.test.mjs tests/unit/research-review-fulltext.test.mjs tests/unit/research-review-screening-freeze.test.mjs tests/unit/research-review-screening-arbitration.test.mjs tests/unit/research-review-screening-decisions.test.mjs tests/unit/research-review-screening-plan.test.mjs tests/unit/research-review-deduplication.test.mjs tests/unit/research-review-corpus.test.mjs tests/unit/research-review-search.test.mjs tests/unit/research-systematic-review.test.mjs tests/unit/research-systematic-review-ipc.test.mjs tests/unit/research-document-coordinates.test.mjs tests/unit/research-document-annotations.test.mjs | Final163/163 |
| pnpm test:unit / pnpm harness:eval | 1046/1046 and94/94 |
| node scripts/run-research-p0.mjs | 13/13 |
| node scripts/smoke-electron.mjs | 12/12; zero renderer errors |
| pnpm check:ipc / pnpm check:renderer-chunks / git diff --check | Passed; chunks1131770bytes6files |

Logs pr09-a5a-* retained. Actual Evidence publication/capture/source bytes/current locator verification, units/finite values/required+optional/status distinctions, source-only old/new parse Evidence history, foreign/unlocated/missing-index/no-full-freeze refusal, physical bytes/canonical coordinate replacement after real preview, canonically rewritten payload and Evidence invalidation transaction triggers, history/archive/main151 and DB36 preservation/reopen covered. All checks passed, no production change after build. Values are explicit synthetic human engineering declarations, not scientific correctness acceptance. No paper/Evidence duplication, model-fill fallback, UI or independent-quality claim. Next explicit per-design protocol framework definition freeze and human source-bound quality judgments, then inspector/reporting; whole roadmap remains open.


## ROC-PR-09A5B1 — extracted-design-bound immutable quality framework definition

Verified passing. DB38 independent extraction quality_plan_hash and immutable quality-plan receipt fix exact human extraction/study-design and protocol-declared framework/version. User-declared domains/questions/allowed judgements/overall choices/documentation and human confirmation are frozen; no official-completeness or universal numerical-score claim. Missing/unjudgeable/mismatched design or undeclared framework/version refuses. Main-only extraction.verifyCurrent reuses real original/selected-parse coordinate-byte checks and postawait latest-source validation, no cache. Same extraction cannot mutate framework; new extraction requires new plan and old plan stays historical. Missing/corrupt marker/receipt refuses get/list/create; valid late extraction or Evidence invalidation during insert rolls back all writes.3 generated/registered APIs and actual main161 human actor separate from declared reviewer.

Commands from /Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc:

| Check | Result |
| --- | --- |
| pnpm generate:ipc / pnpm typecheck / pnpm build | Passed; fresh current build/type; no later production changes |
| node --test tests/unit/research-review-extraction.test.mjs tests/unit/research-review-quality-plan.test.mjs | Initial extraction10 passed; new quality file had SyntaxError from test assignment typo and did not execute |
| node --check tests/unit/research-review-quality-plan.test.mjs / node --check tests/unit/fixtures/research-review-quality.mjs | Passed after test-only assignment correction |
| node --test tests/unit/research-review-quality-plan.test.mjs | 9/9 |
| pnpm test:unit / pnpm harness:eval | 1055/1055, including all172 scoped review/source cases;94/94 |
| node scripts/run-research-p0.mjs | 13/13 |
| node scripts/smoke-electron.mjs | 12/12; zero renderer errors |
| pnpm check:ipc / pnpm check:renderer-chunks / git diff --check | Passed; chunks1131770bytes6files |

Logs pr09-a5b1-* retained. Actual managed source/preview/latest extraction, immutable plan/history/current extraction revisions, strict study-design/framework/declarations, corrupt/lost receipt/marker, transaction drift rollback, main161 and DB37 all-column/row preservation/null new marker/disk reopen covered. Initial test-only syntax error corrected without changing assertions; production build unchanged. Next per-domain human/source-bound quality judgments, inspector and real count reports; PR09 and whole roadmap remain open.


## ROC-PR-09A5B2 — source-bound human quality judgements with immutable review history

Verified passing. DB39 independent quality-plan assessment_head_hash and immutable version/parent receipts record every frozen domain's explicit judged category or unjudgeable reason, exact existing extraction Evidence digests and user-confirmed overall label/reason. Per-domain options and complete domain set required; no automatic numerical aggregation or substitute evidence. Declared fulltext/adjudicator reviewer and trusted main actor separate. Real bytes checked before new writes; exact source/plan/extraction/current parent refreshed after await and insertion. Canonically legal judgment tampering, valid late extraction/assessment and Evidence invalidation roll back receipt/head/drift. Independent human revision across await remains committed while obsolete parent request refuses. Missing latest/head or damaged payload/parent never appears unassessed. New extraction needs new framework, historical source/protocol/archive judgments remain readable with explicit stale flags.3 generated APIs, real main171, mandatory registration dependency and updated caller; no legacy alias.

Commands from /Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc:

| Check | Result |
| --- | --- |
| pnpm generate:ipc / pnpm typecheck / pnpm build | Passed; final fresh build/type after synchronous-context read reuse |
| node --check tests/unit/research-review-quality-assessment.test.mjs | Passed |
| node --test tests/unit/research-review-quality-assessment.test.mjs tests/unit/research-review-quality-plan.test.mjs | Initial18/18, before10th assessment case and synchronous-context cleanup |
| pnpm test:unit / pnpm harness:eval | Final1065/1065, including all182 review/source cases and10 assessment cases;94/94 |
| node scripts/run-research-p0.mjs | 13/13 |
| node scripts/smoke-electron.mjs | 12/12; zero renderer errors |
| pnpm check:ipc / pnpm check:renderer-chunks / git diff --check | Passed; chunks1131770bytes6files |

Logs pr09-a5b2-* retained. Synchronous stages thread one verified context without persistent cache; byte-await/postinsert stages independently reread exact state. Initial multi-file patch context mismatch applied nothing and was corrected from actual source. No assertion weakening, source duplication, official quality-score/scientific independence or UI claim. Next explicit study/report membership for accurate PRISMA counts, report/query/exclusion sections and inspector; whole roadmap remains open.


## ROC-PR-09A6A — explicit human study/report memberships and separate included counts

Verified passing. DB40 independent screening-plan study_group_head_hash and immutable grouping revisions pin every included report's exact frozen hit/binding reference. User declares study IDs/labels/reasons and source-specific member notes. All frozen included reports covered, unique study IDs/members within group; unselected/gap/excluded/incorrect-source records refused. Many reports may belong to one declared study; explicit multiple studies within a report allowed. includedReports counts distinct frozen reports, includedStudies counts declared study IDs, no title/DOI inference or paper-library duplication. Null genuinely undeclared; empty reviewed grouping allowed only when no included reports. Main181 and fixed fulltext/adjudicator reviewer separate. Actual bytes for every included binding and exact postawait/postinsert current source/parent/head checked; canonical legal identity mutation, valid new group and source drift roll back. Independent human revision across await preserved while stale parent refuses. Historical source/protocol/archive memberships/counts retained, readonly sourcesCurrent is metadata status.

Commands from /Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc:

| Check | Result |
| --- | --- |
| pnpm generate:ipc / pnpm typecheck / pnpm build | Passed; fresh current build/type; no later production changes |
| node --check tests/unit/research-review-studies.test.mjs | Passed |
| node --test tests/unit/research-review-studies.test.mjs tests/unit/research-review-fulltext-freeze.test.mjs tests/unit/research-review-fulltext.test.mjs | Initial29/29, before10th study race test |
| pnpm test:unit | Initial1074/1075; only existing DB36 extraction migration full-row comparison failed on added null study marker |
| node --test --test-name-pattern='DB36 upgrade' tests/unit/research-review-extraction.test.mjs | 1/1 after comparing every original column/row and separately checking null new marker |
| pnpm test:unit / pnpm harness:eval | Corrected final1075/1075 (all192 scoped cases and10 study cases);94/94 |
| node scripts/run-research-p0.mjs | 13/13 |
| node scripts/smoke-electron.mjs | 12/12; zero renderer errors |
| pnpm check:ipc / pnpm check:renderer-chunks / git diff --check | Passed; chunks1131770bytes6files |

Logs pr09-a6a-* retained, including initial fullunit failure and corrected complete rerun. Migration checks retain all original values/counts, no old-schema runtime fallback or relaxed corruption assertions. Primary PRISMA2020 original glossary and official source-specific/new-update templates verified2026-11-04 and cited in docs; Jina401/BMJ403/PMC challenge changed to successfully read original PLOS article via connected Search Service. No official template/export, scientifically validated study identity, study-level effect aggregation or new UI claim. Next readonly count/query/exclusion/report Evidence data and existing inspector, then whole roadmap.


## ROC-PR-09A6B — frozen count/query/exclusion/report Evidence data with independent live state

Verified passing. getReviewReport assembles exact protocol/corpus/dedup/title/full/group receipts in one readonly SQLite transaction. Four equations and direct frozen-count crosschecks distinguish collected records, duplicate removals, title exclusions, sought/not-retrieved/assessed/full-excluded/included reports. Study count stays null until explicit human group receipt. Query appendix includes exact actual snapshots/parameters/dates/terminal receipts, Provider errors/coverage and full original metadata with repeats/nulls; pools are read by source when assembling records and each hit hash verified. Parent repositories retain their own integrity reads, no persistent cache. Primary exclusion criteria and exact vote/arbitration/binding refs, report-level latest extraction/units/Evidence and matching framework/assessment with explicit absent/unjudgeable data. Static body/bodyHash excludes live protocol/reference flags, preserving reviewed facts after true reparse/new protocol/archive. Missing marked data or corrupted pool refuses whole report; no fallback records, effect aggregation, official format or UI claim. Registered main191 readonly IPC rejects foreign scope and untrusted wire fields without scientific writes or network.

Commands from /Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc:

| Check | Result |
| --- | --- |
| pnpm generate:ipc / pnpm typecheck | Generation passed; first type exposed missing map closure in new service; corrected type passed |
| pnpm build | Fresh current build/type passed; no later production changes |
| node --check tests/unit/research-review-report.test.mjs | Passed |
| node --test tests/unit/research-review-report.test.mjs | Initial7/8; failed-query test incorrectly expected Provider error in execution receipt |
| node --test --test-name-pattern='failed source coverage' tests/unit/research-review-report.test.mjs | Corrected1/1; exact failed status, execution error null and retained Provider error checked |
| pnpm test:unit / pnpm harness:eval | Final1083/1083, including all200 scoped review/source cases and8 report cases;94/94 |
| node scripts/run-research-p0.mjs | 13/13 |
| node scripts/smoke-electron.mjs | 12/12; zero renderer errors |
| pnpm check:ipc / pnpm check:renderer-chunks / git diff --check | Passed; chunks1131770bytes6files |

Logs pr09-a6b-* retained. Source pool failures remain Provider-layer outcomes; execution receipt error null is the original successfully processed failed pool semantics, not a invented retry/success fallback. Original exact source/unit/framework data, source/protocol/archive static hash/current flags, genuinely uncollected and zero-review cases, corruption and real main/project/no-write boundaries covered. No new DB/dependency, renderer UI, independent scientific validity or formal PRISMA template/export claimed. Next integrated existing inspector protocol/search/screening/extraction/quality/report surfaces and real assistant links/tools; whole roadmap still open.
