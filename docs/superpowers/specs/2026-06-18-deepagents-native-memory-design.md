# DeepAgents Native Memory Refactor Design

## Goal

Refactor Roc memory so DeepAgents native memory is the runtime source of truth.
Roc will keep the existing five user-visible markdown slots, but the storage and
agent access path will move from Roc's custom disk-backed memory files to
DeepAgents `StoreBackend` over a Roc SQLite-backed LangGraph `BaseStore`.

## Decisions

- Use option B: replace the current Roc custom memory storage bottom layer.
- Reuse Roc's existing SQLite database for the LangGraph `BaseStore`.
- Align with the current JavaScript DeepAgents API used by this repository:
  `deepagents` 1.10.x. The authoritative runtime shape is the installed package
  types plus official JavaScript DeepAgents docs, not older Python examples or
  local 0.6.x notes.
- Keep the Memory page and convert it into a Store-backed markdown editor.
- Update the Settings memory section at the same time. Remove controls whose
  only meaning was the old frozen snapshot, LLM consolidator, or pre-compaction
  pipeline; keep only settings that still affect the native Store-backed memory
  path.
- Do not migrate old disk memory files. The old disk-backed memory data under the
  Roc memory root will be cleaned up as part of the refactor.
- Keep only five markdown slots:
  - `/memory/global/USER.md`
  - `/memory/global/AGENTS.md`
  - `/memory/global/MEMORY.md`
  - `/memory/workspaces/current/AGENTS.md`
  - `/memory/workspaces/current/MEMORY.md`
- Store values must stay markdown-first. SQLite stores DeepAgents file objects
  whose content is markdown, not structured long-term memory facts.
- Add lightweight automatic memory consolidation from completed agent runs.
  Automatic writes are allowed only to `MEMORY.md`.
- `USER.md` and `AGENTS.md` remain manual or explicit agent file-tool writes.

## Current State

Roc currently has a custom memory system:

- `src/main/plugins/memory/memory-repository.ts` reads and writes markdown files
  directly under `paths.memoryDir`.
- `src/main/services/deep-agent/backend.ts` mounts `/memory/` through a
  `FilesystemBackend` plus `WritableMemoryFilesystemBackend`.
- `src/main/services/memory/snapshot.ts` builds a frozen prompt snapshot from
  disk files.
- `src/main/plugins/agent/deep-agent-executor.ts` passes `memorySources: []` to
  `createDeepAgent`, so DeepAgents native memory middleware is not currently the
  active loader.

This means `/memory/` currently behaves like a Roc custom file route, not like a
DeepAgents Store-backed memory layer.

## OpenClaw Reference

OpenClaw's ClawXMemory design is useful for one constraint, not for a full copy:
long-term memory is markdown-first. In ClawXMemory, SQLite is control-plane
state, while durable memory remains inspectable markdown files.

Roc will adapt that principle to DeepAgents:

- Markdown remains the memory format.
- No structured fact table becomes the long-term memory truth source.
- Store keys are markdown virtual paths.
- The UI and agent tools operate on the same markdown content.

Roc will not copy OpenClaw's full `Project/*.md`, `Feedback/*.md`, Index/Dream,
or single-project recall architecture in this refactor.

## Architecture

### SQLite Store

Add a Roc SQLite-backed implementation of LangGraph `BaseStore`.

The store must support the operations required by DeepAgents `StoreBackend`:

- `get(namespace, key)`
- `put(namespace, key, value)`
- `delete(namespace, key)` if required by the interface version in use
- `search(namespacePrefix, options)` with pagination behavior compatible with
  `StoreBackend`
- `batch(operations)` for the operation shapes exported by the current
  `@langchain/langgraph` package

Stored values use DeepAgents file data shape:

- `content`: markdown string
- `mimeType`: `text/markdown` when available
- `created_at`
- `modified_at`

The table should live in the existing Roc SQLite database. SQLite is the
physical persistence layer for DeepAgents markdown file objects, not a separate
structured memory fact schema.

### Backend Routing

Replace the current `/memory/` filesystem-backed route with DeepAgents
`StoreBackend`.

The DeepAgents backend composition remains:

- `/workspace/` -> selected workspace `FilesystemBackend`
- `/skills/` -> selected skills read-only backend
- `/memory/global/` -> `StoreBackend` using namespace
  `['roc', 'memory', 'global']`
- `/memory/workspaces/current/` -> `StoreBackend` using namespace
  `['roc', 'memory', 'workspaces', workspaceHash]`
- default -> rejecting backend

`CompositeBackend` remains the route boundary, and existing path permissions
continue to deny access outside `/workspace/`, `/skills/`, and `/memory/`.

Do not mount a single broad `/memory/` StoreBackend. DeepAgents
`CompositeBackend` strips the matched route prefix before delegating, so global
and workspace memory need separate route prefixes to select separate Store
namespaces.

### Namespace

Use explicit namespaces so memory cannot collide with other Store users.

Recommended namespace shape:

- Global memory: `['roc', 'memory', 'global']`
- Workspace memory: `['roc', 'memory', 'workspaces', workspaceHash]`

The route adapter maps `/memory/workspaces/current/...` to the current workspace
namespace and rejects workspace-scoped paths when no workspace is selected.

### Markdown Slots

Only the five approved slots are valid:

- global `USER.md`
- global `AGENTS.md`
- global `MEMORY.md`
- current workspace `AGENTS.md`
- current workspace `MEMORY.md`

All other `/memory/` write paths fail with a clear whitelist error.
`USER.md` under workspace scope remains invalid.

### DeepAgents Native Memory Loading

`buildDeepAgent` should pass memory sources into `createDeepAgent`.

For a selected workspace:

- `/memory/global/USER.md`
- `/memory/global/AGENTS.md`
- `/memory/global/MEMORY.md`
- `/memory/workspaces/current/AGENTS.md`
- `/memory/workspaces/current/MEMORY.md`

Without a selected workspace:

- `/memory/global/USER.md`
- `/memory/global/AGENTS.md`
- `/memory/global/MEMORY.md`

This makes DeepAgents memory middleware the loader for always-on memory.

## Automatic Consolidation

After an agent run completes, Roc performs a lightweight non-LLM memory append
pass.

Inputs:

- completed run id
- completed run summary already produced by the runtime event
- current target `MEMORY.md`

Rules:

- Write only to `MEMORY.md`.
- If a workspace is selected, write only
  `/memory/workspaces/current/MEMORY.md`.
- If no workspace is selected, write only `/memory/global/MEMORY.md`.
- Do not write `USER.md`.
- Do not write `AGENTS.md`.
- Do not invent facts.
- Keep only stable, reusable facts or project state.
- Avoid storing transient step-by-step chat content.
- Preserve markdown format.
- Do not call an LLM in the first implementation.

The first version appends a dated markdown section only when the completed-run
summary is non-empty and the exact bullet is not already present in the target
file. It does not rewrite `USER.md`, `AGENTS.md`, or unrelated `MEMORY.md`
sections. If the summary is empty or fails validation, no memory write occurs.

## Validation And Safety

Before any Store write:

- validate path against the five-slot whitelist
- reject workspace memory when no workspace is selected
- run existing security scan
- enforce existing per-kind character limits
- enforce markdown string content

On capacity overflow:

- fail explicitly with chars and limit
- do not silently truncate

No broad catch-all error swallowing in business logic. Errors should surface
through capability or IPC result boundaries.

## UI And IPC

Keep the current Memory feature surface:

- status
- read file
- write file
- snapshot preview

Change implementation to read/write through the Store-backed memory service
instead of disk files.

The UI should still show:

- scope
- kind
- character count
- character limit
- effective source
- updated time

`absolutePath` should no longer imply a Windows disk path. Replace or reinterpret
it as a virtual path such as `/memory/global/USER.md` in the shared type during
implementation.

The Settings memory section should be synchronized with the new runtime model:

- Remove "冻结快照", "用户画像", and "规则文件" toggles unless the
  implementation deliberately supports source-level exclusion from
  `createDeepAgent({ memory })`. The preferred path is no toggle: the five
  approved memory sources are loaded by native DeepAgents memory.
- Remove "自动压缩", "压缩延迟", "压缩目标", and "压缩配额" settings. The new
  automatic write path is a deterministic append to `MEMORY.md`, not the old LLM
  capacity consolidator.
- Remove "预压缩刷新", "刷新阈值", and "上下文窗口" settings unless a current
  runtime path still consumes them after the refactor. Do not keep inert
  settings in the UI or saved schema.
- Keep character limits, security scan toggles, and session recall retention if
  their existing services still consume them.
- Bump or migrate the settings schema so removed fields do not survive as active
  configuration, and update the settings impact summary copy.

## Cleanup

Remove or replace these custom disk-backed pieces where they become obsolete.
Do not leave compatibility reads, fallback writes, aliases, or active
initialization paths for old disk memory:

- `WritableMemoryFilesystemBackend`
- `resolveMemoryPath`
- disk reads in `MemoryRepository`
- disk reads in frozen snapshot generation
- `ConsolidatorService` and `.consolidator-backup`
- prompt text that describes custom Roc disk memory instead of DeepAgents memory
- production dependencies on `memory.root` / `paths.memoryDir`
- generated directories created only for old disk-backed memory
- settings fields and UI controls for obsolete snapshot, consolidator, and
  pre-compaction behavior

Old memory data under `paths.memoryDir` is intentionally not migrated. The
implementation should stop using that directory for active memory behavior; any
filesystem cleanup must be explicit and verified, not hidden behind fallback
logic.

## Tests

Add or update tests for:

- SQLite-backed `BaseStore` persistence across store instances
- DeepAgents `StoreBackend` reads and writes markdown file data through Roc store
- `/memory/` route rejects paths outside the five-slot whitelist
- `createDeepAgent` receives non-empty memory sources
- Memory UI reads and writes Store-backed markdown content
- Settings memory section exposes only native-memory-relevant controls
- Settings schema migration drops or ignores obsolete memory fields explicitly
- automatic consolidation writes only `MEMORY.md`
- no workspace selected writes global `MEMORY.md`
- workspace selected writes workspace `MEMORY.md`
- security scan and capacity errors block Store writes
- old disk-backed memory code is no longer used by the DeepAgent backend

Verification commands:

- `pnpm test -- tests/main/memory`
- `pnpm test -- tests/main/config-service-helpers.test.ts tests/main/config-memory-defaults.test.ts`
- `pnpm test -- tests/main/deep-agent-prompt.test.ts`
- `pnpm test -- tests/main/plugins/agent/deep-agent-executor.test.ts`
- `pnpm test -- tests/renderer/settings-model.test.ts tests/renderer/settings-model-save.test.ts tests/renderer/settings-floating-surfaces.test.ts`
- `pnpm test -- tests/renderer/memory-view.test.tsx tests/renderer/features/memory-feature.test.tsx`
- `pnpm typecheck`

## Out Of Scope

- OpenClaw-style `Project/*.md` and `Feedback/*.md` directories.
- Full Index/Dream background memory system.
- Vector search or semantic memory ranking.
- Migration of old disk memory contents.
- User approval queue for automatic memory writes.
- Multi-user hosted namespace policy beyond current local Roc usage.
