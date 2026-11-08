# ResearchTask：任务事实、执行观测与离线诊断

`ResearchTask` diagnostics now connect the existing execution tree to persisted model-call observations, chat telemetry/replay and managed experiment resource receipts. The management drawer discloses these details on demand. Task ownership follows [ADR 0028](adr/0028-execution-task-ownership.md); these views use existing records and local diagnostics.

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

## Task facts and context

Task facts are bounded, immutable revisions in the agent identity database (migration 18). Each entry stores a kind, content, lifecycle state and one to eight typed source references. Supported kinds are confirmed constraints, source versions, human decisions, unverified hypotheses, todos, counterevidence, evaluation conditions and user corrections. Facts are research data and never grant capabilities or replace approval.

`research.getTaskFacts`, `research.saveTaskFacts` and `research.getTaskFactsHistory` require explicit project/task identity. Saving requires the main process human context for `research.task.facts.save`; the actor comes from the submitting window, with no actor or approval fields on the wire. `expectedRevision` enforces optimistic concurrency. The store seals normalized snapshots, checks their SHA256 and physical task/revision identity, refuses updates, and retains old revisions when new entries correct or supersede them. Task deletion cascades.

Limits are 100 entries, 2,000 characters per content, eight references per entry and 32,000 serialized characters across entries. History pages contain at most 50 revisions. The management drawer supports user entries, explicit completion/replacement and the latest 50 history revisions. Full history remains available through the bounded cursor API. Failed saves preserve the draft; refresh reads the current revision.

Artifact references bind the inspector version. Documents bind the source SHA256 and committed parse identity. Execution references bind a task-owned execution and its manifest hash. Reads compare each reference to current state and explicitly report changed, unlinked or deleted sources without rewriting history. Active entries with expired references cannot be saved; completing or replacing them preserves their old reference. Storage corruption and scope mismatches fail.

Stage execution and retries reconstruct the task goal and latest facts from durable storage. The main assistant harness uses the read-only scoped `research.task.facts.forChat` capability before each model call, including checkpoint continuation and compaction. A transient `HumanMessage` carries the task context; it does not accumulate in checkpoint state or modify the system message. It wraps the budget observer, so the injected data contributes to the model reservation. The same task context accompanies harness subagent model calls.
