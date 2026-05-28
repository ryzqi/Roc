# Memory rebuild findings

本文件记录 Phase 0 spike 事实。后续 implementation task 与本文件冲突时，以本文件为准，先修 plan 再改代码。

## Current code facts

- Database path: `%USERPROFILE%\.roc\roc.sqlite` from `src/main/services/paths.ts`.
- Current `/memory/` route: `ReadOnlyStoreBackend(StoreBackend({ store, namespace, fileFormat: 'v2' }))` in `src/main/services/deep-agent/backend.ts`.
- Current Deep Agents session path: `DeepAgentRuntimeService.executeRun()` -> `session.agent.streamEvents(...)` -> `consumeSessionStreams(...)` -> `run.output` -> `completeRun(...)`.
- Current `buildDeepAgent` still passes `store` to `createDeepAgent`; deleting `SqliteLangGraphStore` requires a replacement `BaseStore`.
- Official Deep Agents JS docs still expose `createDeepAgent({ model, systemPrompt, tools })` and filesystem middleware/backend customization. No docs-backed before-compaction callback was found in the queried Deep Agents JS docs.
- Official LangGraph JS docs still expose `streamEvents(..., { version: 'v3' })` with `stream.messages` and `stream.output`, `InMemoryStore`, `MemorySaver`, and `trimMessages`; no docs-backed automatic compaction callback was found in the queried LangGraph JS docs.

## S1: FilesystemBackend boundary behavior

Status: complete

Command: `node tmp/spike-s1-filesystem-backend.cjs`

Observed command output:

```json
[
  {
    "name": "write missing subdir",
    "result": {
      "path": "/a/b/c.md",
      "filesUpdate": null
    }
  },
  {
    "name": "read missing",
    "result": {
      "error": "Error reading file '/missing.md': ENOENT: no such file or directory, lstat 'C:\\Users\\任彦舟\\AppData\\Local\\Temp\\roc-memory-s1-C04MjV\\missing.md'"
    }
  },
  {
    "name": "read existing",
    "result": {
      "content": "hi",
      "mimeType": "text/plain"
    }
  },
  {
    "name": "edit missing",
    "result": {
      "error": "Error editing file '/missing.md': ENOENT: no such file or directory, lstat 'C:\\Users\\任彦舟\\AppData\\Local\\Temp\\roc-memory-s1-C04MjV\\missing.md'"
    }
  },
  {
    "name": "concurrent same file write",
    "result": [
      {
        "path": "/concurrent.md",
        "filesUpdate": null
      },
      {
        "path": "/concurrent.md",
        "filesUpdate": null
      }
    ]
  },
  {
    "name": "read concurrent final",
    "result": {
      "content": "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      "mimeType": "text/plain"
    }
  },
  {
    "name": "write empty",
    "result": {
      "path": "/empty.md",
      "filesUpdate": null
    }
  },
  {
    "name": "read empty",
    "result": {
      "content": "System reminder: File exists but has empty contents",
      "mimeType": "text/plain"
    }
  }
]
```

Observed summary:
- write missing subdir: returns `{ path, filesUpdate: null }`; automatically creates parent directories.
- read missing: returns `{ error: "Error reading file ... ENOENT ..." }`; no exception.
- read existing: returns `{ content, mimeType }`.
- edit missing: returns `{ error: "Error editing file ... ENOENT ..." }`; no exception.
- concurrent same file write: both writes return success; final file content is one full write payload. Two observed runs ended with different final writers, so final writer is not a stable ordering contract.
- write empty: write succeeds; read returns `"System reminder: File exists but has empty contents"` instead of empty string.

Decision:
- WritableMemoryFilesystemBackend must normalize write/edit/read errors to Roc-facing strings.
- Path whitelist and capacity/security checks run before delegate write/edit.
- Delegate creates allowed parent directories before write in current `deepagents@1.10.2`; wrapper can still create parent directories explicitly if later local source changes.
- Empty-file reads need Roc-aware normalization if the UI or snapshot builder needs literal empty content.

## S2: LangGraph / deepagents compaction hook

Status: complete

Observed:
- before-compaction callback: no. Official Deep Agents JS and LangGraph JS docs returned no callback API. Local `node_modules/deepagents/dist/index.d.ts:2443` declares `SummarizationMiddlewareOptions`, but no callback field; `node_modules/deepagents/dist/index.js:4059` creates middleware named `SummarizationMiddleware` with only `wrapModelCall`.
- automatic context compaction in deepagents/langgraph: yes in Deep Agents, no direct LangGraph hook found. `node_modules/deepagents/dist/index.js:8114` and `node_modules/deepagents/dist/index.js:8162` add `createSummarizationMiddleware({ backend })` to subagent and main-agent standard middleware. `node_modules/deepagents/dist/index.js:4082` catches `ContextOverflowError`, and `node_modules/deepagents/dist/index.js:4001-4057` summarizes older messages, offloads history to backend, and returns a `Command` state update. The LangGraph local scan only found graph layout trimming at `node_modules/@langchain/langgraph/dist/graph/graph.js:261`, `262`, `349`, and `350`, not message compaction.
- current Roc stream path: `executeRun()` calls `session.agent.streamEvents(...)` at `src/main/services/deep-agent-runtime-service.ts:366`, then `consumeSessionStreams(...)` at `src/main/services/deep-agent-runtime-service.ts:377`, then `run.output` at `src/main/services/deep-agent-runtime-service.ts:390`, then `completeRun(...)` at `src/main/services/deep-agent-runtime-service.ts:391`. Resume uses the same shape at lines `431`, `437`, `449`, and `450`.
- current Deep Agents v3 stream API is docs-backed: official LangGraph JS docs show `streamEvents(..., { version: "v3" })`, `stream.messages`, and `stream.output`.

Decision:
- Roc Pre-Compaction Flush is a token-threshold follow-up run after visible stream completion, not a LangGraph internal before-compaction hook.
- Implementation must not rely on a nonexistent callback or on `session.currentMessages`.
- Deep Agents' built-in summarization already exists and may write to `/conversation_history`; Phase 6 must either precede that threshold using Roc's own token usage or document that this is a proactive flush rather than a true pre-hook.
- Implementation must use a new explicit runtime helper, e.g. `runSilentPrecompactionFlush(context, session, previousInput)`, and either stream the flush through existing `streamEvents` consumers with `visible=false` or archive its final messages directly.
- UI filtering must be controlled by Roc runtime state. No current evidence shows `metadata.phase` propagation through consumed stream events; use an explicit `consumeSessionStreams(..., options)` parameter.

## S3: task_threads and session_messages cleanup strategy

Status: complete

Observed:
- `task_threads` delete locations: no hard `DELETE FROM task_threads` exists in current `src/main/services`, `src/main/ipc`, or `tests/main` scan.
- Chat thread deletion is soft archive. `src/main/services/task-service.ts:155` calls `taskRunManagement.archiveThread(...)`; `src/main/services/task/task-run-management.ts:94` defines `archiveThread`, and `src/main/services/task/task-run-management.ts:105` runs `UPDATE task_threads SET status = ?, updated_at = ?, archived_at = ? WHERE id = ?`.
- Background task deletion is also soft archive. `src/main/services/task/background-task-lifecycle.ts:55-58` updates `background_tasks` to `archived` and updates the related `task_threads` row with `status='archived'` and `archived_at`.
- `task_threads` has no metadata column in current schema. `src/main/services/database-service.ts:40-49` defines only `id`, `kind`, `title`, `goal`, `status`, `created_at`, `updated_at`, and `archived_at`.
- Existing FK references to `task_threads` in `task_runs`, `task_events`, and `background_tasks` do not specify `ON DELETE CASCADE`.

Decision:
- Do not add FK from `session_messages` to `task_threads` in Phase 4; use retention sweep plus orphan cleanup.
- Use independent `memory_flush_marks(thread_id PRIMARY KEY, flushed_at, ratio, tokens_used)` for Pre-Compaction idempotency.
- On task thread archive, do not immediately delete `session_messages`; archived threads remain searchable unless retention sweep removes them.
- If future code introduces hard deletion, explicitly delete related `session_messages` and `memory_flush_marks` in the same service method or document intentional orphan retention.

## S4: cheap model resolver strategy

Status: complete

Observed:
- Current default model resolution: `src/main/services/deep-agent-runtime-service.ts:122` calls `LangChainModelFactory.createDefaultChatModel({ streaming: true })` for new runs; `src/main/services/deep-agent-runtime-service.ts:300` calls `createChatModelByModelId(taskRun.modelId, { streaming: true })` for resumed task runs.
- `src/main/services/langchain-model-factory.ts:484-491` resolves the configured default model through `configService.getDefaultModelState()`, `resolveProviderById(defaultModelState.providerId)`, then `createModelForProvider(provider, defaultModelState.modelId, options)`.
- `src/main/services/langchain-model-factory.ts:494-506` can create the first enabled model for a provider, but this is not a cheap-model selector.
- `src/main/services/langchain-model-factory.ts:509-533` resolves a specific model id by scanning providers and rejects missing or ambiguous mappings.
- Provider-specific cheap model availability: none in current defaults. `src/shared/provider-defaults.ts:25-33` creates fixed NVIDIA provider with `models: []`; `src/shared/provider-defaults.ts:58-66` creates fixed llama.cpp provider with `models: []`. Local search found no `cheap`, `haiku`, or cheap-model mapping in production code.

Decision:
- Phase 5 `resolveCheapModelHandle` returns the active model unless this section is later updated with an exact tested cheap model id for the same provider.
- Consolidator must not invent a provider/model id.
- If a provider later exposes an explicit cheap model, implement selection as a tested, provider-local mapping or setting; do not infer from model name substrings.
