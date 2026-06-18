# DeepAgents Native Memory Refactor Design

## Goal

Refactor Roc memory so DeepAgents native memory is the runtime source of truth.
Roc will keep the existing five user-visible markdown slots, but the storage and
agent access path will move from Roc's custom disk-backed memory files to
DeepAgents `StoreBackend` over a Roc SQLite-backed LangGraph `BaseStore`.

## Decisions

- Use option B: replace the current Roc custom memory storage bottom layer.
- Reuse Roc's existing SQLite database for the LangGraph `BaseStore`.
- Keep the Memory page and convert it into a Store-backed markdown editor.
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
- `search(namespace, options)` with pagination behavior compatible with
  `StoreBackend`

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
- `/memory/` -> `StoreBackend`
- default -> rejecting backend

`CompositeBackend` remains the route boundary, and existing path permissions
continue to deny access outside `/workspace/`, `/skills/`, and `/memory/`.

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

After an agent run completes, Roc performs a lightweight memory extraction pass.

Inputs:

- current user request
- final assistant response
- relevant tool summaries when already available from the run transcript
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

The first version appends a dated markdown section only when the extracted facts
are not already present in the target file. It does not rewrite `USER.md`,
`AGENTS.md`, or unrelated `MEMORY.md` sections. If the generated output is empty
or fails validation, no memory write occurs.

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
- optional consolidator can retry with a shorter markdown rewrite, but only if it
  still passes scan and capacity checks

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

## Cleanup

Remove or replace these custom disk-backed pieces where they become obsolete:

- `WritableMemoryFilesystemBackend`
- `resolveMemoryPath` if no longer used by the Store route adapter
- disk reads in `MemoryRepository`
- disk reads in frozen snapshot generation
- prompt text that describes custom Roc disk memory instead of DeepAgents memory

Clean old memory files under `paths.memoryDir` for this refactor. Generated
directories that only existed for old disk-backed memory should not remain as an
active compatibility path.

## Tests

Add or update tests for:

- SQLite-backed `BaseStore` persistence across store instances
- DeepAgents `StoreBackend` reads and writes markdown file data through Roc store
- `/memory/` route rejects paths outside the five-slot whitelist
- `createDeepAgent` receives non-empty memory sources
- Memory UI reads and writes Store-backed markdown content
- automatic consolidation writes only `MEMORY.md`
- no workspace selected writes global `MEMORY.md`
- workspace selected writes workspace `MEMORY.md`
- security scan and capacity errors block Store writes
- old disk-backed memory code is no longer used by the DeepAgent backend

Verification commands:

- `pnpm test -- tests/main/memory`
- `pnpm test -- tests/main/memory-integration`
- `pnpm test -- tests/main/deep-agent-prompt.test.ts`
- `pnpm test -- tests/main/plugins/agent/deep-agent-executor.test.ts`
- `pnpm test -- tests/renderer/memory-view.test.tsx tests/renderer/features/memory-feature.test.tsx`
- `pnpm typecheck`

## Out Of Scope

- OpenClaw-style `Project/*.md` and `Feedback/*.md` directories.
- Full Index/Dream background memory system.
- Vector search or semantic memory ranking.
- Migration of old disk memory contents.
- User approval queue for automatic memory writes.
- Multi-user hosted namespace policy beyond current local Roc usage.
