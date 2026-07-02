# Context Engineering Optimization Design

## Goal

Optimize Roc context engineering in one phased design. The implementation order is fixed:

1. Phase A: stabilize current behavior.
2. Phase B: converge on native DeepAgents capabilities.
3. Phase C: improve long-running context retention.

The agent architecture stays on the existing `createDeepAgent` harness. Chat, Plan Mode, and background tasks must continue to share the same runtime path.

## Current Facts

- Roc uses `deepagents@1.10.5`, `langchain@1.5.1`, and `@langchain/langgraph@1.4.4`.
- `assembleContextHarness()` already centralizes prompt, tools, memory sources, skill sources, and workspace identity.
- `createBackend()` already routes `/workspace/`, `/skills/`, `/memory/global/`, and `/memory/workspaces/current/` through DeepAgents `CompositeBackend`, `FilesystemBackend`, and `StoreBackend`.
- `buildDeepAgent()` already passes native DeepAgents `memory`, `skills`, `backend`, `store`, `checkpointer`, `subagents`, and `interruptOn`.
- Roc currently disables DeepAgents built-in summarization because it writes to `/conversation_history`, which Roc does not route.
- Existing official-contract tests document that DeepAgents filesystem middleware exposes `execute`, read-only permissions do not hide write tools, and empty permissions are permissive. Roc safety guards must remain.

## Non-Goals

- Do not create a second agent runtime.
- Do not replace DeepAgents with raw LangGraph or a different framework.
- Do not change provider configuration, task workbench UI, or background task user workflows.
- Do not remove Roc Windows path safety, shell path guard, selected skill access control, memory security scan, memory capacity checks, or Plan Mode read-only controls.
- Do not rely on prompt text for filesystem, shell, or permission enforcement.

## Responsibility Boundary

DeepAgents should own:

- `memory` as always-on file context.
- `skills` as progressive, on-demand skill directories.
- `CompositeBackend`, `StoreBackend`, and `FilesystemBackend` routing.
- `thread_id` and `checkpointer` for short-term graph state and HITL resume.
- General-purpose subagent behavior and native `task` delegation.
- Native filesystem tool names and protocol where Roc does not need a product-specific guard.

Roc should own:

- Windows workspace identity and `/workspace/` virtual route mapping.
- Shell command path policy and real Windows `cwd` enforcement.
- Selected skills ACL under `/skills/`.
- Memory security scan and capacity policy.
- Plan Mode read-only behavior and model-visible tool filtering.
- Tool protocol repair, error mapping, and product-specific streaming/projection.
- Context digest only where DeepAgents native summarization cannot be used safely with Roc routes.

## Phase A: Stabilize Current Behavior

### Prompt Caching

Change prompt caching from "cache every non-request block" to a provider-safe breakpoint strategy:

- Anthropic-compatible providers receive at most four cache control markers.
- Stable blocks are prioritized in this order: `static`, `workspace`, `capability`.
- `REQUEST` blocks are never cached.
- Highly variable tool listings should not consume cache markers unless there are unused slots.
- Unknown providers use the OpenAI-style no-op strategy and receive no provider-specific fields.

Failure behavior stays non-blocking. If cache injection fails, Roc sends the original request. Detailed diagnostics should stay behind `DEBUG=roc:prompt-caching`.

### Explicit Skills

Use DeepAgents native `skills: ['/skills/']` as the primary loading path. When `explicitSkillIds` are selected, prompt context should include only a compact index:

- skill name
- virtual path
- instruction to read `/skills/<id>/SKILL.md` when needed

Do not inject full `SKILL.md` content into the system prompt by default. Keep current fail-fast validation for missing, disabled, or invalid explicit skills.

### Automatic Memory Writes

Keep automatic memory writes as best-effort. Improve duplicate suppression by normalizing summary text, not only full bullet text with run id.

The writer should skip duplicates in the same target memory file even when the run id differs. Security scan failures and capacity overflow continue to warn and skip without failing the completed run.

## Phase B: Converge On Native DeepAgents

Reduce custom context behavior where DeepAgents already has a stable native contract.

### Prompt Text

Trim prompt text that restates backend internals. Keep only model-actionable rules:

- where memory files live
- which virtual routes exist
- when to read skills
- Plan Mode mutation limits
- verification expectations after file edits

Do not remove safety rules that the model needs to choose the right tool or path.

### Backend And Memory

Keep Roc's backend as a policy wrapper around native DeepAgents backends:

- `/workspace/` remains a `FilesystemBackend` rooted at the selected workspace with `virtualMode: true`.
- `/skills/` remains a read-only `FilesystemBackend` with selected skill filtering.
- `/memory/global/` and `/memory/workspaces/current/` remain `StoreBackend` routes backed by Roc SQLite.
- `RocStoreMemoryBackend` remains for whitelist, capacity, and security scan.

Do not implement a parallel memory system outside DeepAgents `memory` and `StoreBackend`.

### Subagents

Keep general-purpose subagent configuration aligned with native DeepAgents behavior. In Plan Mode, explicitly pass skill sources to the general-purpose subagent because custom subagents do not inherit skills automatically.

Avoid adding stateful custom subagents unless a future requirement needs cross-invocation subagent memory.

### Contract Tests

Extend official-contract tests only for assumptions Roc depends on:

- native skills are directory-based and need a backend route
- subagent skill inheritance remains explicit for custom subagents
- filesystem permissions do not replace Roc path guards
- `thread_id` remains required for checkpoint continuity and HITL resume

## Phase C: Improve Long-Running Context

Current tiered compaction deletes old noise but can lose old conclusions. Add a thread-scoped Roc context digest before destructive compaction.

### RocContextDigest

The digest is thread-scoped runtime context, not long-term memory. It must not write to `/memory/.../MEMORY.md`.

Digest fields:

- `facts`: confirmed facts learned during the run
- `decisions`: design or implementation decisions already made
- `filesTouched`: files inspected or changed when known
- `verifications`: commands, tests, and observed results
- `openQuestions`: unresolved user or implementation questions
- `nextActions`: concrete remaining steps

### Digest Source

Use deterministic extraction first:

- assistant text
- known tool call names and outputs
- verification command events
- iteration metadata

Do not add an extra model summarization call in this design. Model-generated digest can be considered later only if deterministic extraction is insufficient.

### Compaction Order

Long-running compaction should run in this order:

1. Preserve or refresh `RocContextDigest` for old eligible iterations.
2. Truncate old tool results.
3. Drop old tool results.
4. Drop old reasoning and non-tool AI text.

The digest must be protected from the deletion passes. If digest generation fails, compaction falls back to the existing deletion strategy and does not block the run.

## Error Handling

- Prompt caching errors degrade to original request.
- Unknown provider cache strategy is no-op.
- Explicit skill validation remains fail-fast.
- Memory auto-write never fails run completion.
- Context digest generation failure never blocks the agent run.
- Existing filesystem and shell guard failures remain explicit and user-visible.

## Testing

Phase A target tests:

- `tests/main/services/forge-guardrails/middleware/prompt-caching.test.ts`
- `tests/main/services/deep-agent/context/context-assembler.test.ts`
- `tests/main/services/deep-agent/context/prompt-blocks.test.ts`
- `tests/main/services/deep-agent/context/memory-promotion.test.ts`
- `tests/main/plugins/memory/plugin.test.ts`

Phase B target tests:

- `tests/main/services/deep-agent/deep-agent-official-contracts.test.ts`
- `tests/main/services/deep-agent/backend.test.ts`
- `tests/main/deep-agent/store-memory-backend.test.ts`
- `tests/main/deep-agent-build-wiring.test.ts`
- `tests/main/plugins/agent/deep-agent-executor.test.ts`

Phase C target tests:

- `tests/main/services/forge-guardrails/middleware/forge-tiered-compaction.test.ts`
- `tests/main/services/forge-guardrails/middleware/forge-iteration-tracking.test.ts`
- `tests/main/services/forge-guardrails/integration/full-stack.test.ts`
- new digest unit tests covering preservation, refresh, and failure fallback

Final verification:

- `pnpm typecheck`
- targeted Vitest files for changed phases
- `git diff --check`
- `pnpm check:ipc` only if shared IPC or schema files change

## Rollback Boundaries

Phase A can be reverted independently if provider cache behavior regresses.

Phase B should not remove existing Roc safety wrappers until contract tests prove native DeepAgents behavior is sufficient. If native behavior is incomplete, keep Roc wrapper and document the reason.

Phase C should ship behind the existing compaction middleware boundary. If digest behavior regresses, disable digest generation and retain current tiered deletion behavior.

## Acceptance Criteria

- Chat, Plan Mode, and background tasks still use one `createDeepAgent` runtime path.
- Prompt caching respects provider-safe marker limits and never caches request-specific blocks.
- Explicit skills use native `/skills/` loading by default and do not inject full `SKILL.md` into the system prompt.
- Automatic memory writes suppress duplicate summaries across run ids.
- DeepAgents native contracts are documented in tests where Roc depends on them.
- Long-running compaction preserves a thread-scoped digest of key facts, decisions, files, verification, open questions, and next actions before deleting old context.
