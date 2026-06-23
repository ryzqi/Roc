# Roc Context Harness Refactor Design

## Goal

Refactor Roc's DeepAgents context engineering so recall, prompt blocks, workspace scope, and memory promotion are handled as one coherent harness layer.

The refactor may be broad, but it must not replace DeepAgents memory with a parallel Roc memory system. Roc should keep using DeepAgents-native memory semantics: `memory` sources, `StoreBackend`, `CompositeBackend`, filesystem routes, `checkpointer`, and `thread_id`.

## Confirmed Decisions

- Implement the full context harness refactor, not only isolated fixes.
- Keep DeepAgents as the owner of low-level memory behavior.
- Keep Roc as the owner of harness orchestration, route safety, workspace scope, session recall, prompt assembly, and UI/task event projection.
- Continue using the current Roc `BaseStore` implementation only as the concrete store required by DeepAgents `StoreBackend`.
- Do not introduce a second memory namespace, `/agents/` alias, path compatibility layer, or separate long-term memory store.
- Preserve the existing file and shell boundary: file tools use `/workspace/`, `/memory/`, and `/skills/`; shell tools use real Windows cwd/path semantics.

## Current State

DeepAgents JS provides a batteries-included harness with planning, filesystem working memory, subagents, skills, middleware, and memory. The installed package confirms that filesystem permissions are first-match-wins with a permissive default, and that `execute` is registered with filesystem middleware but is not governed by path permissions.

Roc already aligns with the critical safety direction:

- `createDeepAgent` receives `backend`, `store`, `memory`, `skills`, `subagents`, `tools`, `permissions`, `interruptOn`, `checkpointer`, and Roc middleware.
- File access routes through `/workspace/`, `/memory/`, and `/skills/`.
- Shell execution stays in Roc-owned `run_shell_command`.
- DeepAgents native `execute` remains excluded.
- The file-tool boundary has shared contract tests and backend/middleware enforcement.

Remaining context engineering gaps:

- `session_search(query)` is described in the system prompt, but no `session_search` tool is currently assembled into the DeepAgent tool list.
- `SystemPromptBuilder` builds stable prompt blocks, but the production executor still calls `buildSystemPrompt()` and sends a plain string without block markers, so prompt caching cannot use the intended block metadata.
- Run completion summary is currently derived from visible assistant text, which is too weak for long-term memory promotion.
- `workspaceScope` exists in the session search request schema, but current session search does not apply workspace filtering.

## Non-Goals

- Do not change DeepAgents file-tool route policy beyond what the existing file-tool boundary work already covers.
- Do not make `run_shell_command` accept `/workspace/...`.
- Do not expose DeepAgents native `execute`.
- Do not broaden `/skills/`; it remains read-only and selected-skill scoped.
- Do not replace DeepAgents `StoreBackend` or memory-source behavior with custom Roc persistence semantics.
- Do not implement an external vector database or embedding index in this refactor.

## Architecture

Add a focused context harness layer under the existing DeepAgent service boundary:

```text
src/main/services/deep-agent/context/
  context-assembler.ts
  prompt-blocks.ts
  prompt-serialization.ts
  session-search-tool.ts
  workspace-scope.ts
  memory-promotion.ts
  run-summary.ts
```

`deep-agent-executor.ts` should become the coordinator. It should resolve the runtime workspace and model handle, ask the context layer to assemble the context harness pieces, then call `buildDeepAgent()`.

The context layer should produce:

- DeepAgents memory source paths.
- DeepAgents skill source paths.
- Roc custom tools, including `session_search`.
- Prompt blocks and serialized system prompt.
- Workspace scope metadata for recall and promotion.
- Memory promotion instructions for run completion.

DeepAgents continues to own:

- Filesystem middleware and backend protocol.
- Store-backed memory files.
- Skills middleware and skill loading.
- Subagent middleware.
- Todo middleware.
- Checkpointed thread continuity.

Roc continues to own:

- Windows path semantics.
- Workspace path/hash resolution.
- Session database search.
- Prompt block composition.
- Memory promotion policy.
- Runtime events and task event projection.

## Components

### Context Assembler

`context-assembler.ts` builds one `ContextHarness` object from the executor input.

Inputs:

- `ChatStartRunRequest`
- selected runtime workspace
- enabled capabilities
- run/thread identity
- model runtime metadata
- available Roc capabilities
- DeepAgents backend result

Outputs:

- `systemPrompt`
- `memorySources`
- `skillSources`
- `tools`
- `subagents`
- `workspaceScope`
- `promotionContext`

The assembler should not execute tools or write memory. It only prepares deterministic context configuration.

### Prompt Blocks

`prompt-blocks.ts` becomes the single source for system prompt content. It replaces the current long-term split between `prompt.ts` and `prompt-builder.ts`.

Required block order:

1. `static`
2. `workspace`
3. `tools`
4. `capability`
5. `context_recall`
6. `workflow`

`prompt-serialization.ts` serializes blocks with stable markers:

```text
<!-- BLOCK:static:static:<hash> -->
...
<!-- BLOCK:workspace:workspace:<hash> -->
...
```

This makes the existing prompt caching middleware able to parse production prompts instead of only test fixtures.

`buildSystemPrompt()` may remain temporarily as a thin wrapper that delegates to the new builder. It must not keep a separate prompt body.

### Session Search Tool

`session-search-tool.ts` exposes `session_search` to the agent.

Schema:

```ts
{
  query: string;
  scope?: 'current' | 'all';
  sinceDays?: number;
  limit?: number;
}
```

Default scope:

- Use `current` when a runtime workspace exists.
- Use `all` when no runtime workspace exists.

The tool should call an internal search adapter backed by the existing agent session repository/capability. It should return compact results:

- `threadId`
- `threadTitle`
- `role`
- `snippet`
- `createdAt`

It must not return full message contents by default.

### Workspace Scope

`workspace-scope.ts` defines how current workspace filtering works.

The repository must persist enough workspace metadata to make `scope=current` real. The authoritative search field is `session_messages.workspace_hash`, derived from the real Windows workspace path at the time the session message is recorded. The run-level workspace path is only the source used to compute this field.

Rules:

- Chat runs use the current runtime workspace.
- Background task runs use the saved task `workspacePath`.
- Runs without a workspace have `workspace_hash = null`.
- `current` excludes null workspace rows and rows from other workspaces.
- `all` searches every visible session message.

The existing `workspaceScope: 'global'` shape should be removed or converted before agent exposure unless it has a concrete behavior. This refactor should avoid a field whose semantics are not enforced.

### Memory Promotion

`memory-promotion.ts` decides whether and how to write a completed run summary to DeepAgents memory files.

It must write through `/memory/.../MEMORY.md` semantics only. It must not write directly to custom memory tables except through the store/backend path already used by DeepAgents memory.

Promotion target:

- Workspace memory when the run has a workspace.
- Global memory only when the run has no workspace.

Promotion output:

- Short factual bullets.
- Include run id only when useful for traceability.
- Avoid speculative preferences.
- Avoid tool-only noise.
- Skip empty or low-value summaries.

`run-summary.ts` builds the candidate summary from:

- final assistant text
- successful tool call names
- subagent summaries
- workflow hint
- task events when relevant

The summary should be deterministic and bounded. A future model-generated summary can be added only if this deterministic summary proves too weak and has tests around failure modes.

## Data Flow

1. `startRun` or `resumeRun` creates or loads the run with `thread_id`, `run_id`, enabled capabilities, workflow hint, and request workspace path.
2. `deep-agent-executor.ts` resolves runtime workspace using request `workspacePath` when present, otherwise current workspace.
3. `createBackend()` builds DeepAgents backend routes and memory sources.
4. `ContextAssembler` builds prompt blocks, compact context metadata, skill sources, and additional tools.
5. `buildDeepAgent()` receives the assembled prompt, memory sources, skill sources, tools, subagents, permissions, checkpointer, and middleware.
6. During the run, the agent can call `session_search` when it needs previous discussion.
7. Prompt caching middleware parses production block markers and applies provider-specific cache behavior.
8. On completion, runtime records assistant output and publishes `agent.run.completed`.
9. Memory promotion receives the completed run payload, builds a bounded factual summary, validates it through existing security/capacity checks, and writes only to `MEMORY.md`.

## Error Handling

### Session Search

- Empty query returns `{ total: 0, items: [] }`.
- `scope=current` without a workspace returns tool error `session_search_workspace_required`.
- Invalid scope is rejected by the schema.
- FTS syntax errors fall back to a plain prefix query. If the fallback also fails, return a clear tool error.
- Results are capped by `limit`; default should be small enough to avoid flooding context.

### Prompt Blocks

- Prompt block serialization is deterministic and test-locked.
- Prompt caching middleware may skip unsupported providers, but it must not silently skip Anthropic-compatible production prompts because markers are missing.
- `prompt.ts` and `prompt-builder.ts` must not keep divergent prompt content.

### Memory Promotion

- Automatic promotion writes only `MEMORY.md`.
- Security scan failures skip the write and log a warning.
- Capacity overflow skips the write and logs a warning. It must not truncate or overwrite memory.
- Empty, duplicate, or low-value summaries are skipped.
- Promotion must not write `USER.md` or `AGENTS.md`.

### Workspace Scope

- Workspace hash is derived from the real Windows path, not from `/workspace`.
- Background task runs use the saved task workspace path.
- Chat runs use the runtime workspace selected for the run.
- Existing rows without `workspace_hash` are treated as unscoped and are visible only to `all`.

## Testing

Add or update focused tests before implementation:

- `tests/main/services/deep-agent/context/session-search-tool.test.ts`
  - Assembles `session_search`.
  - Filters `scope=current` by workspace hash.
  - Returns `session_search_workspace_required` without workspace.
  - Returns compact result fields only.

- `tests/main/services/deep-agent/context/prompt-blocks.test.ts`
  - Production prompt contains block markers.
  - Block order is stable.
  - `context_recall` documents `session_search`.
  - `buildSystemPrompt()` delegates to the new builder or is removed.

- `tests/main/services/forge-guardrails/middleware/prompt-caching.test.ts`
  - Anthropic-compatible provider receives `cache_control` from a production prompt.
  - OpenAI-compatible provider leaves messages intact.
  - Missing markers are covered as a degraded path, not the production path.

- `tests/main/services/deep-agent/context/memory-promotion.test.ts`
  - Generates factual bounded bullets.
  - Skips empty summaries.
  - Skips tool-only noise.
  - Skips capacity/security failures.
  - Writes only memory kind `memory`.

- `tests/main/plugins/agent/session-repository.test.ts`
  - Persists workspace metadata.
  - Searches `current` versus `all`.
  - Keeps existing unscoped rows out of `current`.

Keep existing regression coverage:

- File-tool contract, backend, and path policy tests.
- Shell path policy tests.
- DeepAgent executor tool tests.
- Background task workspace tests.
- Prompt tests.
- Typecheck.

## Migration Strategy

1. Add failing tests around session recall, prompt block production wiring, workspace-scoped search, and memory promotion.
2. Add workspace metadata schema/mappers for session messages.
3. Add `src/main/services/deep-agent/context/` modules.
4. Move prompt assembly to the new block builder.
5. Add `session_search` to run tools.
6. Replace direct 120-character completion summary with memory promotion summary generation.
7. Keep `AutoMemoryWriter` only as the event subscriber and promotion executor, or rename it if the code changes enough to justify it.
8. Remove duplicate prompt content and stale tests that only prove fixture parsing.
9. Run focused tests, `pnpm typecheck`, and then broader tests proportional to changed files.

## Acceptance Criteria

- Agent has a working `session_search` tool.
- `session_search` honors workspace scope.
- Production system prompt includes block markers.
- Prompt caching middleware is exercised by a production prompt.
- Automatic memory promotion writes only to DeepAgents memory files and only to `MEMORY.md`.
- Workspace-specific memory and session recall use real Windows workspace identity.
- DeepAgents native `execute` remains unavailable.
- `/workspace/...` remains invalid for shell commands.
- File tools still reject paths outside `/workspace/`, `/memory/`, and `/skills/`.
- Tests directly verify each context harness contract.

## Verification Commands

Run the smallest focused set first:

```powershell
pnpm test -- tests/main/services/deep-agent/context/session-search-tool.test.ts tests/main/services/deep-agent/context/prompt-blocks.test.ts tests/main/services/deep-agent/context/memory-promotion.test.ts tests/main/services/forge-guardrails/middleware/prompt-caching.test.ts tests/main/plugins/agent/session-repository.test.ts
```

Then run broader checks:

```powershell
pnpm typecheck
pnpm test
git diff --check
```

## Open Constraints For Implementation Plan

- The implementation plan must use `session_messages.workspace_hash` as the session recall filter source of truth.
- The plan must avoid committing unrelated dirty worktree changes.
- The plan must include cleanup of old prompt duplication and fake prompt-caching fixture-only tests.
