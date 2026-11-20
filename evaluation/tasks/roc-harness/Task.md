# Roc harness lifecycle and tool effects

Status: Draft; agent-reviewed, unreviewed by the user.

Implementation scope: 22 distinct production-runtime scenarios in 13 dimensions.
Runtime acceptance requires actual runs against frozen source and independent
regrading of complete raw evidence. Record exact commands, exit codes, logs and
source identity for each new run; see the [validation methods](../../README.md#验证方法).
Catalog entries and static checks alone do not establish a passing runtime gate.

## Purpose and source evidence

Evaluate Roc's agent harness independently of model answer quality. The subject is
the production `AgentPluginRuntime`, `createAgentDeepAgentExecutor`, Deep Agents
graph, manifest guards, approval middleware, usage ledger, atomic filesystem
backend and SQLite checkpointer. No executor or product tool is mocked.
The expansion also exercises the production trusted-host approval broker,
memory StoreBackend/SQLite store, child-agent graph, context artifact compaction
and MCP client adapter.

The supplementary native suite mixes service contracts and synthetic `pilot_action`
tasks. Its aggregate pass rate does not establish production run recovery.
`tests/unit/agent-cold-resume.test.mjs` establishes a model-request recovery seam;
the tool-effect middleware and atomic filesystem backend supply three additional
fault boundaries that require an actual graph restart.

## Input and relevant harness conditions

`evaluation/lib/harness-cases.mjs` contains the exact visible prompts, initial
files and controlled model responses. Each case uses a fresh trusted local
workspace and the production compiler's narrowed file-tool manifest. The model
is `roc-harness-scripted`, temperature 0, context capacity 65,536 and maximum
output 512 tokens. Its OpenAI-compatible responses cross stdio into the real
LangChain model adapter; no configured provider, credentials or inference
service is used.

The controller supplies one of these finite sequences. Requests, responses and
all runtime events are retained. Recovery uses the original run and thread.

| Case | Agent input and disturbance | Required result |
|---|---|---|
| `cold-model-resume` | Return a completion; terminate the worker with a model request pending | Resume the same checkpoint; freeze inputs; old reservation becomes unknown and the new call settles |
| `tool-before-dispatch` | Write `/workspace/result.txt`; exit after effect reservation and before dispatch | Recover the reserved operation under a new lease; publish exactly once |
| `tool-result-replay` | Same write; exit after the result receipt is stored, before graph checkpoint advancement | Replay the stored tool result; no second dispatch, reservation or publication |
| `tool-receipt-unknown` | Same write; exit after the durable filesystem receipt, before result storage | Preserve the file; mark the effect unknown; block unattended checkpoint resume |
| `approval-reject` | Delete `/workspace/keep.txt`; the human rejects | A real graph interrupt precedes the decision; preserve the file; consume the decision once |
| `approval-approve` | Delete the same file; the human approves | Interrupt first; delete only after approval; clear the pending approval |
| `cancel-model` | A model request remains pending; the host requests cancellation | Cancel the real run and model signal, retain unknown usage, prevent further work |
| `parallel-edits` | Two tool calls change separate lines in the same file | Both changes survive; distinct operations and receipts; no partial or collateral writes |
| `denied-tool` | Read-only manifest; controlled model attempts `write_file` | Surface the unavailable tool, preserve the workspace and create no mutation effect |
| `tool-loop` | Repeat the same read with fresh call IDs and unchanged results | Stop with `tool_call_loop_detected` within four requests; no infinite graph loop |
| `approval-expired` | Approve a real trusted-host command, then advance the broker's injected clock past its 30-second TTL | Persist the expired approval with its original binding; issue no execution grant and run no command |
| `permission-change` | Read a source, then remove workspace write permission before the next model response | Surface the real filesystem permission error; publish no result file; retain the observed permission change and restore permissions for cleanup |
| `workspace-replaced` | Read a source, then replace the directory at the pinned workspace path | Reject the changed directory identity before publication; preserve both independently inventoried workspaces |
| `concurrent-edit-conflict` | Submit two edits replacing the same old string with `FIRST` and `SECOND` | Exactly one edit succeeds and its receipt matches the surviving bytes; the other reports a conflict or absent precondition; preserve the unrelated line |
| `source-updated` | Read revision one, then the host writes revision two before the stale edit | Reject the old-string precondition and re-read revision two; preserve the fresh bytes without a stale write |
| `memory-db-error` | Seed `/memory/global/MEMORY.md` through the real StoreBackend, then abort SQLite inserts and updates during an edit | Observe a real persistence error, preserve the seeded memory row and produce no successful saved-memory result |
| `budget-stop` | Admit one model request to an evaluator BudgetController; reject the next admission | Cancel the actual run/model signal; retain the budget rejection and unknown usage; dispatch no second model response or write |
| `subagent-cancel` | Delegate a real `general-purpose` child; cancel while its first model request is pending | Bind the child ledger, scoped tool schemas and lifecycle to the delegation; propagate cancellation without a completed child result or later work |
| `subagent-error` | Delegate the same real child; its first request receives HTTP 503 through the model adapter | Persist and project the child failure; retain the actual transport error and prevent acceptance of an unreturned child result |
| `mcp-disconnect` | The production MCP client calls a local JSON-RPC stdio peer which exits on `tools/call` | Bind discovery/schema and call arguments to raw wire evidence; observe disconnect, no success reply and no remote effect |
| `mcp-receipt-lost` | The local peer fsyncs external bytes but withholds its reply; terminate the worker after independently observing the durable effect | Preserve the external bytes; keep the operation uncertain without a fabricated provider receipt; block unattended resume and avoid a second call |
| `context-compaction-crash` | Observe every line of a large real file with production `grep`; terminate after the production compactor saves an artifact reference in a checkpoint | Retain raw SQLite artifact content and the hash-bound compacted ToolMessage; resume the original run without re-reading or duplicating the original tool operation |

Each case isolates a distinct fault or production path. Repeated prompts and
repeats do not count as additional scenarios.

## Environment, visibility and reset

Native macOS and the installed Node/pnpm dependencies are required. Each trial
runs in a separate `sandbox-exec` process group with a private agent database,
memory database, state directory and workspace. Only stdio connects it to the
controller. Network access is denied. A protected evaluator file must fail a
read probe before the agent starts.

The worker bundle includes production code and fault injection, never this spec,
the case catalog, verifier or tests. The agent sees the prompt, selected tool
schemas, initial files, previous messages and tool results. It cannot read the
controller's truth or other trials. Fault injection retains normal production
operations and exits only at the selected effect/checkpoint boundary. The memory
fault uses real aborting SQLite triggers. Workspace faults change actual OS
permissions, inode identity or file bytes after a model request demonstrates the
preceding read. Approval expiry advances only the broker's injected clock.
These deliberate worker exits use code 73, without graceful shutdown. Recovery
starts a new process against the same trial database.

MCP cases launch an actual local stdio server through the production MCP adapter.
Its discovery responses, incoming calls and outgoing replies are retained as raw
JSON-RPC lines with process identity. A lost reply is never represented as a
success receipt. The server's external effect is a private, fsynced file outside
the agent workspace, separately hashed by the worker and verifier.
Network access and paid inference remain absent.

Isolation is by replacement, not reset of a shared service. The controller reaps
every process group and removes the dependency symlink before sealing evidence.
It retains SQLite backups at crash/approval boundaries, the seeded memory
database before any model reply, and final agent, memory
and workspace databases, plus before/after workspace observations.
Production differences: controlled model, narrowed tools, no Electron UI,
configured model host or production external service. Local MCP protocol
effects use isolated evaluator-owned state.

## Independent verifier and scoring

The verifier imports no production runtime or effect-store methods. It reads
SQLite through a read-only connection, decodes complete checkpoint and write
blobs as data, hashes raw workspace/external bytes and SQLite artifact content, and inspects complete
controller transcripts, production run events and process records. Snapshot
JSON files and assistant assertions cannot substitute for the raw databases.

Every selected trial must meet all its criteria. Common criteria include an
actual run/checkpoint, the frozen model and manifest, a valid protected-file
probe, complete ordered transcripts, expected process exits, and confirmed
cleanup. Recovery criteria compare run/thread/snapshot identity across the
before/final databases. Effect criteria inspect status, lease generation,
attempt count, publication receipt sequence, independent receipt/result hashes
and actual file bytes. Tool parameter hashes use the public canonical
`{args, name}` contract and must bind persisted effects/reservations to the
actual controlled responses. Usage receipts must bind call/run/state/tokens
and their hash; startup-reconciled reservations can remain unknown without a
settlement receipt. Approval and cancellation criteria require observed events
as well as final persisted state. An extra file is a collateral failure.
Assistant assertions alone never earn credit.

Every observed model request has exactly one hash-bound response or scheduled
host action (interrupt, cancellation or HTTP error), with an ordered request
index and unique correlation identity. Child requests must be justified by a
real child ledger/lifecycle and their scoped production schemas. Trusted
approval evidence includes raw approval/grant rows and clock/decision bindings.
Every persisted run event must have exactly one transport observation in raw
SQLite sequence order, with its actual sequence and timestamp from the
production event-log API. The complete EventBus stream is retained separately
and bound to every live persisted event. Failed/cancelled transactions persist
the terminal row before task acceptance; their notifications publish acceptance
before the terminal event. Both actual orders are verified independently.
Startup reconciliation events are read through the
production event-log API; their sequence, timestamp and checkpoint boundary
are independently matched to the before/final databases.
Memory evidence compares the complete seeded and final store rows, timestamps,
MIME and installed abort triggers.
Compaction evidence includes checkpoint constructors parsed without executing
them, raw SQLite artifact content and retained original tool-result hashes. The
UI projection and model checkpoint artifacts are separately bound by their
actual event/reference IDs; every original artifact byte is verified.
The production compactor persists string tool results; installed Deep Agents
`read_file` emits text blocks, so this case uses the actual string-valued `grep`
result rather than converting or fabricating a ToolMessage. A child wrapper's
completed lifecycle event is not a successful child outcome: error propagation
requires the failed durable child settlement, the original error ToolMessage
hash and its presence in the parent's next actual model request. Cancellation
requires the real aborted request and a failed unknown child settlement.
MCP evidence
binds the frozen discovered contract to `tools/list`, `tools/call`, the absence
of a call reply, actual external state and post-recovery ledger state.

Each trial reports every criterion, `passed` or `failed`, and evidence references.
`scenarioPassRate` and dimension pass rates are diagnostic. One failed criterion
fails its trial and the harness acceptance gate; an average cannot override it.
Missing/corrupt evidence, setup, transport, timeout, source drift, unexpected
process exit or cleanup failure makes a trial/run invalid and the gate
`incomplete`, not an agent capability score. A missing runtime boundary after a
normal completed run is a harness failure.

`smoke` runs recovery, unknown-effect blocking and rejection once. `fast` runs
all 22 cases once. `full` runs all 22 three times (66 trials). `--task` selects one case for
diagnosis; its passing result establishes only that selected scope. There is no
controlled-model holdout or `release` profile.

Canonical commands are `pnpm evaluate run`, `pnpm evaluate run --profile full`
and `pnpm evaluate run --task CASE_ID`; `pnpm harness:bench` remains the same
CLI's compatibility alias. Trial scheduling defaults to concurrency=2 and can
be set to 1–8, with separate trial workspaces/databases and frozen executionPolicy.
The run retains a durable plan, sequenced journal, lifecycle states, scoped host
budget/usage, grade artifacts and evidence seal. Controlled receipts exercise
accounting; they are not inference resource measurements.

`pnpm evaluate run --resume UNSEALED_RUN` verifies unchanged source, manifest,
plan, journal prefix, budget ledger and a departed prior owner. It can verify
and regrade complete evidence after dispatch, but never blindly replays
uncertain dispatched work. Sealed runs, including gracefully sealed incomplete
runs, cannot be resumed. This run-level recovery is separate from the deliberate
production checkpoint restarts inside each fault-injection case.

## Verifier audit and fairness

Validate a complete run, a supported alternative final assistant response,
wrong file bytes, duplicate effect/dispatch evidence, incorrect tool inputs,
an extra collateral file, a forged success message, damaged deletion recovery
bytes, incorrectly bound unknown usage receipts, and missing/corrupt
SQLite/transcript/response evidence. Duplicate or missing trial identities
must not produce a complete gate.
Also audit the accepted alternate conflict winner, forged host actions,
tampered memory/approval/child rows, missing artifact content and invented MCP
replies. An alternative conflict winner is accepted only when the actual
successful tool call and durable receipt bind to that winner's bytes.
Mutation checks use copies of evaluator-owned trial evidence, never the sealed
original or product data.

These cases measure deterministic harness behavior under specified faults.
They do not measure model tool selection, scientific quality, prompt-injection
resistance, cross-session memory quality or general agent capability. QASPER,
production RAG component/E2E tasks and verified ScienceAgentBench have separate
Task Specs and independent evidence. Offline `pnpm evaluate check` seals
engineering/readiness audits, with regressionAcceptance=not_evaluated; it does
not establish a retrieval threshold or model-quality pass.

The memory case measures persistence failure, not cross-session recall or
semantic memory accuracy. Context recovery measures durable tool-result
compaction and availability of original evidence, not long-conversation fact
retention. Child cases measure real delegation, scoped execution and failure
propagation, not answer quality or multi-child result merging. The budget case
uses the evaluator's request admission API, not a product-wide quota. Source
freshness tests a filesystem edit precondition, not citation invalidation.
Approval expiry is the trusted-host broker TTL; file deletion approval has no
equivalent expiry API. MCP cases exercise a real local protocol peer; automatic
reconnect, remote receipt query/reconciliation and cross-session external
recovery are unavailable here and are not credited.

## Assumptions and open decisions

- Default emphasis is the harness acceptance gate; no paid model run is
  authorized or needed for this implementation.
- The task remains Draft until explicitly reviewed by the user.
- Run the complete harness against frozen application/runtime sources. Report
  tests and static checks separately from actual runtime acceptance.
- Fixture, controlled-model and synthetic evidence
  cannot establish quality, an independently reviewed dataset or holdout
  approval. Statistical experiments do not replace this per-criterion gate.
