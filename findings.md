# Roc 新架构全迁移发现

## Current Architecture Facts

- Main entry `src/main/index.ts` creates `createMainKernelBootstrap`, starts it, then registers IPC and event broadcasts.
- New architecture root is `src/main/main-kernel-bootstrap.ts`.
- New runtime core is `KernelRuntime`, `PluginLoader`, `CapabilityRegistry`, and `EventBus`.
- Plugin interface lives in `src/main/kernel/types.ts`.
- Runtime plugin DBs are managed by `DatabasePool` under `plugin-data/data/plugins/<pluginId>.db`.
- Renderer uses `window.roc` exposed by preload. Main IPC maps preload methods to plugin capabilities in `src/main/ipc/plugin-capability-adapter.ts`.

## Legacy Architecture Still Present

- `src/main/main-kernel-bootstrap.ts` imports `createAppServices` from `src/main/services/app-service.ts`.
- `createMainKernelBootstrap` creates `delegatedAgentRuntimeHost` when default plugins are used.
- `createDefaultMainKernelPlugins` passes a `runtimeDelegate` to `createAgentPlugin`.
- That delegate calls `delegatedAgentRuntimeHost.deepAgentRuntimeService.startRun/cancelRun/resumeRun/onRunEvent`.
- `src/main/services/app-service.ts` is the old composition root and constructs most legacy services.
- `src/main/services/database-service.ts` owns the monolith SQLite connection.
- `src/main/services/paths.ts` still defines `databasePath = join(root, 'roc.sqlite')`.
- `src/main/infrastructure/migration/monolith-to-plugins.ts` copies monolith tables into plugin DBs and is activated from new bootstrap.

## Legacy Data Path Findings

- Old data path: `<root>/roc.sqlite`.
- New data path: `<root>/plugin-data/data/plugins/...`.
- Migration file maps tables:
  - agent: `task_threads`, `task_runs`, `task_events`, `session_messages`, `session_messages_fts`
  - task: `background_tasks`, `scheduled_task_runs`
  - memory: `memory_flush_marks`
  - mcp: `mcp_servers`
  - skills: `skills`
  - diagnostics: `performance_samples`, `diagnostic_packages`, `recovery_points`
- Full objective says delete old data and compatibility paths, so monolith activation should not remain in final state.

## Main Legacy Service Clusters

- `AppService` / `createAppServices`: old composition root.
- `DatabaseService`: monolith SQLite lifecycle.
- `TaskService` and `src/main/services/task/*`: legacy task/session/background-task repository layer tied to `DatabaseService`.
- `MemoryService` and `src/main/services/memory/*`: partially reusable memory logic, but many pieces depend on `DatabaseService`.
- `DeepAgentRuntimeService`: old runtime orchestrator used by delegated agent runtime.
- `TaskSchedulerService`, `LifecycleService`, `DiagnosticsService`, `HealthCheckService`: old service graph consumers.

## New Plugin Counterparts

- `src/main/plugins/agent`: Agent capability, session repository, runtime adapter.
- `src/main/plugins/task`: Background task repository/scheduler and event subscription.
- `src/main/plugins/memory`: Memory repository and consolidator adapter.
- `src/main/plugins/workspace`: workspace/files/git/terminal capabilities.
- `src/main/plugins/mcp`, `skills`, `diagnostics`, `runtime-tools`: plugin-owned capabilities.

## Test Surface Findings

- Many legacy tests import `createAppServices` or `app-service-fixtures`.
- Legacy tests include `tests/main/app-services*.test.ts`, `tests/main/app-service-fixtures.ts`, multiple deep-agent/task/memory/provider tests, and manual scripts.
- Existing plugin tests already cover kernel/plugin behavior under `tests/main/plugins/**` and `tests/main/kernel/**`.
- Migration tests exist under `tests/main/migration/**` and should be removed or rewritten as "no legacy migration" assertions in final state.
- `tests/main/legacy-chat-runtime-cleanup.test.ts` still imports `createAppServices`; it checks removed `chatService`, but now preserves the legacy composition root as a test dependency.
- `tests/main/kernel-main-integration.test.ts` already asserts `src/main/index.ts` does not contain `createAppServices`, `activeServices`, `services.`, `deepAgentRuntimeService.onRunEvent`, or `taskSchedulerService.handlePowerResume`.
- `tests/main/kernel-main-integration.test.ts` still expects migration activation to run before plugin load, which conflicts with the final objective of deleting old monolith migration.
- `tests/main/release-readiness.test.ts` currently reports `pluginDataMigration.status` as `present`, also conflicting with the final "delete old compatibility migration" state.
- `tests/main/microkernel-regression.test.ts` exercises plugin-backed IPC with `StaticAgentModelFactoryAdapter`; it proves plugin capability routing works, but not full DeepAgents tool runtime parity.

## Risk Notes

- Directly deleting `app-service.ts` first will break agent runtime because plugin agent currently delegates actual DeepAgent execution to legacy host.
- DeepAgent runtime depends on many old services. Need replace constructor dependencies before deletion.
- Data removal policy confirmed by user: delete old data directly from disk. Safety requirement: deletion must be constrained to Roc data root and exact legacy DB file names; no recursive directory deletion and no arbitrary path deletion.
- Settings config migration is separate from DB architecture. It may still contain `legacy` terminology for config schema upgrades; decide later whether objective includes config compatibility removal.
- `AgentPluginRuntime` has a non-delegate path, but it only streams directly from model handles. It does not provide the full DeepAgents tool/session/checkpointer/approval runtime currently implemented by `DeepAgentRuntimeService`.
- First implementation cut should make `@roc/plugin-agent` own the full runtime path, not merely remove `runtimeDelegate`.

## Candidate First Cut

- Add a plugin-native DeepAgent runtime adapter inside `src/main/plugins/agent/`.
- Keep public `agent.run.*` capability unchanged.
- Reuse pure lower-level modules where they are not composition roots:
  - `langchain-model-factory`
  - `deep-agent/*` prompt/tool/stream helpers
  - `mcp-service` adapters only until plugin-native capability adapters replace them
  - `workspace/file/shell/runtime-tools` behavior through capabilities where possible
- Remove `runtimeDelegate` only after plugin-native chat/task run parity is covered by tests.

## Completed Findings From First Implementation Cut

- `src/main/main-kernel-bootstrap.ts` no longer imports `createAppServices`.
- Default bootstrap no longer constructs `delegatedAgentRuntimeHost`.
- Default bootstrap no longer passes `runtimeDelegate` into `createAgentPlugin`.
- `createAgentPlugin` no longer accepts `runtimeDelegate`.
- `AgentPluginRuntime` no longer contains delegated run state, delegated event subscription, delegated cancel/resume branches, or delegated chat task-event projection.
- Default bootstrap still uses `KernelRuntime.activateMigration` callback, but the callback now performs legacy DB cleanup rather than migration.
- Old monolith migration source and tests are deleted.
- Old service-specific IPC files are deleted; public renderer domains are routed through `plugin-capability-adapter` except retained boundary handlers.
- Old app-service composition root, monolith `DatabaseService`, old DB-backed task/memory service graph, and old delegated `DeepAgentRuntimeService` are deleted.
- Provider/model tests now use a direct provider fixture instead of `createAppServices`.
- `RocPaths` and `RocPathsSnapshot` no longer expose `databasePath`.
- `AgentPluginRuntime` non-delegate path is now the default app path; it produces `run_...` IDs for chat instead of old delegated `chat_...` IDs.
- Focused evidence: `pnpm vitest run tests/main/infrastructure/legacy-data-cleanup.test.ts tests/main/kernel-main-integration.test.ts tests/main/release-readiness.test.ts tests/main/package-scripts.test.ts` passed.
- Type evidence: `pnpm typecheck` passed.

## Legacy Data Deletion Design Note

- Allowed targets:
  - `<dataRoot>/roc.sqlite`
  - `<dataRoot>/roc.sqlite-wal`
  - `<dataRoot>/roc.sqlite-shm`
  - `<dataRoot>/roc.sqlite.phase1-backup-*`
  - `<dataRoot>/roc.sqlite.bak-*`
- Required guard:
  - Resolve absolute path.
  - Confirm parent directory equals resolved `paths.root`.
  - Confirm basename matches allowed exact/prefix rules.
  - Confirm target is not a directory before unlink.
  - Missing files are success.
