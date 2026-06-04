# Phase 1 Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 Roc 微内核基础设施，作为后续插件化重构的唯一运行时合同。

**Architecture:** 这是破坏性重构的第一阶段。Phase 1 不保留旧 `AppServices` / `DatabaseService` 作为长期兼容层，而是建立 `KernelRuntime`、插件合同、能力注册、事件总线、插件数据库池和真实数据迁移入口；旧服务只作为迁移源读取。

**Tech Stack:** TypeScript 6.0.3, Electron 41.6.1, Better-SQLite3 12.10.0, Zod 4.4.3, Vitest 4.1.6.

---

## Series Contract

- 微内核代码只放在 `src/main/kernel/`。
- 基础设施代码只放在 `src/main/infrastructure/`。
- 插件代码只放在 `src/main/plugins/<plugin-id>/`。
- Renderer 只能通过 typed preload API 调用能力，不允许 `ipcMain.handle('*')` 或 renderer 任意字符串直通主进程。
- 数据迁移以当前单库 schema 为源：`task_threads`, `task_runs`, `task_events`, `session_messages`, `background_tasks`, `scheduled_task_runs`, `memory_flush_marks`, `mcp_servers`, `skills`, `performance_samples`, `diagnostic_packages`, `recovery_points`。
- 本阶段验收命令只使用当前存在的脚本：`pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm package:dir`, `pnpm smoke:electron`, `pnpm smoke:performance`。

## File Structure

- Create: `src/main/kernel/types.ts` - 插件、能力、事件、生命周期类型。
- Create: `src/main/kernel/event-bus.ts` - typed event bus。
- Create: `src/main/kernel/capability-registry.ts` - 能力注册和调用。
- Create: `src/main/kernel/plugin-loader.ts` - 插件装载、依赖排序、启动失败策略。
- Create: `src/main/kernel/kernel-runtime.ts` - 内核启动、关闭、健康检查。
- Create: `src/main/kernel/index.ts` - main process 内部导出。
- Create: `src/main/infrastructure/database-pool.ts` - per-plugin SQLite 连接池。
- Create: `src/main/infrastructure/config-store.ts` - core/plugin 配置读写。
- Create: `src/main/infrastructure/secret-manager.ts` - safeStorage-backed secret facade。
- Create: `src/main/infrastructure/logger.ts` - 结构化日志 facade。
- Create: `src/main/infrastructure/schema-registry.ts` - 插件 schema 初始化。
- Create: `src/main/infrastructure/migration/monolith-to-plugins.ts` - 当前单库到插件库迁移。
- Test: `tests/main/kernel/*.test.ts`。
- Test: `tests/main/infrastructure/*.test.ts`。
- Test: `tests/main/migration/monolith-to-plugins.test.ts`。

## Canonical Contracts

`src/main/kernel/types.ts` 必须定义以下合同，后续所有 phase 只能引用这些名称：

```typescript
import type { z } from 'zod';

export type PluginLoadPhase = 'critical' | 'deferred' | 'on_demand';
export type RocPluginHealth = { status: 'healthy' } | { status: 'degraded'; reason: string } | { status: 'unhealthy'; reason: string };

export type CapabilityDescriptor<TInput = unknown, TOutput = unknown> = {
  readonly name: string;
  readonly version: string;
  readonly inputSchema: z.ZodType<TInput>;
  readonly outputSchema: z.ZodType<TOutput>;
};

export type RocPluginManifest = {
  readonly id: string;
  readonly version: string;
  readonly displayName: string;
  readonly description: string;
  readonly loadPhase: PluginLoadPhase;
  readonly required: boolean;
  readonly order: number;
  readonly dependencies: readonly string[];
  readonly capabilities: readonly CapabilityDescriptor[];
};

export type RocEventEnvelope<TPayload = unknown> = {
  readonly type: string;
  readonly source: string;
  readonly payload: TPayload;
  readonly createdAt: string;
};

export type EventSubscription = () => void;

export type RocEventBus = {
  publish<TPayload>(event: RocEventEnvelope<TPayload>): void;
  subscribe<TPayload>(type: string, handler: (event: RocEventEnvelope<TPayload>) => void): EventSubscription;
};

export type RocCapabilityRegistry = {
  register(pluginId: string, descriptor: CapabilityDescriptor, handler: (input: unknown) => Promise<unknown>): void;
  invoke<TInput, TOutput>(name: string, input: TInput): Promise<TOutput>;
  list(): readonly CapabilityDescriptor[];
};

export type RocPluginContext = {
  readonly pluginId: string;
  readonly eventBus: RocEventBus;
  readonly capabilities: RocCapabilityRegistry;
  readonly database: { getConnection(pluginId: string): import('better-sqlite3').Database };
  readonly config: { get<T>(pluginId: string, key: string): T | null; set<T>(pluginId: string, key: string, value: T): void };
  readonly secrets: { get(key: string): string | null; set(key: string, plaintext: string): void; clear(key: string): void };
  readonly logger: { info(message: string, metadata?: Record<string, unknown>): void; warn(message: string, metadata?: Record<string, unknown>): void; error(message: string, metadata?: Record<string, unknown>): void };
};

export type RocPlugin = {
  readonly manifest: RocPluginManifest;
  initialize(context: RocPluginContext): Promise<void>;
  shutdown(): Promise<void>;
  healthCheck(): Promise<RocPluginHealth>;
};
```

## Task 1: Kernel Types And Contract Tests

**Files:**
- Create: `src/main/kernel/types.ts`
- Test: `tests/main/kernel/types.test.ts`

- [ ] **Step 1: Write contract tests**

Test exact manifest shape, lifecycle names, event bus method names, and capability descriptor schemas.

Run: `pnpm test -- tests/main/kernel/types.test.ts`
Expected: FAIL because `src/main/kernel/types.ts` does not exist.

- [ ] **Step 2: Implement `types.ts` exactly from Canonical Contracts**

Do not add aliases named `Plugin`, `PluginManifest`, `init`, `cleanup`, `on`, or `emit`.

Run: `pnpm test -- tests/main/kernel/types.test.ts`
Expected: PASS.

## Task 2: Event Bus

**Files:**
- Create: `src/main/kernel/event-bus.ts`
- Test: `tests/main/kernel/event-bus.test.ts`

- [ ] **Step 1: Test behavior**

Assert:
- `subscribe()` receives matching event types.
- unsubscribe stops delivery.
- handler order follows subscription order.
- one handler failure is reported and does not prevent later handlers.

Run: `pnpm test -- tests/main/kernel/event-bus.test.ts`
Expected: FAIL because `EventBus` is missing.

- [ ] **Step 2: Implement `EventBus`**

Implement public methods `publish` and `subscribe` only. Errors thrown by handlers must be collected and logged through constructor-injected logger; they must not be swallowed silently.

Run: `pnpm test -- tests/main/kernel/event-bus.test.ts`
Expected: PASS.

## Task 3: Capability Registry

**Files:**
- Create: `src/main/kernel/capability-registry.ts`
- Test: `tests/main/kernel/capability-registry.test.ts`

- [ ] **Step 1: Test registry**

Assert:
- duplicate capability names fail.
- input schema validates before handler invocation.
- output schema validates after handler invocation.
- unknown capability fails with `capability_not_found`.

Run: `pnpm test -- tests/main/kernel/capability-registry.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement registry**

Use Zod parse results directly. Do not default missing input fields.

Run: `pnpm test -- tests/main/kernel/capability-registry.test.ts`
Expected: PASS.

## Task 4: Database Pool And Schema Registry

**Files:**
- Create: `src/main/infrastructure/database-pool.ts`
- Create: `src/main/infrastructure/schema-registry.ts`
- Test: `tests/main/infrastructure/database-pool.test.ts`
- Test: `tests/main/infrastructure/schema-registry.test.ts`

- [ ] **Step 1: Test database boundaries**

Assert each plugin receives `data/plugins/<plugin-id>.db`, foreign keys and WAL are enabled, and `closeAll()` closes every connection.

Run: `pnpm test -- tests/main/infrastructure/database-pool.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement database pool**

Plugin IDs must match `@roc/plugin-[a-z0-9-]+`. Use the scoped ID as path segments, so `@roc/plugin-agent` maps to `data/plugins/@roc/plugin-agent.db`. Reject invalid IDs; do not sanitize them into unrelated filenames.

Run: `pnpm test -- tests/main/infrastructure/database-pool.test.ts`
Expected: PASS.

- [ ] **Step 3: Implement schema registry**

`SchemaRegistry.apply(pluginId, sql)` executes schema against that plugin database and records applied schema version in `core.db` table `plugin_schema_versions(plugin_id, version, applied_at)`.

Run: `pnpm test -- tests/main/infrastructure/schema-registry.test.ts`
Expected: PASS.

## Task 5: Config, Secrets, Logger

**Files:**
- Create: `src/main/infrastructure/config-store.ts`
- Create: `src/main/infrastructure/secret-manager.ts`
- Create: `src/main/infrastructure/logger.ts`
- Test: `tests/main/infrastructure/config-store.test.ts`
- Test: `tests/main/infrastructure/secret-manager.test.ts`
- Test: `tests/main/infrastructure/logger.test.ts`

- [ ] **Step 1: Preserve current config migration contract**

Config store must read current settings through existing JSON files as the source for migration, then write plugin-scoped records into `core.db`.

Run: `pnpm test -- tests/main/infrastructure/config-store.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement stores**

Secret manager wraps Electron `safeStorage` where available and fails with `secret_storage_unavailable` when unavailable. Logger writes through the existing log path contract.

Run: `pnpm test -- tests/main/infrastructure/config-store.test.ts tests/main/infrastructure/secret-manager.test.ts tests/main/infrastructure/logger.test.ts`
Expected: PASS.

## Task 6: Plugin Loader And Kernel Runtime

**Files:**
- Create: `src/main/kernel/plugin-loader.ts`
- Create: `src/main/kernel/kernel-runtime.ts`
- Create: `src/main/kernel/index.ts`
- Test: `tests/main/kernel/plugin-loader.test.ts`
- Test: `tests/main/kernel/kernel-runtime.test.ts`

- [ ] **Step 1: Test load order and failure policy**

Assert:
- dependency order beats `order`.
- `critical` plugins initialize before `deferred`.
- `required: true` failure aborts bootstrap.
- `required: false` failure marks plugin degraded and continues.

Run: `pnpm test -- tests/main/kernel/plugin-loader.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement loader**

Use `initialize` and `shutdown` only. Register every manifest capability before plugin initialize so plugins can call dependencies after load-order checks pass.

Run: `pnpm test -- tests/main/kernel/plugin-loader.test.ts`
Expected: PASS.

- [ ] **Step 3: Implement runtime**

`KernelRuntime.start()` creates infrastructure, loads plugins, exposes `getStatus()`, and owns shutdown. It does not create BrowserWindow; Phase 5 wires it into main.

Run: `pnpm test -- tests/main/kernel/kernel-runtime.test.ts`
Expected: PASS.

## Task 7: Monolith-To-Plugin Data Migration

**Files:**
- Create: `src/main/infrastructure/migration/monolith-to-plugins.ts`
- Test: `tests/main/migration/monolith-to-plugins.test.ts`

- [ ] **Step 1: Test real current schema mapping**

Create a source database with current tables and rows:
- `task_threads`, `task_runs`, `task_events`, `session_messages`
- `background_tasks`, `scheduled_task_runs`
- `memory_flush_marks`, `mcp_servers`, `skills`, `performance_samples`, `diagnostic_packages`, `recovery_points`

Assert deterministic row counts and checksum records are written to `core.db.migration_runs`.

Run: `pnpm test -- tests/main/migration/monolith-to-plugins.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement migration**

Mapping:
- Agent plugin owns `task_threads`, `task_runs`, `task_events`, `session_messages`.
- Task plugin owns `background_tasks`, `scheduled_task_runs`.
- Memory plugin owns `memory_flush_marks`.
- MCP plugin owns `mcp_servers`.
- Skills plugin owns `skills`.
- Diagnostics plugin owns `performance_samples`, `diagnostic_packages`, `recovery_points`.

The source database is opened readonly. The target directory is created beside the source as `plugin-data-next`. Existing target files fail with `migration_target_exists`. A backup copy is written before migration.

Run: `pnpm test -- tests/main/migration/monolith-to-plugins.test.ts`
Expected: PASS.

## Phase 1 Verification

- [ ] `pnpm test -- tests/main/kernel tests/main/infrastructure tests/main/migration/monolith-to-plugins.test.ts`
- [ ] `pnpm typecheck`
- [ ] `pnpm build`

## Phase 1 Exit Criteria

- One plugin contract exists; no `init`, `cleanup`, `PluginManifest.priority`, `src/kernel`, or `src/plugins` references are introduced.
- Migration tests use current Roc schema names, not invented legacy tables.
- No renderer IPC change is introduced before Phase 5.
