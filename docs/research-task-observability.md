# ResearchTask execution observations and offline diagnostics

`ResearchTask` diagnostics now connect the existing execution tree to persisted model-call observations, chat telemetry/replay and managed experiment resource receipts. The management drawer discloses these details on demand. This implements execution-plan §22.3 without another shell, route, telemetry ledger or external trace transport.

## Authoritative records

Agent DB migration 19 adds immutable `agent_budget_call_observations`, keyed by the existing `(run_id, call_id)` budget reservation. `RunBudgetObserver.invoke()` records an ISO start time, measured duration and `completed`/`failed` outcome after a successfully reserved invocation. A rejected reservation neither dispatches the provider nor creates an observation.

Duration measures the invocation boundary, including serialization, reservation, dispatch and settlement work. It is not an isolated provider service time. A process that exits before the final observation has no duration receipt; diagnostics return `invocation: null`. Unknown usage/cost still retains the existing budget occupancy. Invocation success and known billing are separate states.

Call rows are read from the existing budget ledger. Creation and settlement timestamps come from the reservation and real `call_settled`/`call_unknown` task events. Task cost remains the existing authoritative aggregate; the UI/export does not add execution summaries to call totals. External service cost remains `unknown`.

Chat observations project the existing `AgentRunTelemetryRepository`: first output, tool calls/errors, resource acquisition/cancellation and measured wait/hold time, plus at most 256 sanitized trace spans and their dropped count. Span identities are local sequence identifiers defined by the existing trace schema. Arbitrary tool names, arguments, results and provider/model labels are omitted.

Chat replay projects the existing `AgentRunEventLog`, retaining sequence, event type/time, tool-call identity/status and failure presence. A folded or incomplete history returns an explicit gap with `throughSequence` and `historyComplete`; replay snapshot state and message contents never cross this diagnostic boundary.

Experiment observations read the actual managed `log/resources.json` through `ResearchExperimentService.source()`. That path verifies registered file bytes. Diagnostics also require matching run/project/engine/input/environment identities and return report SHA256, outcome, usage, admission and probe measurements. `returned`, `rejected` and `not_dispatched` remain distinct. Missing receipts/measurements are `null`; corrupted or foreign receipts fail rather than becoming unknown.

Execution artifacts replace the old ID-only list with `{id, version, versionSource, state}`. `versionSource: current_inspector` means the inspector's version **at read time**, not the historical version emitted by that execution. The UI explicitly labels the execution-time version unknown. A deleted artifact is `missing` with a null version; other inspector failures propagate.

## Capabilities and scope

| Capability | Preload method | Input |
| --- | --- | --- |
| `research.task.diagnostics.execution` | `research.getTaskExecutionDiagnostics` | project/task, execution kind/ID, independent call/event cursors and limit |
| `research.task.diagnostics.export` | `research.exportTaskDiagnostics` | project/task only |

Execution reads require the real project-owned task and execution association to agree. Call pagination orders the existing SQLite reservation row IDs, reads `limit + 1` rows and validates the task ownership of every read row, including the pagination probe. Each page is limited to 100 rows and returns `nextSequence`/`hasMore`. Replay uses its own cursor and preserves gap information.

The export capability requires the existing main-process human context for the exact project and capability. The IPC adapter binds it to the invoking application window. Wire input cannot supply `actor`, `approved`, a destination or an authorization context. Model/capability invocation alone cannot export.

## Offline package

The exporter reads at most 500 executions, the first 100 calls and replay events per execution, and the first 100 task events. Cursor/`hasMore`, replay gap and trace dropped counts remain in the package. This is bounded diagnostic coverage, not a complete event archive.

Project/task/execution/call/tool-call/artifact identifiers and pricing-version labels are consistently pseudonymized with SHA256. Goals, fact text, actors, provider/model names, prompts, tool arguments/results, error text, absolute paths and replay snapshot state are structurally removed. Errors retain presence/status. Pseudonymization permits correlation and does not make the package anonymous: exact times, hashes and measurements remain.

After asynchronous source reads, the exporter rereads the task summary and rejects changes. A package larger than 2 MiB fails before file creation. The required diagnostics root comes from the main bootstrap's managed path; no fallback or caller-controlled directory is used. A random local JSON file is created exclusively with `wx` and mode `0600`. The receipt includes its path, exact byte size and SHA256, `redacted: true` and `externalTrace: not_exported`.

The export operation has no network path. External Trace export and real scientific/long-context acceptance remain unrun.

## Desktop behavior

The existing task execution tree uses native, initially closed `<details>` for observations. Opening or refreshing reads current persisted telemetry. Calls and replay have independent 50-row pages that replace the displayed page. Loading, failure, missing observations, unknown usage/cost and replay gaps are visible states. The export action prevents duplicate dispatch while pending and displays the real local receipt; late replies cannot populate another project/task panel.

## Verification

Status: **Verified passing** for local execution diagnostics and export. All commands run from `/Users/Apple_501/Desktop/Roc/Roc` on macOS 27.0.1 arm64, Node v26.13.0 and pnpm 12.5.1; Electron 45.0.0 is declared by the project. Evidence is retained under `.artifacts/research-optimization/`.

| Command | Result and evidence |
| --- | --- |
| `node --test tests/unit/research-task-observability.test.mjs tests/unit/research-experiment-resources.test.mjs tests/unit/research-task-diagnostics.test.mjs tests/unit/run-budget-observer.test.mjs tests/unit/run-budget-ledger.test.mjs tests/unit/database-migrations.test.mjs tests/unit/research-task-notifications.test.mjs tests/unit/research-task-cancellation.test.mjs` | 44/44 passed; `observability-focused-final.log` |
| `pnpm build` | Passed, including typecheck; `observability-build-final.log` |
| `node --test tests/renderer/research-tasks.test.mjs` | 16/16 passed in Electron; `observability-renderer-first.log` |
| `pnpm test:unit` | 1469/1469 passed, no skipped/cancelled tests; `observability-all-unit.log` |
| `pnpm harness:eval` | 94/94 passed; `observability-harness.log` |
| `node scripts/run-research-p0.mjs` | 19/19 passed; `observability-native.log` |
| `node scripts/smoke-electron.mjs` | 13/13 passed, zero renderer errors; `observability-startup.log` |
| `pnpm check:ipc` | Generated contracts current; `observability-ipc.log` |
| `pnpm check:renderer-chunks` | Passed, 1,134,468 eager bytes / six files; `observability-chunks.log` |
| `node --test tests/unit/research-task-cancellation.test.mjs` | 6/6 passed after explicitly supplying the required exporter in two fixture registrations; `observability-cancellation-final.log` |
| `git diff --check` / `git diff --cached --check` | Passed |

The focused tests exercise real invocation success/failure/blocked admission, unknown accounting, immutable SQLite/backup/reopen, scoped call pagination, real telemetry/replay gaps, current/missing artifact versions, managed resource outcomes/corruption, main human IPC authority, byte hash/permissions, structural redaction, source drift and output bounds. Renderer coverage includes keyboard disclosure, independent pagination, refreshed telemetry, errors/pending/receipt handling and late project replies.

Light/dark layouts at 720px and 380px include 12 observation-state clip audits with `cut: 0`, saved in `task-ui/observations-clip-audit.json`. `task-ui/observations-dark-380.png` was visually inspected. These fixture-driven UI checks do not establish real paid-model quality, provider billing completeness or historical artifact-version reconstruction.

The initial focused runs failed at incorrect settlement-column and fixture contracts. Settlement timestamps now use the real task events; fixtures provide the required capability/search-plan/telemetry inputs and text delta event. The final focused run passed all 44 cases without relaxing production checks. Earlier failed logs are retained as `observability-focused-{first,second,third}.log`. The final renderer run preceded the settlement lookup index and pagination probe ownership check; its UI source remained unchanged and the final build/unit/native gates include those database changes.
