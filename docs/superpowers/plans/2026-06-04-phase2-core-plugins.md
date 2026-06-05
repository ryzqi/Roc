# Phase 2 Core Plugins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Agent、Memory、Task 三个核心域迁移到 Phase 1 微内核插件合同。

**Architecture:** 本阶段坚持完整微内核重构。核心业务不再通过 `createAppServices()` 聚合长期运行，而是通过 `RocPlugin`、`RocPluginContext`、能力注册和事件总线运行；旧服务代码只作为迁移参考，最终入口由 Phase 5 切换。

**Tech Stack:** TypeScript 6.0.3, LangChain 1.4.1, DeepAgents 1.10.2, Better-SQLite3 12.10.0, Zod 4.4.3, Vitest 4.1.6.

---

## Dependencies

- Phase 1 已完成。
- 唯一插件类型来自 `src/main/kernel/types.ts`。
- 插件路径统一为 `src/main/plugins/<plugin>/`。
- 生命周期方法统一为 `initialize`, `shutdown`, `healthCheck`。
- Event bus 方法统一为 `publish`, `subscribe`。

## File Structure

- Create: `src/main/plugins/agent/index.ts`
- Create: `src/main/plugins/agent/schema.ts`
- Create: `src/main/plugins/agent/session-repository.ts`
- Create: `src/main/plugins/agent/runtime.ts`
- Create: `src/main/plugins/agent/model-factory-adapter.ts`
- Create: `src/main/plugins/memory/index.ts`
- Create: `src/main/plugins/memory/schema.ts`
- Create: `src/main/plugins/memory/memory-repository.ts`
- Create: `src/main/plugins/memory/consolidator-adapter.ts`
- Create: `src/main/plugins/task/index.ts`
- Create: `src/main/plugins/task/schema.ts`
- Create: `src/main/plugins/task/task-repository.ts`
- Create: `src/main/plugins/task/scheduler.ts`
- Test: `tests/main/plugins/agent/*.test.ts`
- Test: `tests/main/plugins/memory/*.test.ts`
- Test: `tests/main/plugins/task/*.test.ts`
- Test: `tests/main/plugins/core-plugins.integration.test.ts`

## Capability Contract

Core plugins register these capability names:

These names are the internal microkernel capability contract. They do not rename the renderer preload API. Phase 5 owns the explicit preload-method-to-capability mapping.

| Plugin | Capability | Input | Output |
|---|---|---|---|
| `@roc/plugin-agent` | `agent.status.get` | `{}` | current agent runtime status |
| `@roc/plugin-agent` | `agent.run.start` | current `ChatStartRunRequest` | current `ChatStartRunResult` |
| `@roc/plugin-agent` | `agent.run.cancel` | `{ runId: string }` | current cancel result |
| `@roc/plugin-agent` | `agent.run.resume` | current `ChatResumeRunRequest` | current resume result |
| `@roc/plugin-agent` | `agent.sessions.list` | `{ threadId: string; limit?: number }` | current session messages |
| `@roc/plugin-agent` | `agent.sessions.search` | current search request | current search result |
| `@roc/plugin-memory` | `memory.status.get` | `{}` | current memory status |
| `@roc/plugin-memory` | `memory.file.read` | current read request | `string \| null` |
| `@roc/plugin-memory` | `memory.file.write` | current write request | current write outcome |
| `@roc/plugin-memory` | `memory.snapshot.preview` | `{}` | `{ text: string }` |
| `@roc/plugin-task` | `task.snapshot.get` | `{}` | current task snapshot |
| `@roc/plugin-task` | `task.background.preview` | current preview request | current preview |
| `@roc/plugin-task` | `task.background.create` | current preview | current background task |
| `@roc/plugin-task` | `task.background.update` | current update request | current background task |
| `@roc/plugin-task` | `task.background.runNow` | `{ id: string }` | `{ taskId: string; runId: string }` |
| `@roc/plugin-task` | `task.background.pause` | `{ id: string }` | current background task |
| `@roc/plugin-task` | `task.background.resume` | `{ id: string }` | current background task |
| `@roc/plugin-task` | `task.background.cancel` | `{ id: string }` | current background task |
| `@roc/plugin-task` | `task.background.delete` | `{ id: string }` | `{ deleted: true; taskId: string }` |
| `@roc/plugin-task` | `task.scheduler.status` | `{}` | current scheduler status |

Use current shared request/result types from `src/shared/types/*`. If a current shared type is incomplete, modify the shared type before modifying the plugin.

## Task 1: Agent Plugin Schema And Repository

**Files:**
- Create: `src/main/plugins/agent/schema.ts`
- Create: `src/main/plugins/agent/session-repository.ts`
- Test: `tests/main/plugins/agent/session-repository.test.ts`

- [ ] **Step 1: Write repository tests**

Assert the repository reads and writes migrated rows for `task_threads`, `task_runs`, `task_events`, and `session_messages` in the agent plugin database.

Run: `pnpm test -- tests/main/plugins/agent/session-repository.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement schema and repository**

The plugin database keeps current column names unless the test proves a rename is necessary. Preserve `thread_id`, `run_id`, event `payload_json`, and message `phase`.

Run: `pnpm test -- tests/main/plugins/agent/session-repository.test.ts`
Expected: PASS.

## Task 2: Agent Plugin Runtime

**Files:**
- Create: `src/main/plugins/agent/runtime.ts`
- Create: `src/main/plugins/agent/model-factory-adapter.ts`
- Create: `src/main/plugins/agent/index.ts`
- Test: `tests/main/plugins/agent/plugin.test.ts`
- Test: `tests/main/plugins/agent/runtime.test.ts`

- [ ] **Step 1: Write plugin tests**

Assert manifest:
- `id: '@roc/plugin-agent'`
- `loadPhase: 'critical'`
- `required: true`
- capabilities exactly match the Agent entries in Capability Contract.

Run: `pnpm test -- tests/main/plugins/agent/plugin.test.ts`
Expected: FAIL.

- [ ] **Step 2: Migrate runtime behavior**

Move behavior from current `DeepAgentRuntimeService`, `AgentService`, and `LangChainModelFactory` into plugin-owned collaborators without changing shared request/result contracts.

Run: `pnpm test -- tests/main/plugins/agent/plugin.test.ts tests/main/plugins/agent/runtime.test.ts`
Expected: PASS.

## Task 3: Memory Plugin

**Files:**
- Create: `src/main/plugins/memory/schema.ts`
- Create: `src/main/plugins/memory/memory-repository.ts`
- Create: `src/main/plugins/memory/consolidator-adapter.ts`
- Create: `src/main/plugins/memory/index.ts`
- Test: `tests/main/plugins/memory/plugin.test.ts`
- Test: `tests/main/plugins/memory/consolidator-adapter.test.ts`

- [ ] **Step 1: Write memory plugin tests**

Assert manifest:
- `id: '@roc/plugin-memory'`
- `dependencies: ['@roc/plugin-agent']`
- `loadPhase: 'critical'`
- no deferred extraction path; every manifest capability is declared before initialize and has a bound handler after initialize.

Run: `pnpm test -- tests/main/plugins/memory/plugin.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement memory plugin**

Migrate current `MemoryService`, `memory/consolidator`, `memory/precompaction`, `memory/session-archive`, and memory path resolver behavior. The plugin subscribes to `agent.run.completed` and `agent.session.archived` through `subscribe`.

Run: `pnpm test -- tests/main/plugins/memory/plugin.test.ts tests/main/plugins/memory/consolidator-adapter.test.ts`
Expected: PASS.

## Task 4: Task Plugin Repository And Scheduler

**Files:**
- Create: `src/main/plugins/task/schema.ts`
- Create: `src/main/plugins/task/task-repository.ts`
- Create: `src/main/plugins/task/scheduler.ts`
- Test: `tests/main/plugins/task/task-repository.test.ts`
- Test: `tests/main/plugins/task/scheduler.test.ts`

- [ ] **Step 1: Write repository and scheduler tests**

Assert current background task semantics:
- create preview uses `description` input and `workflowHint: 'propose_background_task'`.
- scheduler reads `background_tasks` and `scheduled_task_runs`.
- pause/resume/cancel/delete preserve current status names.

Run: `pnpm test -- tests/main/plugins/task/task-repository.test.ts tests/main/plugins/task/scheduler.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement repository and scheduler**

Move current `TaskService`, `TaskSchedulerService`, and `src/main/services/task/*` behavior behind plugin capabilities. Do not introduce shell command execution in this plugin; command execution stays in the Runtime Tools plugin from Phase 3.

Run: `pnpm test -- tests/main/plugins/task/task-repository.test.ts tests/main/plugins/task/scheduler.test.ts`
Expected: PASS.

## Task 5: Task Plugin Entry

**Files:**
- Create: `src/main/plugins/task/index.ts`
- Test: `tests/main/plugins/task/plugin.test.ts`

- [ ] **Step 1: Write plugin tests**

Assert manifest:
- `id: '@roc/plugin-task'`
- `dependencies: ['@roc/plugin-agent']`
- `loadPhase: 'critical'`
- capabilities exactly match the Task entries in Capability Contract.

Run: `pnpm test -- tests/main/plugins/task/plugin.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement plugin**

Initialize repository, scheduler, and event subscriptions. Publish `task.updated` after every mutation that currently triggers renderer refresh.

Run: `pnpm test -- tests/main/plugins/task/plugin.test.ts`
Expected: PASS.

## Task 6: Core Plugin Integration

**Files:**
- Create: `tests/main/plugins/core-plugins.integration.test.ts`

- [ ] **Step 1: Write integration test**

Start a `KernelRuntime` with Agent, Memory, and Task plugins against a temp plugin-data directory. Assert:
- all critical plugins load.
- Agent can create a run record.
- Task can create a background task preview.
- Memory can read snapshot preview.
- cross-plugin event delivery updates Memory after an Agent run completion event.

Run: `pnpm test -- tests/main/plugins/core-plugins.integration.test.ts`
Expected: FAIL until Tasks 1-5 are complete.

- [ ] **Step 2: Make integration pass**

Fix only contract mismatches found by the integration test. Do not add compatibility aliases for old lifecycle names.

Run: `pnpm test -- tests/main/plugins/core-plugins.integration.test.ts`
Expected: PASS.

## Phase 2 Verification

- [ ] `pnpm test -- tests/main/plugins/agent tests/main/plugins/memory tests/main/plugins/task tests/main/plugins/core-plugins.integration.test.ts`
- [ ] `pnpm typecheck`
- [ ] `pnpm build`

## Phase 2 Exit Criteria

- No file under `src/plugins/` or `src/main/plugins/*/index.test.ts` is created.
- No plugin uses `init`, `cleanup`, `eventBus.on`, `eventBus.emit`, `manifest.priority`, or string-array capabilities.
- Agent, Memory, and Task shared request/result contracts remain compatible with current renderer until Phase 4 changes the renderer.
