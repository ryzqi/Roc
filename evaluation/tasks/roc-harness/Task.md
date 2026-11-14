# Roc harness lifecycle and tool effects

Status: Draft; agent-reviewed, unreviewed by the user.

## Purpose and source evidence

Evaluate Roc's agent harness independently of model answer quality. The subject is
the production `AgentPluginRuntime`, `createAgentDeepAgentExecutor`, Deep Agents
graph, manifest guards, approval middleware, usage ledger, atomic filesystem
backend and SQLite checkpointer. No executor or product tool is mocked.

The previous native suite mixes service contracts and synthetic `pilot_action`
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

## Environment, visibility and reset

Native macOS and the installed Node/pnpm dependencies are required. Each trial
runs in a separate `sandbox-exec` process group with a private agent database,
memory database, state directory and workspace. Only stdio connects it to the
controller. Network access is denied. A protected evaluator file must fail a
read probe before the agent starts.

The worker bundle includes production code and fault injection, never this spec,
the case catalog, verifier or tests. The agent sees the prompt, selected tool
schemas, initial files, previous messages and tool results. It cannot read the
controller's truth or other trials. Fault injection subclasses the production
effect store only to exit at a specified boundary; normal store operations still
run. These deliberate exits use code 73, without graceful shutdown. Recovery
starts a new process against the same trial database.

Isolation is by replacement, not reset of a shared service. The controller reaps
every process group and removes the dependency symlink before sealing evidence.
It retains a SQLite backup at the crash boundary and the final database.
Production differences: controlled model, narrowed tools, no Electron UI,
configured model host, external MCP services or remote effects.

## Independent verifier and scoring

The verifier imports no production runtime or effect-store methods. It reads
SQLite through a read-only connection, hashes raw workspace bytes, and inspects
controller transcripts and process records.

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

Each trial reports every criterion, `passed` or `failed`, and evidence references.
`scenarioPassRate` and dimension pass rates are diagnostic. One failed criterion
fails its trial and the harness acceptance gate; an average cannot override it.
Missing/corrupt evidence, setup, transport, timeout, source drift, unexpected
process exit or cleanup failure makes a trial/run invalid and the gate
`incomplete`, not an agent capability score. A missing runtime boundary after a
normal completed run is a harness failure.

`smoke` runs recovery, unknown-effect blocking and rejection once. `fast` runs
all ten cases once. `full` runs all ten three times. `--task` selects one case for
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
Mutation checks use copies of evaluator-owned trial evidence, never the sealed
original or product data.

These cases measure deterministic harness behavior under specified faults.
They do not measure model tool selection, scientific quality, prompt-injection
resistance, cross-session memory quality or general agent capability. QASPER,
production RAG component/E2E tasks and verified ScienceAgentBench have separate
Task Specs and independent evidence. Offline `pnpm evaluate check` seals
engineering/readiness audits, with regressionAcceptance=not_evaluated; it does
not establish a retrieval threshold or model-quality pass. Future
context, child-agent and external-effect tasks need their own independent
environment and spec.

## Assumptions and open decisions

- Default emphasis is the harness acceptance gate; no paid model run is
  authorized or needed for this implementation.
- Preserve recent real benchmark evidence while removing repeated fixture
  products and obsolete setup failures.
- The task and accompanying Roc world-knowledge changes remain Draft until
  explicitly reviewed by the user.
- Fixture, controlled-model and synthetic ten-question × three-repeat evidence
  cannot establish quality, an independently reviewed dataset or holdout
  approval. Statistical experiments do not replace this per-criterion gate.
