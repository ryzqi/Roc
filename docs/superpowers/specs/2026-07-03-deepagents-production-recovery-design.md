# DeepAgents Production Recovery Design

## Goal

Roc must tolerate provider network fluctuation, renderer disconnects, and scheduled background task interruptions without losing agent state or repeating unsafe side effects. Recovery must use DeepAgents and LangGraph native semantics first: durable checkpointing, stable `thread_id`, `Command` resume, state history, Store-backed memory, and existing DeepAgents middleware.

## Scope

This design covers chat runs, task detail follow-up runs, and scheduled background task runs. All three continue through the existing `AgentPluginRuntime` and DeepAgents executor. The implementation must not create a second agent runtime for background tasks, must not rely on prompt wording for reliability, and must not treat DeepAgents virtual `/workspace/` paths as shell working directories.

## Current State

Roc already uses `deepagents@1.10.5` and `@langchain/langgraph@1.4.7`. The DeepAgents harness is assembled in `src/main/services/deep-agent/agent-builder.ts`, and the executor calls `agent.streamEvents()` from `src/main/plugins/agent/deep-agent-executor.ts`.

The current executor creates a `MemorySaver`, passes `thread_id` and `run_id` to `streamEvents()`, and passes a `RocSqliteStore` for long-term memory. This means long-term memory is persistent, but graph checkpoints are not durable across process restarts. When stream consumption throws, the event queue fails, `AgentPluginRuntime` catches the error, and the run is marked failed. Existing `toRunFailure()` can classify provider network errors, but the runtime currently uses a generic `agent_run_failed` event.

## Design Principles

- Use DeepAgents and LangGraph native state semantics before adding Roc supervision.
- Keep one runtime path for chat, workbench task runs, and background scheduled runs.
- Recover only transient provider failures. Contract, schema, permission, cancellation, and user-decision errors must fail clearly.
- Never repeat completed side-effecting tools during recovery.
- Preserve existing main/preload/renderer/shared boundaries.
- Add production persistence, observability, and migration support from the start.

## Architecture

### Durable Checkpointer

Add a Roc-owned SQLite-backed LangGraph checkpointer and inject it into `createAgentDeepAgentExecutor()`, replacing `MemorySaver`. The checkpointer uses the core database, not plugin-local in-memory state. Its schema is separate from the existing `langgraph_store_items` table used by `RocSqliteStore`.

Checkpoint keys must follow LangGraph semantics and must be scoped by the configurable `thread_id`. Roc continues to pass:

- `thread_id`: task thread id
- `run_id`: task run id

Recovering a transient failure reuses the same `thread_id` and `run_id`. Creating a new user submission creates a new run.

### Runtime Recovery State

`AgentPluginRuntime` gets a recovery state machine:

- `running`
- `recovering`
- `waiting_user`
- `completed`
- `failed`

Only these failure classes enter `recovering`:

- `provider_network_error`
- `provider_request_timeout`
- HTTP `408`, `425`, `429`, and `5xx`

All other errors fail immediately. User cancellation aborts recovery and records cancellation, not failure.

Recovery emits structured events:

- `run_recovering`
- `run_recovered`
- final `run_failed` only after recovery is exhausted

The default recovery budget is five attempts per run and ten minutes maximum wall-clock recovery time. Attempts use bounded exponential backoff with jitter and honor the run `AbortSignal`.

### DeepAgents Resume

On recoverable stream failure, Roc re-enters DeepAgents with the same config and resumes from the latest checkpoint using LangGraph state continuation. Before implementation, verify the actual `deepagents@1.10.5` TypeScript API and record the supported continuation call shape in tests. Valid continuation mechanisms are limited to the API-supported checkpoint resume path, such as `null` state continuation, `Command`, or checkpoint config. The implementation must not fake continuation by rebuilding a full prompt and rerunning from scratch.

If checkpoint read or write fails, the run transitions to `failed` with `agent_checkpoint_unavailable`. Roc must not automatically rerun a side-effecting run without checkpoint safety.

### Tool Effect Idempotency

Add `agent_tool_effects` for side-effecting tool execution records:

- `run_id`
- `thread_id`
- `tool_call_id`
- `tool_name`
- `input_hash`
- `status`
- `result_json`
- `error_json`
- `created_at`
- `updated_at`

Read-only tools may retry normally. Read-only examples include `web_read`, `web_search`, `read_file`, `grep`, `glob`, and `ls`. Side-effecting tools require idempotency. These include `write_file`, `edit_file`, `delete_file`, `run_shell_command`, `shell.execute`, background task create/update/cancel tools, and MCP tools without explicit read-only metadata.

Execution rules:

- Existing successful record with same key and hash returns stored result.
- Existing in-progress record blocks duplicate execution and reports a controlled conflict.
- Same `tool_call_id` with different input hash fails as input drift.
- Unknown shell result status becomes `unknown` and requires user action before resuming.

This idempotency layer belongs at Roc tool adapter boundaries, not in prompts.

### IPC Event Replay

Persist every `agent.chat.run-event` with a per-run `sequence`. Add IPC:

- `chat.getRunEvents({ runId, afterSequence })`
- `chat.getActiveRun({ threadId })`

Renderer state uses replay and live events through the same reducer. `useChatRun()` maintains `lastSequenceByRunId`, deduplicates `runId + sequence`, and fetches missing events when it mounts, reloads, or switches thread.

Renderer disconnect does not cancel main-process runs. If replay fails, UI may rebuild a read-only transcript from persisted task/thread events, but it must not claim live recovery succeeded.

### Background Task Recovery

Scheduled background tasks use the same runtime recovery state machine. A transient provider failure during a scheduled run does not immediately pause the task. The run enters `recovering` and resumes with the saved task `workspacePath`, `enabledCapabilities`, selected MCP servers, selected skills, memory, and shell cwd rules.

Recovery exhaustion records the scheduled run as failed and updates `lastRunStatus`. Existing pause-or-continue policy applies only after exhaustion, not during transient recovery.

## Data Model

The implementation adds repeatable SQLite migrations for:

- LangGraph checkpoint tables
- agent run event log with `run_id`, `sequence`, payload JSON, and timestamps
- agent tool effect idempotency table
- recovery attempt metadata with `run_id`, attempt count, last error code, and timestamps

Migrations must be idempotent. They must not rewrite existing `task_threads`, `task_runs`, `task_events`, or `session_messages` rows except through existing runtime status transitions.

## Observability

Add metrics and structured logs:

- `agent.run.recovery.started`
- `agent.run.recovery.succeeded`
- `agent.run.recovery.exhausted`
- `agent.tool_effect.reused`
- `agent.ipc.replay.events`
- `agent.checkpoint.error`

Log fields may include `runId`, `threadId`, `providerId`, `modelId`, `errorCode`, `attempt`, `durationMs`, and `source`. Logs must not include secrets, API keys, full prompts, image data, or sensitive tool output.

## Error Handling

Provider transient errors become recovery attempts. Non-transient errors fail with structured codes from `toRunFailure()`. Checkpoint failures produce `agent_checkpoint_unavailable`. Event replay failures produce UI-level sync errors without cancelling main-process runs. Tool idempotency drift produces `agent_tool_effect_input_drift`.

The renderer shows `recovering` without clearing partial assistant content. It shows `recovered` only after live events continue or final completion arrives. It shows `failed` only after exhaustion or non-recoverable failure.

## Production Constraints

- Recovery must survive renderer reloads.
- Recovery must handle app restart by detecting unfinished runs and either safely resuming from checkpoint or failing clearly.
- SQLite writes must be transactional for checkpoint, event log, and tool effect state where correctness depends on ordering.
- Recovery must honor user cancel immediately.
- No compatibility aliases, hidden fallback agents, or prompt-only guardrails.
- All command examples and diagnostics must respect Windows/PowerShell paths.

## Testing Strategy

Unit tests:

- transient provider errors map to recovery instead of immediate `run_failed`
- non-transient errors fail immediately
- recovery emits `run_recovering` and `run_recovered`
- recovery exhaustion emits final `run_failed`
- SQLite checkpointer persists and reloads state by `thread_id`
- side-effecting tool result is reused on retry
- input hash drift fails
- IPC replay deduplicates sequence events

Integration tests:

- DeepAgent stream throws `Connection error` after partial text; retry resumes and preserves partial output
- renderer reload replays missing events and continues live stream
- shell command succeeds then stream fails; recovery does not execute shell twice
- background scheduled run keeps workspace, skills, MCP, and memory context during recovery
- app restart with unfinished recovering run follows checkpoint-safe behavior

Verification commands:

```powershell
pnpm test -- tests/main/plugins/agent/runtime.test.ts tests/main/plugins/agent/deep-agent-executor.test.ts tests/main/deep-agent-error-mapping.test.ts tests/renderer/use-chat-run.test.ts
pnpm typecheck
pnpm check:ipc
git diff --check
```

Broader verification after implementation touches persistence and IPC:

```powershell
pnpm build
pnpm test
```

## Rollout Plan

1. Add persistence schemas and checkpointer behind the existing executor path.
2. Replace `MemorySaver` with durable checkpointer and prove current tests still pass.
3. Add structured error classification to runtime failure handling.
4. Add recovery state machine and recovery events.
5. Add tool effect idempotency at side-effecting tool adapters.
6. Add event log, IPC replay, renderer dedupe, and UI recovery states.
7. Extend background task run handling to share the same recovery path.
8. Run targeted tests, typecheck, IPC check, build, and full test suite.

## Out Of Scope

- Switching to managed hosted Deep Agents.
- Replacing Roc's SQLite storage with Postgres.
- Changing model provider configuration UX.
- Reworking task board UI beyond recovery state display.
- Changing DeepAgents filesystem path contract or shell cwd semantics.
