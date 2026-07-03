# Roc Context Management Design

## Goal

Roc needs a complete context-management loop for long DeepAgents runs across chat, task workbench/background runs, and Plan Mode. The loop should keep work moving when context grows large, preserve evidence before deleting or summarizing messages, and keep previous conclusions searchable.

The selected direction is a minimum viable closed loop:

1. persist large or soon-to-be-compacted context,
2. run deterministic compaction first,
3. use the current run model for active LLM summarization when deterministic compaction is not enough,
4. reinsert the summary as protected runtime context,
5. make the persisted transcript or artifact discoverable through Roc recall.

## Scope

In scope:

- DeepAgents runs started through the existing `AgentPluginRuntime -> createAgentDeepAgentExecutor() -> buildDeepAgent()` path.
- Normal chat, task workbench/background task runs, and Plan Mode.
- Runtime context maintenance for LangGraph `messages` before model calls.
- Persistence of compacted context artifacts and summary metadata.
- Session search recall for compacted context.
- Tests that prove the same context-management behavior is wired for chat, task/background, and Plan Mode.

Out of scope:

- A second agent runtime.
- Replacing DeepAgents built-in filesystem, planning, subagent, memory, or checkpointer semantics.
- Changing DeepAgents tool names or backend protocol.
- Rewriting `/workspace/` into shell paths. `/workspace/` remains a DeepAgents file-tool route; shell execution uses real Windows cwd.
- Treating summaries as authoritative recovery state.

## Native-First Rule

Roc must use DeepAgents and LangGraph native capabilities wherever they already cover the requirement:

- Use DeepAgents `createDeepAgent()` as the harness.
- Use DeepAgents built-in filesystem tools and routed backends for working memory.
- Use DeepAgents `StoreBackend`, `CompositeBackend`, and Roc's existing `RocStoreMemoryBackend` for long-term memory routing.
- Use LangGraph `thread_id` and Roc's SQLite checkpointer for graph state and interrupt/resume continuity.
- Use DeepAgents subagents for isolated context windows when delegation is the right model.
- Use LangChain `contextEditingMiddleware` for deterministic context edits, as Roc already does through `createForgeTieredCompactionMiddleware()`.

Roc should add custom code only for gaps not covered by the native stack:

- Persisting oversized tool results and compacted transcript artifacts into Roc-owned storage.
- Active LLM summarization of old runtime context.
- Mapping summaries into Roc's existing `forge:context_digest` format.
- Making compacted artifacts searchable through Roc session recall.
- Emitting Roc-specific context maintenance events.

If implementation discovery finds a DeepAgents or LangGraph native API that already provides one of these gap features in `deepagents@1.10.5` / `@langchain/langgraph@1.4.7`, the implementation must use that API instead of building a Roc replacement.

## Current State

Roc already has several pieces of the desired system:

- `assembleContextHarness()` builds the system prompt, selected tools, memory sources, skill sources, and workspace identity.
- `buildPromptBlocks()` emits stable prompt blocks with type, stability, and hash markers.
- DeepAgents native cache breakpoint middleware handles Anthropic cache-control injection; Roc keeps prompt block markers as a prefix-stability contract and leaves provider-specific caching to the native runtime.
- `createForgeTieredCompactionMiddleware()` performs deterministic context editing through LangChain middleware.
- `refreshContextDigestMessage()` can preserve key facts, decisions, touched files, verification, open questions, and next actions before older messages are dropped.
- `RocSqliteCheckpointer` persists LangGraph checkpoints by `thread_id`.
- `AgentToolEffectStore` keeps side-effecting tool results reusable during retries.
- `AgentSessionRepository` already supports `session_messages.phase = 'pre_compaction_flush'`, but the current runtime does not appear to use it as a compaction transcript flush.
- `session_search` provides workspace-scoped recall over persisted session messages.

The missing closed-loop parts are large-result artifact persistence, active LLM summarization, summary insertion policy, search integration for compacted artifacts, and observability.

## Architecture

Add a Roc-owned context compaction pipeline around the existing DeepAgents middleware stack. The pipeline should remain inside the current executor path and should not change how runs are created, resumed, or recovered.

Proposed components:

- `ContextCompactionPipeline`
  - Orchestrates the stages.
  - Runs before model calls through middleware.
  - Preserves tool-call/tool-result pairing.
  - Emits context maintenance events.

- `ToolResultPersistence`
  - Finds large old `ToolMessage` content or cumulative tool-result overload.
  - Stores full content in Roc-owned persistence.
  - Replaces runtime content with a compact reference containing `artifactId`, `sha256`, `preview`, `originalChars`, and `retrievalHint`.

- `ContextTranscriptStore`
  - Stores pre-compaction transcripts, summaries, and artifact indexes.
  - Can use `session_messages.phase = 'pre_compaction_flush'` for compact searchable records, or a dedicated table if full artifacts should not be mixed with user-visible transcript rows.
  - Must preserve workspace hash and thread/run identity.

- `LlmContextSummarizer`
  - Uses the current run's model handle.
  - Summarizes only older context selected by the pipeline.
  - Produces structured summary content.
  - Retries invalid summary format once.

- `ContextDigestMessage`
  - Reuses the existing `forge:context_digest` message type.
  - Inserts or updates a protected digest message after the system prompt or at the earliest safe runtime position.
  - Never overwrites control-flow state.

## Data Flow

Each model call sees a fixed stage order.

### 1. Tool Result Budget

The pipeline scans older `ToolMessage` instances. It persists full content when a single tool result or total eligible tool-result content crosses configured thresholds.

Runtime replacement includes:

```text
<roc_context_artifact>
artifactId: ...
sha256: ...
originalChars: ...
preview:
...
retrievalHint: use session_search or artifact lookup if exact old output is needed
</roc_context_artifact>
```

The replacement is a tool result, not a user-visible claim. The hash lets tests and future diagnostics prove the persisted content matches the compact runtime reference.

### 2. Deterministic Compaction

Roc keeps `createForgeTieredCompactionMiddleware()` as the deterministic compaction layer:

- Phase 1 drops old forge nudges and truncates old tool results.
- Phase 2 drops old normal tool results while preserving tool-resolution soft errors.
- Phase 3 drops old reasoning and bare assistant text while preserving tool-call AI messages.

Before deletion, the pipeline refreshes the context digest and flushes enough transcript data for later recall. The existing iteration tracking remains the anchor for "old" versus "recent" context.

### 3. Active LLM Summary

If deterministic compaction leaves context above the summary threshold, Roc calls the current run model to summarize old context.

The summary input contains only:

- the old message window selected for summarization,
- artifact previews and hashes,
- current goal,
- user constraints,
- workspace identity,
- recent complete messages needed for continuity.

The expected output is structured and must include:

- `goal`
- `facts`
- `decisions`
- `filesTouched`
- `toolEvidence`
- `verification`
- `openQuestions`
- `nextActions`

Invalid output triggers one corrective retry with the same model. Roc does not guess missing fields.

### 4. Digest Reinsertion

The valid summary is converted into a `forge:context_digest` message. The summarized window can then be deleted from the runtime message state if doing so preserves safe message boundaries.

The pipeline must preserve:

- system prompt,
- initial user input,
- current user turn,
- recent N iterations,
- complete `AIMessage.tool_calls` and matching `ToolMessage` boundaries.

If no safe boundary exists, the pipeline shrinks the summarized window rather than deleting through a tool boundary.

### 5. Recall

Compacted context must remain discoverable:

- normal user and assistant messages stay visible,
- summary/transcript index records use `pre_compaction_flush`,
- workspace-scoped records retain workspace hash,
- `session_search` can return compact snippets for old compacted context.

Full artifacts may require a future read API if they are too large for `session_search`. The first implementation should at least make the summary and artifact index searchable.

## Prompt Caching

The pipeline must not modify `buildPromptBlocks()` output during runtime summarization.

Stable system prompt blocks remain ordered as:

- `static`
- `workspace`
- `tools`
- `capability`
- `explicit_skills` when present
- `context_recall`
- `plan_mode` when present
- `workflow`

LLM summaries enter dynamic message state, not the serialized system prompt. This keeps prompt caching stable and avoids invalidating the static prefix every time context is compacted.

## Error Handling

### Persistence Failure

If Roc cannot persist a tool result or transcript that it is about to compact, the run fails with a hard `context_persist_failed` diagnostic. Continuing would delete evidence without a recovery path.

### Deterministic Compaction Failure

Deterministic compaction failure is a bug or invalid runtime state. The run fails loudly rather than silently continuing with corrupted context.

### Summary Failure

If summarization fails while context is still under the hard model limit, Roc keeps the deterministic-compacted state and emits `context_summary_skipped`.

If summarization is required because the prompt is over the hard threshold or the provider reports `prompt_too_long`, Roc performs one reactive summarization attempt. If that also fails, the run fails with `context_summary_failed`.

### Invalid Summary Shape

Invalid structured summary output gets one corrective retry. A second invalid result is treated as `context_summary_failed`.

### State Conflict

Summary content cannot override:

- `thread_id`
- `run_id`
- `workspacePath`
- `enabledCapabilities`
- checkpointer state
- pending interrupts
- tool effect idempotency state

Those remain authoritative runtime state outside message history.

## Plan Mode

Plan Mode uses the same pipeline. Internal context maintenance may persist transcripts and create summaries, but model-visible mutation tools remain blocked by the existing Plan Mode tool exposure and runtime guards.

Failure messages should identify context maintenance as an internal runtime operation, not as a user-file write.

## Events

Emit events for observability and tests:

- `context_compaction_started`
- `context_tool_result_persisted`
- `context_deterministic_compacted`
- `context_summary_started`
- `context_summary_completed`
- `context_summary_skipped`
- `context_compaction_failed`

Events should include run ID, thread ID, stage, removed or persisted character counts, and whether the operation ran in chat, task/background, or Plan Mode. They should not include full large tool output.

## Testing

Add focused tests before implementation where practical.

### Unit Tests

- `ContextCompactionPipeline` preserves the order: persist large tool results, deterministic compaction, then LLM summary.
- Tool result persistence replaces large content with artifact metadata and can read the full content back.
- Hash mismatch between artifact reference and stored content is a hard error.
- Tool-call/tool-result pairing is never broken.
- Summary schema accepts valid output, retries invalid output once, and fails on the second invalid output.
- Digest insertion updates `forge:context_digest` without deleting protected recent messages.

### Integration Tests

- `buildDeepAgent()` wires the context pipeline in the existing middleware chain without removing DeepAgents native middleware or Roc guardrails.
- Chat, task/background, and Plan Mode all pass through the same pipeline.
- Plan Mode still hides or blocks mutation tools.
- `session_search` can find `pre_compaction_flush` summary/index records with current workspace scope.
- Prompt block serialization and hash stability are unchanged by runtime summary insertion.

### Verification Commands

Targeted tests first:

```powershell
pnpm test -- tests/main/services/forge-guardrails/middleware/forge-tiered-compaction.test.ts tests/main/services/forge-guardrails/context-digest.test.ts
pnpm test -- tests/main/plugins/agent/session-repository.test.ts tests/main/services/deep-agent/context/session-search-tool.test.ts
```

Then run new context-management tests added by the implementation plan.

Broader checks when implementation touches shared types or runtime wiring:

```powershell
pnpm typecheck
git diff --check
```

## Acceptance Criteria

- DeepAgents and LangGraph native persistence, backend, subagent, and middleware semantics remain the foundation.
- Roc custom code only fills missing context-management gaps.
- Long runs compact in cheap-first order.
- Active LLM summarization uses the current run model and never runs before deterministic stages.
- Summaries are traceable to persisted transcript or artifact references.
- Summaries do not overwrite runtime authority.
- Chat, task/background, and Plan Mode use one shared pipeline.
- Prompt caching stable prefix remains unchanged by summarization.
- Tests prove safe boundaries, persistence, summary validation, recall, and wiring.
