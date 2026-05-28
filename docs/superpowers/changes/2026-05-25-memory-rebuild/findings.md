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

Status: pending

## S3: task_threads and session_messages cleanup strategy

Status: pending

## S4: cheap model resolver strategy

Status: pending
