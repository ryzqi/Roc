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

Status: pending

## S2: LangGraph / deepagents compaction hook

Status: pending

## S3: task_threads and session_messages cleanup strategy

Status: pending

## S4: cheap model resolver strategy

Status: pending
