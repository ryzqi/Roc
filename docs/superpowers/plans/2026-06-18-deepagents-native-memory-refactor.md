# DeepAgents Native Memory Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Roc memory from disk-backed custom files to DeepAgents native memory over a Roc SQLite-backed LangGraph `BaseStore`, while keeping exactly five markdown slots and the existing Memory management UI.
**Architecture:** `core.db` stores DeepAgents file objects through a new SQLite `BaseStore`; `/memory/global/` and `/memory/workspaces/current/` mount DeepAgents `StoreBackend` instances behind Roc validation wrappers; the Memory plugin edits the same Store records; completed agent runs can append lightweight notes only to `MEMORY.md`.
**Tech Stack:** TypeScript ESM, Electron main process, React renderer, Vitest, `better-sqlite3`, `@langchain/langgraph` `BaseStore`, DeepAgents JS 1.10.x `StoreBackend`/`CompositeBackend`.

---

## Constraints And Acceptance Criteria

- Keep only these five virtual markdown files:
  - `/memory/global/USER.md`
  - `/memory/global/AGENTS.md`
  - `/memory/global/MEMORY.md`
  - `/memory/workspaces/current/AGENTS.md`
  - `/memory/workspaces/current/MEMORY.md`
- Use DeepAgents native memory loading by passing these virtual paths through `createDeepAgent({ memory })`.
- Use DeepAgents `StoreBackend`; do not keep the disk `FilesystemBackend` under `/memory/`.
- Treat the installed `deepagents` 1.10.x and `@langchain/langgraph` types as
  the implementation authority. Do not copy older Python or DeepAgents 0.6.x
  constructor examples when they conflict with current TypeScript types.
- Reuse Roc SQLite. Store memory in `core.db` through `DatabasePool.getCoreConnection()`, so the agent runtime and Memory page share one physical store.
- Do not migrate old disk memory. Delete the old disk-backed memory implementation and tests instead of adding compatibility paths.
- Preserve markdown as the durable memory format. SQLite stores DeepAgents file records with markdown `content`, not normalized facts.
- Automatic memory writes are allowed only to `MEMORY.md`; `USER.md` and `AGENTS.md` are manual or explicit file-tool writes.
- No review queue, no extra slots, no new project/feedback memory hierarchy.

## File Structure

```text
src/main/infrastructure/database-pool.ts
src/main/kernel/types.ts
src/main/kernel/kernel-runtime.ts
src/main/services/memory/sqlite-store.ts                 # new
src/main/services/memory/store-slots.ts                  # new
src/main/services/memory/auto-memory-writer.ts           # new
src/main/services/deep-agent/store-memory-backend.ts     # new
src/main/services/deep-agent/backend.ts
src/main/services/deep-agent/prompt.ts
src/main/services/deep-agent/prompt-builder.ts
src/main/plugins/agent/index.ts
src/main/plugins/agent/deep-agent-executor.ts
src/main/plugins/memory/index.ts
src/shared/types/memory.ts
src/renderer/views/memory/files-tab.tsx
tests/main/memory/sqlite-store.test.ts                   # new
tests/main/memory/store-slots.test.ts                    # new
tests/main/deep-agent/store-memory-backend.test.ts       # new
tests/main/plugins/memory/plugin.test.ts
tests/main/plugins/agent/deep-agent-executor.test.ts
tests/main/deep-agent-build-wiring.test.ts
tests/main/deep-agent-prompt.test.ts
tests/main/kernel/types.test.ts
tests/main/infrastructure/database-pool.test.ts
tests/renderer/memory-view.test.tsx
tests/renderer/features/memory-feature.test.tsx
```

Delete these disk-memory-only files after replacements are green:

```text
src/main/plugins/memory/memory-repository.ts
src/main/plugins/memory/consolidator-adapter.ts
src/main/services/deep-agent/writable-memory-backend.ts
src/main/services/memory/path-resolver.ts
tests/main/memory-integration/writable-memory-backend.test.ts
tests/main/memory/path-resolver.test.ts
tests/main/plugins/memory/consolidator-adapter.test.ts
```

Keep `src/main/services/memory/capacity.ts` and `src/main/services/memory/security-scan.ts`; they remain Store write validation services.

## Task 0: Verify Current DeepAgents And LangGraph Contracts

### Change

- [ ] Record the installed `deepagents` version from `package.json`.
- [ ] Inspect `node_modules/deepagents/dist/index.d.ts` for:
  - `CreateDeepAgentParams.memory?: string[]`
  - `StoreBackendOptions.store?: BaseStore`
  - `StoreBackendOptions.namespace?: string[] | StoreBackendNamespaceFactory`
  - `CompositeBackend` route prefix behavior
  - `BackendProtocolV2` result shapes for `read`, `write`, `edit`, `ls`, `glob`, and `grep`
- [ ] Inspect the current `@langchain/langgraph` exported operation types for:
  - `BaseStore`
  - `GetOperation`
  - `PutOperation`
  - `SearchOperation`
  - `ListNamespacesOperation`
  - `OperationResults`
- [ ] Update any examples in this plan before coding if the current package types differ.

### Verification

- [ ] `pnpm list deepagents @langchain/langgraph`
- [ ] `rg -n "interface CreateDeepAgentParams|interface StoreBackendOptions|declare class StoreBackend|declare class CompositeBackend|interface BackendProtocolV2" node_modules/deepagents/dist/index.d.ts`
- [ ] `rg -n "BaseStore|GetOperation|PutOperation|SearchOperation|ListNamespacesOperation|OperationResults" node_modules/@langchain/langgraph node_modules/.pnpm -g "*.d.ts"`

## Task 1: Add A Shared Core SQLite Facade

### Change

- [ ] Extend `RocPluginContext['database']` with `getCoreConnection(): Database`.
- [ ] Extend `DatabasePool.createPluginDatabaseFacade(pluginId)` so plugin contexts can still call `getConnection()` for plugin tables and `getCoreConnection()` for shared core tables.
- [ ] Pass the extended facade from `KernelRuntime`.
- [ ] Update all test context builders that construct `RocPluginContext` directly.

Expected shape:

```typescript
export type RocPluginContext = {
  readonly database: {
    getConnection(): Database;
    getCoreConnection(): Database;
  };
  // unchanged fields...
};
```

```typescript
createPluginDatabaseFacade(pluginId: string): {
  getConnection(): DatabaseConnection;
  getCoreConnection(): DatabaseConnection;
} {
  assertPluginId(pluginId);
  return {
    getConnection: () => this.getConnection(pluginId),
    getCoreConnection: () => this.getCoreConnection()
  };
}
```

### Verification

- [ ] `pnpm test -- tests/main/infrastructure/database-pool.test.ts tests/main/kernel/types.test.ts tests/main/kernel/plugin-loader.test.ts`
- [ ] Verify plugin DB isolation still holds, and `core.db` is reachable without allowing arbitrary plugin id selection.

## Task 2: Implement A Minimal SQLite `BaseStore`

### Change

- [ ] Create `src/main/services/memory/sqlite-store.ts`.
- [ ] Implement a concrete `RocSqliteStore extends BaseStore` using `better-sqlite3`.
- [ ] Use one table in `core.db`, for example `langgraph_store_items`.
- [ ] Persist `namespace` as JSON text and `namespace_key` as a stable delimiter-joined string for uniqueness.
- [ ] Persist `key`, `value_json`, `created_at`, and `updated_at`.
- [ ] Support only lexical search/filter/pagination; no vector embeddings for this refactor.
- [ ] Make `put(namespace, key, value)` update `updated_at` but preserve `created_at`.
- [ ] Make `delete(namespace, key)` remove the item.
- [ ] Make `search(namespacePrefix, { filter, limit, offset })` return only items whose namespace starts with the prefix.
- [ ] Make `batch()` dispatch `GetOperation`, `PutOperation`, `SearchOperation`, and `ListNamespacesOperation` using the discriminants from the current `@langchain/langgraph` type declarations. Do not rely on broad duck-typing if two operations can share the same field names.
- [ ] Reject invalid namespaces or keys with explicit errors.

Core implementation outline:

```typescript
import { BaseStore, type Item, type Operation, type OperationResults, type SearchItem } from '@langchain/langgraph';
import type { Database as DatabaseConnection } from 'better-sqlite3';

export class RocSqliteStore extends BaseStore {
  constructor(private readonly db: DatabaseConnection) {
    super();
    applyRocSqliteStoreSchema(db);
  }

  async batch<Op extends Operation[]>(operations: Op): Promise<OperationResults<Op>> {
    const results = operations.map((operation) => {
      // Replace this sketch with explicit type guards that match the current
      // @langchain/langgraph operation declarations verified in Task 0.
      if ('key' in operation && 'value' in operation) {
        if (operation.value === null) {
          this.deleteSync(operation.namespace, operation.key);
        } else {
          this.putSync(operation.namespace, operation.key, operation.value);
        }
        return undefined;
      }
      if ('key' in operation) {
        return this.getSync(operation.namespace, operation.key);
      }
      if ('namespacePrefix' in operation) {
        return this.searchSync(operation.namespacePrefix, operation);
      }
      return this.listNamespacesSync(operation);
    }) as OperationResults<Op>;
    return results;
  }
}
```

Do not import from `@langchain/langgraph-checkpoint` directly; Roc already imports `BaseStore` and `InMemoryStore` from `@langchain/langgraph`.
If the package type declarations prove that a direct checkpoint import is the only type-correct source, stop and revise this plan before implementation instead of adding mixed imports opportunistically.

### Tests

Create `tests/main/memory/sqlite-store.test.ts`:

- [ ] `put` then `get` returns `value`, `key`, `namespace`, `createdAt`, `updatedAt`.
- [ ] second `put` on the same namespace/key updates value and preserves `createdAt`.
- [ ] `delete` makes `get` return `null`.
- [ ] `search(['roc', 'memory'])` returns global and workspace items with `limit`/`offset`.
- [ ] `search` exact filter works for top-level fields used by Store values.
- [ ] `batch` handles get/put/search/list namespaces in order.
- [ ] `listNamespaces({ prefix, maxDepth })` returns unique namespace arrays.

### Verification

- [ ] `pnpm test -- tests/main/memory/sqlite-store.test.ts`

## Task 3: Define The Five Store Slots

### Change

- [ ] Create `src/main/services/memory/store-slots.ts`.
- [ ] Define the five slot descriptors as the single source of truth.
- [ ] Map global slots to namespace `['roc', 'memory', 'global']`.
- [ ] Map workspace slots to namespace `['roc', 'memory', 'workspaces', workspaceHash]`.
- [ ] Store keys as StoreBackend-local file paths:
  - global route keys: `/USER.md`, `/AGENTS.md`, `/MEMORY.md`
  - workspace route keys: `/AGENTS.md`, `/MEMORY.md`
- [ ] Expose virtual paths exactly as the user-facing paths.
- [ ] Reject workspace slots when `workspaceHash === null`.
- [ ] Keep capacity limits from settings: `user`, `agents`, `memory`.

Suggested exported API:

```typescript
export type MemorySlot = {
  scope: 'global' | 'workspace';
  kind: 'user' | 'agents' | 'memory';
  virtualPath: string;
  routePrefix: '/memory/global/' | '/memory/workspaces/current/';
  storeKey: string;
  namespace: string[];
  limitKey: 'user' | 'agents' | 'memory';
};

export function listMemorySlots(workspaceHash: string | null): MemorySlot[];
export function resolveMemorySlotByVirtualPath(path: string, workspaceHash: string | null): MemorySlotResolveResult;
export function resolveMemorySlotByScopeKind(input: { scope: MemoryScope; kind: MemoryKind }, workspaceHash: string | null): MemorySlotResolveResult;
```

### Tests

Create `tests/main/memory/store-slots.test.ts`:

- [ ] resolves all five approved virtual paths.
- [ ] rejects `/memory/global/notes.md`.
- [ ] rejects `/memory/workspaces/current/USER.md`.
- [ ] rejects explicit workspace hashes such as `/memory/workspaces/<hash>/MEMORY.md`.
- [ ] rejects workspace slots when no workspace is selected.

### Verification

- [ ] `pnpm test -- tests/main/memory/store-slots.test.ts`

## Task 4: Replace `/memory/` With DeepAgents `StoreBackend`

### Change

- [ ] Create `src/main/services/deep-agent/store-memory-backend.ts`.
- [ ] Wrap DeepAgents `StoreBackend` with Roc slot validation, security scan, and capacity checks.
- [ ] Do not write to disk and do not call the old `ConsolidatorService`.
- [ ] Create two route backends:
  - `/memory/global/` -> `new StoreBackend({ store, namespace: ['roc', 'memory', 'global'] })`
  - `/memory/workspaces/current/` -> `new StoreBackend({ store, namespace: ['roc', 'memory', 'workspaces', workspaceHash] })`
- [ ] Keep `CompositeBackend` longest-prefix routing. Do not mount a broad `/memory/` store backend because it cannot select namespace by subpath.
- [ ] Add a rejecting backend for `/memory/workspaces/current/` when no workspace is selected.
- [ ] Keep `/skills/`, `/workspace/`, and the default rejecting backend unchanged.
- [ ] Change `createBackend()` return from `memoryRoute` to `memorySources`.
- [ ] Return memory sources in this order:
  - `/memory/global/USER.md`
  - `/memory/global/AGENTS.md`
  - `/memory/global/MEMORY.md`
  - `/memory/workspaces/current/AGENTS.md` only when workspace exists
  - `/memory/workspaces/current/MEMORY.md` only when workspace exists

Validation wrapper behavior:

```typescript
class RocStoreMemoryBackend {
  constructor(
    private readonly delegate: StoreBackend,
    private readonly allowedKeys: ReadonlySet<string>,
    private readonly scan: SecurityScanService,
    private readonly capacity: CapacityService,
    private readonly kindByKey: ReadonlyMap<string, MemoryKind>
  ) {}

  async write(filePath: string, content: string): Promise<WriteResult> {
    const validation = this.validate(filePath, content);
    if (!validation.ok) {
      return { error: validation.detail };
    }
    return await this.delegate.write(filePath, content);
  }

  async edit(filePath: string, oldString: string, newString: string, replaceAll?: boolean): Promise<EditResult> {
    const raw = await this.delegate.read(filePath);
    if (raw.error || typeof raw.content !== 'string') {
      return { error: raw.error ?? 'memory_file_not_readable' };
    }
    const next = applyEditPreview(raw.content, oldString, newString, replaceAll === true);
    const validation = this.validate(filePath, next);
    if (!validation.ok) {
      return { error: validation.detail };
    }
    return await this.delegate.edit(filePath, oldString, newString, replaceAll);
  }
}
```

Implementation note: DeepAgents `StoreBackend.write()` rejects existing files. Roc UI writes should call `store.put()` directly through the slot service. Agent file-tool edits should use `edit_file` after reading; new empty slots can be created by `write_file`.
Implementation note: DeepAgents JS 1.10.x `StoreBackend` writes FileData v2 values and infers MIME type from the delegated file path. Roc UI direct writes should create Store values compatible with that FileData v2 shape and may explicitly set `mimeType: 'text/markdown'` for markdown slots.

### Tests

Create `tests/main/deep-agent/store-memory-backend.test.ts`:

- [ ] `write('/MEMORY.md', '# notes')` stores a DeepAgents file object in the expected namespace.
- [ ] `read('/MEMORY.md')` returns markdown via `StoreBackend`.
- [ ] rejects non-whitelisted keys.
- [ ] rejects `USER.md` in the workspace route.
- [ ] rejects credential patterns before storing.
- [ ] rejects capacity overflow before storing.
- [ ] `edit` validates final content before delegating.
- [ ] root route prefixes include `/memory/global/` and `/memory/workspaces/current/`.

Update existing backend/executor tests:

- [ ] `tests/main/plugins/agent/deep-agent-executor.test.ts` should expect route prefixes `['/workspace/', '/skills/', '/memory/global/', '/memory/workspaces/current/']` when workspace exists.
- [ ] It should expect `memorySources` to contain the five approved virtual paths.
- [ ] It should expect only global memory sources when no workspace is selected.
- [ ] Remove assertions that require `/memory/` as a single route.

### Verification

- [ ] `pnpm test -- tests/main/deep-agent/store-memory-backend.test.ts tests/main/plugins/agent/deep-agent-executor.test.ts`

## Task 5: Wire The Agent Runtime To The SQLite Store

### Change

- [ ] Add `store: BaseStore` to `AgentDeepAgentExecutorOptions`.
- [ ] In `createAgentPlugin()`, construct `new RocSqliteStore(context.database.getCoreConnection())`.
- [ ] Pass that store into `createAgentDeepAgentExecutor`.
- [ ] Keep `MemorySaver` unchanged unless a direct test proves it conflicts.
- [ ] Remove `const store = new InMemoryStore()` from `createAgentDeepAgentExecutor`.
- [ ] Pass `runtimeBackend.memorySources` into `buildDeepAgent`.
- [ ] Keep `buildDeepAgent()` unchanged except tests should now assert non-empty memory sources when the caller supplies them.

Expected executor shape:

```typescript
export type AgentDeepAgentExecutorOptions = {
  capabilities: RocCapabilityRegistry;
  paths: RocPaths;
  store: BaseStore;
};

export function createAgentDeepAgentExecutor(options: AgentDeepAgentExecutorOptions): AgentDeepAgentExecutor {
  const checkpointer = new MemorySaver();
  return {
    execute: async function* (input) {
      // ...
      const runtimeBackend = createRuntimeBackend({
        capabilities: options.capabilities,
        handle,
        paths: options.paths,
        selectedSkillIds: input.request.enabledCapabilities.skills,
        store: options.store,
        workspace: runtimeWorkspace
      });
      const agent = buildDeepAgent({
        // ...
        backend: runtimeBackend.backend,
        store: options.store,
        memorySources: runtimeBackend.memorySources
      });
    }
  };
}
```

### Verification

- [ ] `pnpm test -- tests/main/plugins/agent/deep-agent-executor.test.ts tests/main/deep-agent-build-wiring.test.ts`

## Task 6: Convert The Memory Plugin To Store-Backed Management

### Change

- [ ] Replace `MemoryRepository` with a Store-backed service, for example `MemoryStoreRepository`.
- [ ] Construct it with `new RocSqliteStore(context.database.getCoreConnection())`.
- [ ] Keep the public capabilities:
  - `memory.status.get`
  - `memory.file.read`
  - `memory.file.write`
  - `memory.snapshot.preview`
- [ ] Update `MemoryFileMeta.absolutePath` to carry the virtual path for now, or rename it to `virtualPath` in shared types and renderer if the edit stays small.
- [ ] Prefer renaming to `virtualPath` only if all renderer and IPC fallout is direct and local. Otherwise keep `absolutePath` as a compatibility field whose value is `/memory/...`.
- [ ] `status()` lists exactly five slot entries, with workspace slot `effective: false` and empty path when no workspace is selected.
- [ ] `readFile()` reads Store value `content`.
- [ ] `writeFile()` validates slot, security scan, and capacity, then calls `store.put(namespace, storeKey, deepAgentsFileValue(content))`.
- [ ] `snapshot.preview` renders from Store content, not disk. Keep the existing UI tab if low cost, but rename copy away from "frozen" if touching renderer tests anyway.
- [ ] Remove `memory.root` requirement from the plugin initializer. `memoryRoot` option remains only if tests need it until deleted; production should not require it.
- [ ] Keep `applyMemoryPluginSchema(db)` only for existing session/consolidation event tables if still used by snapshot/session UI. Remove unused schema once tests prove no capability needs it.

Store value helper:

```typescript
export function createMarkdownFileValue(content: string, existing?: Item | null): Record<string, unknown> {
  const now = new Date().toISOString();
  const createdAt = readCreatedAt(existing) ?? now;
  return {
    content,
    mimeType: 'text/markdown',
    created_at: createdAt,
    modified_at: now
  };
}
```

This helper is only for Roc-owned direct Store writes. Agent file-tool writes
must go through the validated DeepAgents `StoreBackend` wrapper so its read,
write, edit, glob, and grep semantics stay aligned with official backend tools.

### Tests

Update `tests/main/plugins/memory/plugin.test.ts`:

- [ ] initialization does not require `memory.root`.
- [ ] status lists exactly five slots.
- [ ] write/read of global `USER.md` uses Store, not disk.
- [ ] write/read of workspace `MEMORY.md` uses workspace namespace.
- [ ] workspace `USER.md` remains rejected.
- [ ] security and capacity failures are unchanged.
- [ ] snapshot preview reads Store markdown.

Update renderer tests:

- [ ] Memory file list displays virtual paths.
- [ ] File write path still calls `memory.file.write` with `scope`, `kind`, and `content`.
- [ ] Snapshot tab still loads from `memory.snapshot.preview`, if retained.

### Verification

- [ ] `pnpm test -- tests/main/plugins/memory/plugin.test.ts tests/renderer/memory-view.test.tsx tests/renderer/features/memory-feature.test.tsx`

## Task 7: Add Lightweight Automatic Writes To `MEMORY.md`

### Change

- [ ] Create `src/main/services/memory/auto-memory-writer.ts`.
- [ ] Subscribe in the Memory plugin to `agent.run.completed`.
- [ ] Remove the old `MemoryConsolidatorAdapter` event recording.
- [ ] On each completed run, append one conservative markdown bullet to `MEMORY.md` only when `summary.trim()` is non-empty.
- [ ] Write workspace `MEMORY.md` when a workspace is selected; otherwise write global `MEMORY.md`.
- [ ] Deduplicate exact bullets already present in the target file.
- [ ] Respect security scan and capacity. If capacity would overflow, skip and log `memory_auto_write_skipped_capacity`; do not write `USER.md`, `AGENTS.md`, backup files, or review queue records.
- [ ] Do not call an LLM in this first implementation.

Append format:

```markdown
## 2026-06-18

- Completed run <runId>: <summary>
```

Use the event `createdAt` date if available; otherwise use current local date in ISO date format. Keep the summary text as supplied by the agent runtime; do not invent facts.

### Tests

Add tests to `tests/main/plugins/memory/plugin.test.ts` or create `tests/main/memory/auto-memory-writer.test.ts`:

- [ ] completed run appends to workspace `MEMORY.md`.
- [ ] no workspace appends to global `MEMORY.md`.
- [ ] empty summary does nothing.
- [ ] duplicate summary/run line does not append twice.
- [ ] `USER.md` and `AGENTS.md` are never modified by automatic writes.
- [ ] capacity/security failures skip the write and leave existing content unchanged.

### Verification

- [ ] `pnpm test -- tests/main/plugins/memory/plugin.test.ts`

## Task 8: Clean Up Disk Memory Code And Prompts

### Change

- [ ] Delete disk-memory-only modules listed in File Structure.
- [ ] Remove imports of `join(input.paths.memoryDir, ...)` and `WritableMemoryFilesystemBackend`.
- [ ] Remove production use of `paths.memoryDir` / `memory.root` from memory behavior. `RocPaths.memoryDir` may remain only if another unrelated feature still exposes it; it must not be an active compatibility path for memory reads or writes.
- [ ] Update `RocPaths.ensureTree()` if it creates directories only needed by the deleted disk-backed memory path.
- [ ] Update `src/main/services/deep-agent/prompt.ts` and `prompt-builder.ts` wording:
  - replace "changes land on disk immediately" with "changes are stored in Roc SQLite through DeepAgents memory".
  - keep the same five virtual paths.
  - state that automatic writes only append to `MEMORY.md`.
- [ ] Update prompt tests accordingly.
- [ ] Search and remove stale references to:
  - `memory.root`
  - `WritableMemoryFilesystemBackend`
  - `resolveMemoryPath`
  - `.consolidator-backup`
  - "disk-backed memory"
  - `/memory/` as the single memory route, except generic permission docs.
- [ ] Search and either remove or justify any remaining references to:
  - `paths.memoryDir`
  - `memoryDir`
  - `MemoryRepository`
  - `ConsolidatorService`
  - `MemoryConsolidatorAdapter`
  - `tests/main/memory-integration`

### Verification

- [ ] `rg -n "WritableMemoryFilesystemBackend|resolveMemoryPath|memory\\.root|\\.consolidator-backup|changes land on disk" src tests`
- [ ] `rg -n "paths\\.memoryDir|memoryDir|MemoryRepository|ConsolidatorService|MemoryConsolidatorAdapter|tests/main/memory-integration" src tests`
- [ ] `pnpm test -- tests/main/deep-agent-prompt.test.ts tests/main/memory tests/main/plugins/memory/plugin.test.ts`

## Task 9: Run Focused And Broad Verification

### Focused

- [ ] `pnpm test -- tests/main/infrastructure/database-pool.test.ts tests/main/kernel/types.test.ts`
- [ ] `pnpm test -- tests/main/memory/sqlite-store.test.ts tests/main/memory/store-slots.test.ts tests/main/deep-agent/store-memory-backend.test.ts`
- [ ] `pnpm test -- tests/main/plugins/agent/deep-agent-executor.test.ts tests/main/plugins/memory/plugin.test.ts`
- [ ] `pnpm test -- tests/main/deep-agent-build-wiring.test.ts tests/main/deep-agent-prompt.test.ts`
- [ ] `pnpm test -- tests/renderer/memory-view.test.tsx tests/renderer/features/memory-feature.test.tsx`

### Broad

- [ ] `pnpm typecheck`
- [ ] `pnpm test`

Known local note: if `pnpm test` prints `node-pty` `AttachConsole failed` during teardown but exits `0`, treat it as existing non-fatal noise and report it precisely.

## Task 10: Commit

### Change

- [ ] Review `git diff -- src/main src/shared tests docs/superpowers/plans/2026-06-18-deepagents-native-memory-refactor.md`.
- [ ] Confirm no unrelated renderer task files were touched.
- [ ] Commit only files changed for this memory refactor.

Suggested commit:

```powershell
git add src/main src/shared tests docs/superpowers/plans/2026-06-18-deepagents-native-memory-refactor.md
git commit -m "refactor: use deepagents sqlite memory store"
```

## Risks And Boundaries

- Extending `RocPluginContext.database` touches many test fixtures. Keep the runtime change tiny: expose `getCoreConnection()` only; do not add arbitrary database lookup APIs.
- DeepAgents `StoreBackend.write()` rejects existing files. Roc management UI should use direct `store.put()` for save-overwrite semantics.
- `StoreBackend` uses route-stripped keys. That is why global and workspace memory need separate route prefixes rather than one `/memory/` StoreBackend.
- Existing disk memory files are intentionally not migrated. The implementation should not add fallback reads from `paths.memoryDir`.
- No embedding/vector search in this refactor. `BaseStore.search()` lexical/prefix behavior is enough for DeepAgents file listing, grep, and glob.
- `createDeepAgent({ memory })` is the always-on memory loader. The local field name `memorySources` is only Roc internal plumbing; the final call must still pass `memory: runtimeBackend.memorySources`.
