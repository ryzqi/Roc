# Phase 4 Renderer Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 renderer 重构为 feature modules，并通过 typed client 调用微内核能力。

**Architecture:** Renderer 不直接知道插件实现，只通过 `RocClient` 调用 preload 暴露的 typed API。`App.tsx` 降为 shell 入口；现有 chat、tasks、memory、settings、workbench、mcp、skills、diagnostics UI 按功能域拆分，视觉和交互不在本阶段重新设计。

**Tech Stack:** React 19.2.6, TypeScript 6.0.3, Lucide React 1.16.0, Motion 12.39.0, Vitest 4.1.6.

---

## Dependencies

- Phase 1-3 插件能力合同已完成。
- Phase 5 尚未切换 main/preload；本阶段 `RocClient` 先包裹当前 `window.roc` API，Phase 5 再把 preload handler 指向插件能力。
- 不创建 `src/renderer/features/chat-panel/Chat.tsx`。当前源码来源是 `src/renderer/App.tsx`, `src/renderer/chat/*`, `src/renderer/views/*`, `src/renderer/workbench/*`, `src/renderer/settings/*`, `src/renderer/skills-view.tsx`, `src/renderer/skill-drawer.tsx`。

## File Structure

- Create: `src/renderer/shared/roc-client.ts`
- Create: `src/renderer/shared/async-state.ts`
- Create: `src/renderer/app/AppShell.tsx`
- Create: `src/renderer/app/use-app-bootstrap.ts`
- Create: `src/renderer/features/chat/index.tsx`
- Create: `src/renderer/features/chat/use-chat-feature.ts`
- Create: `src/renderer/features/tasks/index.tsx`
- Create: `src/renderer/features/tasks/use-task-feature.ts`
- Create: `src/renderer/features/memory/index.tsx`
- Create: `src/renderer/features/settings/index.tsx`
- Create: `src/renderer/features/workspace/index.tsx`
- Create: `src/renderer/features/mcp/index.tsx`
- Create: `src/renderer/features/skills/index.tsx`
- Create: `src/renderer/features/diagnostics/index.tsx`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/views/ViewContent.tsx`
- Test: `tests/renderer/shared/roc-client.test.ts`
- Test: `tests/renderer/app-shell.test.tsx`
- Test: `tests/renderer/features/*.test.tsx`

## Renderer Contract

`src/renderer/shared/roc-client.ts` is the only module that reads `window.roc`.

```typescript
import type { RocPreloadApi } from '../../shared/ipc';

export type RocClient = {
  readonly api: RocPreloadApi;
};

export function createRocClient(api: RocPreloadApi = window.roc): RocClient {
  return { api };
}
```

Feature hooks receive `RocClient` as an argument. Tests inject a fake client; feature components do not mock `window.roc`.

## Task 1: Shared Client And Async State

**Files:**
- Create: `src/renderer/shared/roc-client.ts`
- Create: `src/renderer/shared/async-state.ts`
- Test: `tests/renderer/shared/roc-client.test.ts`
- Test: `tests/renderer/shared/async-state.test.ts`

- [x] **Step 1: Write tests**

Assert:
- `createRocClient()` returns the provided API.
- async state explicitly distinguishes `idle`, `loading`, `loaded`, and `failed`.
- failed state carries a message string.

Run: `pnpm test -- tests/renderer/shared/roc-client.test.ts tests/renderer/shared/async-state.test.ts`
Expected: FAIL.

- [x] **Step 2: Implement shared modules**

Do not add a custom Observable system. React state and existing hooks remain the state mechanism.

Run: `pnpm test -- tests/renderer/shared/roc-client.test.ts tests/renderer/shared/async-state.test.ts`
Expected: PASS.

## Task 2: App Shell

**Files:**
- Create: `src/renderer/app/AppShell.tsx`
- Create: `src/renderer/app/use-app-bootstrap.ts`
- Modify: `src/renderer/App.tsx`
- Test: `tests/renderer/app-shell.test.tsx`
- Test: `tests/renderer/startup-load-policy.test.ts`

- [x] **Step 1: Write shell tests**

Assert `AppShell` renders current navigation, window controls, selected view, settings modal trigger, and task update subscription.

Run: `pnpm test -- tests/renderer/app-shell.test.tsx tests/renderer/startup-load-policy.test.ts`
Expected: FAIL.

- [x] **Step 2: Extract shell**

Move shell-only state from `App.tsx` into `AppShell` and `useAppBootstrap`. `App.tsx` should only create `RocClient`, bootstrap, and render `AppShell`.

Run: `pnpm test -- tests/renderer/app-shell.test.tsx tests/renderer/startup-load-policy.test.ts`
Expected: PASS.

## Task 3: Chat Feature

**Files:**
- Create: `src/renderer/features/chat/index.tsx`
- Create: `src/renderer/features/chat/use-chat-feature.ts`
- Modify: `src/renderer/chat/chat-view.tsx`
- Modify: `src/renderer/chat/use-chat-run.ts`
- Test: `tests/renderer/features/chat-feature.test.tsx`
- Test: existing chat renderer tests.

- [x] **Step 1: Write feature tests**

Assert chat start, resume, cancel, stream event subscription, queued task prompt, and transcript rendering use `RocClient.api.chat` and `RocClient.api.tasks`.

Run: `pnpm test -- tests/renderer/features/chat-feature.test.tsx tests/renderer/chat-view.test.ts tests/renderer/chat-view.queued-task.test.ts`
Expected: FAIL.

- [x] **Step 2: Implement feature wrapper**

Move feature orchestration into `useChatFeature`. Keep existing message row, composer, markdown, and transcript components unless a test requires a split.

Run: `pnpm test -- tests/renderer/features/chat-feature.test.tsx tests/renderer/chat-view.test.ts tests/renderer/chat-view.queued-task.test.ts`
Expected: PASS.

## Task 4: Tasks And Memory Features

**Files:**
- Create: `src/renderer/features/tasks/index.tsx`
- Create: `src/renderer/features/tasks/use-task-feature.ts`
- Create: `src/renderer/features/memory/index.tsx`
- Modify: `src/renderer/views/tasks/*`
- Modify: `src/renderer/views/memory/*`
- Test: `tests/renderer/features/tasks-feature.test.tsx`
- Test: `tests/renderer/features/memory-feature.test.tsx`
- Test: existing tasks and memory renderer tests.

- [x] **Step 1: Write tests**

Tasks tests cover create preview, create background task, run now, pause/resume/cancel/delete, open in chat. Memory tests cover status, read file, write file, session search, snapshot preview.

Run: `pnpm test -- tests/renderer/features/tasks-feature.test.tsx tests/renderer/features/memory-feature.test.tsx`
Expected: FAIL.

- [x] **Step 2: Implement features**

Move feature-level loading and action handlers out of `App.tsx` and `ViewContent.tsx`. Preserve current test IDs.

Run: `pnpm test -- tests/renderer/features/tasks-feature.test.tsx tests/renderer/features/memory-feature.test.tsx tests/renderer/tasks-view.test.ts`
Expected: PASS.

## Task 5: Settings, Workspace, MCP, Skills, Diagnostics Features

**Files:**
- Create: `src/renderer/features/settings/index.tsx`
- Create: `src/renderer/features/workspace/index.tsx`
- Create: `src/renderer/features/mcp/index.tsx`
- Create: `src/renderer/features/skills/index.tsx`
- Create: `src/renderer/features/diagnostics/index.tsx`
- Modify: `src/renderer/settings/*`
- Modify: `src/renderer/workbench/*`
- Modify: `src/renderer/views/mcp/*`
- Modify: `src/renderer/views/skills/*`
- Modify: `src/renderer/views/diagnostics/*`
- Test: `tests/renderer/features/settings-feature.test.tsx`
- Test: `tests/renderer/features/workspace-feature.test.tsx`
- Test: `tests/renderer/features/mcp-feature.test.tsx`
- Test: `tests/renderer/features/skills-feature.test.tsx`
- Test: `tests/renderer/features/diagnostics-feature.test.tsx`

- [x] **Step 1: Write tests**

Assert each feature calls only `RocClient`, not `window.roc` directly.

Run: `pnpm test -- tests/renderer/features/settings-feature.test.tsx tests/renderer/features/workspace-feature.test.tsx tests/renderer/features/mcp-feature.test.tsx tests/renderer/features/skills-feature.test.tsx tests/renderer/features/diagnostics-feature.test.tsx`
Expected: FAIL.

- [x] **Step 2: Implement features**

Keep existing visual layout and CSS. Do not introduce landing-page or marketing content.

Run: `pnpm test -- tests/renderer/features/settings-feature.test.tsx tests/renderer/features/workspace-feature.test.tsx tests/renderer/features/mcp-feature.test.tsx tests/renderer/features/skills-feature.test.tsx tests/renderer/features/diagnostics-feature.test.tsx`
Expected: PASS.

## Task 6: App Size And Boundary Guard

**Files:**
- Modify: `tests/renderer/bundle-boundaries.test.ts`
- Create: `tests/renderer/renderer-boundaries.test.ts`

- [x] **Step 1: Add boundary tests**

Assert:
- `src/renderer/App.tsx` is under 180 lines.
- only `src/renderer/shared/roc-client.ts` references `window.roc`.
- no `../../core/Observable` or `../../hooks/useObservable` imports exist.

Run: `pnpm test -- tests/renderer/renderer-boundaries.test.ts tests/renderer/bundle-boundaries.test.ts`
Expected: FAIL until Tasks 1-5 are complete.

- [x] **Step 2: Make boundary tests pass**

Move remaining orchestration into feature hooks. Do not change UI behavior to satisfy line-count tests.

Run: `pnpm test -- tests/renderer/renderer-boundaries.test.ts tests/renderer/bundle-boundaries.test.ts`
Expected: PASS.

## Phase 4 Verification

- [x] `pnpm test -- tests/renderer`
- [x] `pnpm typecheck`
- [x] `pnpm build`

## Phase 4 Exit Criteria

- Renderer feature modules exist for every visible app domain.
- `App.tsx` is a shell entry, not the app orchestrator.
- `window.roc` direct usage is centralized in `src/renderer/shared/roc-client.ts`.
- No main/preload/plugin runtime behavior is changed in this phase.
