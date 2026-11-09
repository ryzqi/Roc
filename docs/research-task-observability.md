# ResearchTask：任务事实、执行观测与离线诊断

`ResearchTask` diagnostics now connect the existing execution tree to persisted model-call observations, chat telemetry/replay and managed experiment resource receipts. The management drawer discloses these details on demand. Task ownership follows [ADR 0028](adr/0028-execution-task-ownership.md); these views use existing records and local diagnostics.

## Authoritative records

Agent DB migration 25 removes financial columns and quota tables. Calls and immutable model observations live in `agent_calls` and `agent_call_observations`, keyed by `(run_id, call_id)`. `RunUsageObserver.invoke()` records token measurements, ISO start time, measured duration and `completed`/`failed` outcome. Invalid receipts or inactive tasks prevent dispatch.

Duration covers serialization, dispatch and completion recording. A process that exits before recording the observation has no duration receipt; diagnostics return `invocation: null`. Missing token usage remains explicitly unknown and never stops later calls.

Runs and tasks have no cumulative token, monetary, call, child-task or duration quotas. Snapshot v11 retains only model context/output capacity. Migration rewrites old snapshots and replay records, verifies old hashes and recomputes hashes after deleting obsolete fields. Research migration 71 removes search-plan request quotas; an in-flight stage whose approved input hash changes must restart with fresh inputs. Cancellation, ownership, provider context capacity and resource queuing remain effective.

Call creation and completion times come from the ledger and `call_settled`/`call_unknown` events. Diagnostics and exports report token and call counts, with no prices, monetary totals or financial estimates.

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

Project/task/execution/call/tool-call/artifact identifiers are consistently pseudonymized with SHA256. Goals, fact text, actors, provider/model names, prompts, tool arguments/results, error text, absolute paths and replay snapshot state are structurally removed. Errors retain presence/status. Pseudonymization permits correlation and does not make the package anonymous: exact times, hashes and measurements remain.

After asynchronous source reads, the exporter rereads the task summary and rejects changes. A package larger than 2 MiB fails before file creation. The required diagnostics root comes from the main bootstrap's managed path; no fallback or caller-controlled directory is used. A random local JSON file is created exclusively with `wx` and mode `0600`. The receipt includes its path, exact byte size and SHA256, `redacted: true` and `externalTrace: not_exported`.

The export operation has no network path. External Trace export and real scientific/long-context acceptance remain unrun.

## Desktop behavior

The existing task execution tree uses native, initially closed `<details>` for observations. Opening or refreshing reads current persisted telemetry. Calls and replay have independent 50-row pages that replace the displayed page. Loading, failure, missing observations, unknown token usage and replay gaps are visible states. The export action prevents duplicate dispatch while pending and displays the real local receipt; late replies cannot populate another project/task panel.

## Task facts and context

Task facts are bounded, immutable revisions in the agent identity database (migration 18). Each entry stores a kind, content, lifecycle state and one to eight typed source references. Supported kinds are confirmed constraints, source versions, human decisions, unverified hypotheses, todos, counterevidence, evaluation conditions and user corrections. Facts are research data and never grant capabilities or replace approval.

`research.getTaskFacts`, `research.saveTaskFacts` and `research.getTaskFactsHistory` require explicit project/task identity. Saving requires the main process human context for `research.task.facts.save`; the actor comes from the submitting window, with no actor or approval fields on the wire. `expectedRevision` enforces optimistic concurrency. The store seals normalized snapshots, checks their SHA256 and physical task/revision identity, refuses updates, and retains old revisions when new entries correct or supersede them. Task deletion cascades.

Limits are 100 entries, 2,000 characters per content, eight references per entry and 32,000 serialized characters across entries. History pages contain at most 50 revisions. The management drawer supports user entries, explicit completion/replacement and the latest 50 history revisions. Full history remains available through the bounded cursor API. Failed saves preserve the draft; refresh reads the current revision.

Artifact references bind the inspector version. Documents bind the source SHA256 and committed parse identity. Execution references bind a task-owned execution and its manifest hash. Reads compare each reference to current state and explicitly report changed, unlinked or deleted sources without rewriting history. Active entries with expired references cannot be saved; completing or replacing them preserves their old reference. Storage corruption and scope mismatches fail.

Stage execution and retries reconstruct the task goal and latest facts from durable storage. The main assistant harness uses the read-only scoped `research.task.facts.forChat` capability before each model call, including checkpoint continuation and compaction. A transient `HumanMessage` carries the task context; it does not accumulate in checkpoint state or modify the system message. It wraps the usage observer, so the injected data contributes to model usage accounting. The same task context accompanies harness subagent model calls.
