# Phase 5 Integration And Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将微内核接入现有 Electron main/preload/renderer，并完成性能与打包验证。

**Architecture:** 本阶段执行入口切换。现有 `src/main/index.ts` 不重建为模板文件，而是修改为启动 `KernelRuntime`；现有 IPC channel 不改成 wildcard，而是保留 generated channel 并在 handler 内调用插件能力。

**Tech Stack:** Electron 41.6.1, electron-vite 5.0.0, electron-builder 26.8.1, Vitest 4.1.6.

---

## Dependencies

- Phase 1-4 已完成。
- All main-process behavior has a plugin owner.
- Renderer calls are centralized through `RocClient`.

## File Structure

- Modify: `src/main/index.ts`
- Modify: `src/main/ipc/register-ipc.ts`
- Create: `src/main/ipc/plugin-capability-adapter.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/shared/ipc.ts`
- Modify: `src/shared/ipc-schema.json`
- Modify: `scripts/generate-ipc-schema.mjs`
- Modify: `electron.vite.config.ts`
- Modify: `tests/main/preload-contract.test.ts`
- Create: `tests/main/kernel-main-integration.test.ts`
- Create: `tests/main/ipc-plugin-adapter.test.ts`
- Modify: `tests/renderer/bundle-splitting.test.ts`

## Integration Rules

- Do not add `ipcMain.handle('*')`.
- Do not create `vite.config.ts`; this project uses `electron.vite.config.ts`.
- Do not add scripts that are missing from `package.json`; use existing scripts or add a tested script in the same task.
- Do not assume measured performance numbers. Record actual values from smoke artifacts.

## IPC Mapping Contract

Renderer preload method names remain the external contract from `RocPreloadApi`. Capability names are internal microkernel names. `src/main/ipc/plugin-capability-adapter.ts` owns a typed mapping table from preload method to capability and input adapter; renderer code must not call raw capability names.

Required name-mismatch mappings include:

| Preload method | Capability | Input adapter |
|---|---|---|
| `chat.startRun(request)` | `agent.run.start` | pass `request` |
| `chat.cancelRun(runId)` | `agent.run.cancel` | `{ runId }` |
| `chat.resumeRun(request)` | `agent.run.resume` | pass `request` |
| `sessions.list(request)` | `agent.sessions.list` | pass `request` |
| `sessions.search(request)` | `agent.sessions.search` | pass `request` |
| `tasks.runBackgroundNow(id)` | `task.background.runNow` | `{ id }` |
| `tasks.pauseBackgroundTask(id)` | `task.background.pause` | `{ id }` |
| `tasks.resumeBackgroundTask(id)` | `task.background.resume` | `{ id }` |
| `tasks.cancelBackgroundTask(id)` | `task.background.cancel` | `{ id }` |
| `tasks.deleteBackgroundTask(id)` | `task.background.delete` | `{ id }` |
| `tasks.getSchedulerStatus()` | `task.scheduler.status` | `{}` |
| `memory.status()` | `memory.status.get` | `{}` |
| `memory.readFile(request)` | `memory.file.read` | pass `request` |
| `memory.writeFile(request)` | `memory.file.write` | pass `request` |
| `memory.snapshotPreview()` | `memory.snapshot.preview` | `{}` |
| `mcp.deleteServer(id)` | `mcp.deleteServer` | `{ id }` |
| `mcp.testServer(id)` | `mcp.testServer` | `{ id }` |
| `skills.importSkill(request)` | `skills.import` | pass `request` |
| `skills.deleteSkill(id)` | `skills.delete` | `{ id }` |
| `skills.listFiles(request)` | `skills.files.list` | pass `request` |
| `skills.readFile(request)` | `skills.file.read` | pass `request` |
| `diagnostics.createDiagnosticPackage(request)` | `diagnostics.createPackage` | pass `request` |

## Task 1: Main Process Bootstrap

**Files:**
- Modify: `src/main/index.ts`
- Create: `tests/main/kernel-main-integration.test.ts`

- [x] **Step 1: Write integration test**

Assert main bootstrap:
- constructs `KernelRuntime`.
- runs migration before plugin load when plugin data is missing.
- keeps window, tray, app icon, protocol, and host integration behavior.
- shuts down kernel before app exit completes.

Run: `pnpm test -- tests/main/kernel-main-integration.test.ts`
Expected: FAIL.

- [x] **Step 2: Modify existing main entry**

Replace `createAppServices()` usage with kernel bootstrap while preserving current Electron window setup. Do not remove window/material/tray/protocol code.

Run: `pnpm test -- tests/main/kernel-main-integration.test.ts`
Expected: PASS.

## Task 2: IPC Capability Adapter

**Files:**
- Create: `src/main/ipc/plugin-capability-adapter.ts`
- Modify: `src/main/ipc/register-ipc.ts`
- Test: `tests/main/ipc-plugin-adapter.test.ts`
- Test: `tests/main/preload-contract.test.ts`

- [x] **Step 1: Write adapter tests**

Assert each current IPC domain delegates through the mapping table to the matching capability from Phase 2-3. Assert all required name-mismatch mappings above exist. Assert unknown capability fails with current `IpcResult` error shape.

Run: `pnpm test -- tests/main/ipc-plugin-adapter.test.ts tests/main/preload-contract.test.ts`
Expected: FAIL.

- [x] **Step 2: Implement adapter**

`registerIpc()` keeps explicit channel registration and calls `invokeCapability(capabilityName, request)`. Preserve performance timing and slow IPC logging.

Run: `pnpm test -- tests/main/ipc-plugin-adapter.test.ts tests/main/preload-contract.test.ts`
Expected: PASS.

## Task 3: Preload And IPC Schema

**Files:**
- Modify: `src/preload/index.ts`
- Modify: `src/shared/ipc.ts`
- Modify: `src/shared/ipc-schema.json`
- Modify: `scripts/generate-ipc-schema.mjs`
- Test: `tests/main/ipc-schema-generation.test.ts`
- Test: `tests/main/preload-contract.test.ts`

- [x] **Step 1: Write schema tests**

Assert generated channels match existing renderer API names and no wildcard or arbitrary `invokeCapability` is exposed to renderer.

Run: `pnpm test -- tests/main/ipc-schema-generation.test.ts tests/main/preload-contract.test.ts`
Expected: FAIL only if schema is not yet updated.

- [x] **Step 2: Update schema**

Generate typed channels for all plugin-backed APIs that renderer uses. Keep `contextIsolation: true` and typed `window.roc`.

Run: `pnpm check:ipc`
Expected: PASS.

Run: `pnpm test -- tests/main/ipc-schema-generation.test.ts tests/main/preload-contract.test.ts`
Expected: PASS.

## Task 4: Migration Activation

**Files:**
- Modify: `src/main/kernel/kernel-runtime.ts`
- Modify: `src/main/infrastructure/migration/monolith-to-plugins.ts`
- Create: `tests/main/migration/runtime-activation.test.ts`

- [x] **Step 1: Write activation tests**

Assert:
- first start with old database migrates into `plugin-data-next`, promotes it to `plugin-data`, and creates migration run records.
- second start does not rerun migration.
- failed migration keeps old database unchanged and blocks startup with `migration_failed`.
- interrupted migration leaves no valid `.migration-complete.json` and the next start either resumes from a clean `plugin-data-next` or fails with `migration_target_exists`.

Run: `pnpm test -- tests/main/migration/runtime-activation.test.ts`
Expected: FAIL.

- [x] **Step 2: Implement activation**

Runtime migration writes to `<userData>/plugin-data-next` first, using `<userData>/plugin-data-next/.migration-lock` as the lock. After checksum verification passes, the runtime atomically promotes `plugin-data-next` to `<userData>/plugin-data`. A completed migration writes `<userData>/plugin-data/.migration-complete.json` with source checksum and plugin database checksums. If `<userData>/plugin-data` exists without a valid marker, startup fails with `migration_target_exists` rather than overwriting data.

Run: `pnpm test -- tests/main/migration/runtime-activation.test.ts`
Expected: PASS.

## Task 5: Renderer Bundle And Startup Optimization

**Files:**
- Modify: `electron.vite.config.ts`
- Modify: `tests/renderer/bundle-splitting.test.ts`
- Test: `tests/main/performance-observer-service.test.ts`

- [x] **Step 1: Write optimization tests**

Assert existing manual chunk rules remain and feature modules are lazy-loaded where they contain heavy dependencies.

Run: `pnpm test -- tests/renderer/bundle-splitting.test.ts tests/main/performance-observer-service.test.ts`
Expected: FAIL only if current chunk rules need updates for new feature paths.

- [x] **Step 2: Update electron-vite config**

Add or update `resolveRendererManualChunk` rules for actual dependencies in `package.json`. Do not reference `monaco-editor` unless it is added to `package.json` in the same task with tests proving usage.

Run: `pnpm test -- tests/renderer/bundle-splitting.test.ts tests/main/performance-observer-service.test.ts`
Expected: PASS.

## Task 6: Full Integration Verification

**Files:**
- Create: `tests/main/microkernel-regression.test.ts`
- Modify: `tests/main/package-scripts.test.ts`

- [x] **Step 1: Add regression test**

Assert app service status, task lifecycle, chat run, memory snapshot, MCP status, RTK status, workspace file tree, and diagnostics package work through plugin-backed IPC.

Run: `pnpm test -- tests/main/microkernel-regression.test.ts`
Expected: FAIL until Tasks 1-5 are complete.

- [x] **Step 2: Make regression pass**

Fix only integration gaps. Do not add deprecated services back as hidden fallback.

Run: `pnpm test -- tests/main/microkernel-regression.test.ts`
Expected: PASS.

## Phase 5 Verification

- [x] `pnpm test`
- [x] `pnpm typecheck`
- [x] `pnpm build`
- [x] `pnpm package:dir`
- [x] `pnpm smoke:electron`
- [x] `pnpm smoke:performance`

## Phase 5 Exit Criteria

- Main process starts `KernelRuntime`.
- IPC remains explicit and typed.
- Old service aggregator is not used for runtime behavior.
- Smoke artifacts record actual startup, memory, IPC, and packaged evidence.
