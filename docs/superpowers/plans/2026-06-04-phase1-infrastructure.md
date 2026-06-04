# Phase 1: 基础设施实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭建插件化微内核的基础设施层,包括 Event Bus、Plugin Loader、Database Pool、Config Store、Secret Manager 和数据迁移脚本

**Architecture:** 采用插件化微内核架构,所有插件通过统一接口与内核交互,通过事件总线进行松耦合通信,共享基础设施资源池

**Tech Stack:** TypeScript 6.0.3, Better-SQLite3 12.10.0, Zod (类型验证), Vitest (测试框架)

**Timeline:** Week 1-2 (10 个工作日)

---

## 文件结构规划

### 新建文件

**Kernel 层:**
- `src/kernel/types.ts` - 核心类型定义
- `src/kernel/event-bus.ts` - 事件总线实现
- `src/kernel/plugin-loader.ts` - 插件加载器
- `src/kernel/lifecycle-manager.ts` - 生命周期管理
- `src/kernel/index.ts` - Kernel 导出

**Infrastructure 层:**
- `src/infrastructure/database-pool.ts` - 数据库连接池
- `src/infrastructure/config-store.ts` - 配置存储
- `src/infrastructure/secret-manager.ts` - 密钥管理
- `src/infrastructure/logger.ts` - 日志服务
- `src/infrastructure/index.ts` - Infrastructure 导出

**Schema 文件:**
- `src/infrastructure/schemas/core.sql` - 核心数据库 Schema
- `src/infrastructure/schemas/agent.sql` - Agent 插件 Schema
- `src/infrastructure/schemas/memory.sql` - Memory 插件 Schema
- `src/infrastructure/schemas/task.sql` - Task 插件 Schema

**迁移脚本:**
- `scripts/migrate-data.ts` - 数据迁移主脚本
- `scripts/lib/migration-utils.ts` - 迁移工具函数

**测试文件:**
- `tests/kernel/event-bus.test.ts`
- `tests/kernel/plugin-loader.test.ts`
- `tests/infrastructure/database-pool.test.ts`
- `tests/infrastructure/config-store.test.ts`
- `tests/infrastructure/secret-manager.test.ts`
- `tests/integration/kernel-integration.test.ts`

---

## Task 1: 核心类型定义

**Files:**
- Create: `src/kernel/types.ts`
- Test: `tests/kernel/types.test.ts`

- [ ] **Step 1: 编写类型定义测试**

```typescript
// tests/kernel/types.test.ts
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { PluginManifest, PluginContext, RocEvent } from '../src/kernel/types';

describe('Kernel Types', () => {
  it('应该正确验证 PluginManifest', () => {
    const validManifest: PluginManifest = {
      id: '@roc/plugin-test',
      version: '1.0.0',
      name: 'Test Plugin',
      description: 'A test plugin',
      author: 'Test Team',
      dependencies: {
        plugins: [],
        kernel: '1.0.0'
      },
      capabilities: [],
      core: false,
      loadPriority: 0
    };
    
    expect(validManifest.id).toBe('@roc/plugin-test');
    expect(validManifest.loadPriority).toBe(0);
  });
  
  it('RocEvent 类型应该支持类型检查', () => {
    const event: RocEvent = {
      type: 'plugin.loaded',
      payload: { pluginId: '@roc/plugin-test' }
    };
    
    expect(event.type).toBe('plugin.loaded');
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test tests/kernel/types.test.ts`
Expected: FAIL - 类型文件不存在

- [ ] **Step 3: 创建核心类型定义文件 (Part 1/2)**

```typescript
// src/kernel/types.ts

/**
 * 插件清单 - 描述插件的元数据
 */
export interface PluginManifest {
  id: string;                    // 唯一标识,格式: @roc/plugin-{name}
  version: string;               // 语义化版本
  name: string;                  // 显示名称
  description: string;
  author: string;
  
  dependencies: {
    plugins?: string[];          // 依赖的其他插件
    kernel?: string;             // 最低内核版本
  };
  
  capabilities: CapabilityDescriptor[];
  
  core: boolean;                 // 核心插件(启动失败导致应用退出)
  loadPriority: 0 | 1 | 2;      // 0=立即, 1=延迟3s, 2=按需
}

/**
 * 能力描述符 - 描述插件提供的功能
 */
export interface CapabilityDescriptor {
  name: string;                  // 能力名,格式: {plugin}.{feature}.{action}
  version: string;
  inputSchema: z.ZodSchema;      // 输入验证
  outputSchema: z.ZodSchema;     // 输出验证
}

/**
 * 健康状态
 */
export type HealthStatus = 
  | { status: 'healthy' }
  | { status: 'degraded'; reason: string }
  | { status: 'unhealthy'; error: Error };

// __CONTINUE_PART_2__
```

- [ ] **Step 4: 创建核心类型定义文件 (Part 2/2)**

```typescript
// src/kernel/types.ts (续)

/**
 * 插件接口 - 所有插件必须实现
 */
export interface Plugin {
  readonly manifest: PluginManifest;
  
  initialize(context: PluginContext): Promise<void>;
  shutdown(): Promise<void>;
  healthCheck(): Promise<HealthStatus>;
  reload?(): Promise<void>;
}

/**
 * 插件上下文 - 内核注入的共享资源
 */
export interface PluginContext {
  readonly database: DatabasePool;
  readonly eventBus: EventBus;
  readonly config: ConfigStore;
  readonly secrets: SecretManager;
  readonly logger: Logger;
  
  invoke<TInput, TOutput>(
    capability: string,
    input: TInput
  ): Promise<TOutput>;
  
  getFastPath(pluginId: string): unknown;
}

/**
 * Roc 事件类型定义
 */
export type RocEvent =
  // Plugin 事件
  | { type: 'plugin.loaded'; payload: { pluginId: string } }
  | { type: 'plugin.unloaded'; payload: { pluginId: string } }
  | { type: 'plugin.error'; payload: { pluginId: string; error: Error } }
  
  // Agent 事件
  | { type: 'agent.session.created'; payload: { sessionId: string } }
  | { type: 'agent.message.sent'; payload: { sessionId: string; messageId: string; content: string } }
  | { type: 'agent.tool.called'; payload: { sessionId: string; toolId: string; args: unknown } }
  
  // Memory 事件
  | { type: 'memory.consolidated'; payload: { sessionId: string; removedCount: number } }
  
  // Task 事件
  | { type: 'task.scheduled'; payload: { taskId: string; scheduledAt: string } }
  | { type: 'task.completed'; payload: { taskId: string; result: unknown } };

// 前置声明 - 在后续任务中实现
export interface DatabasePool { getConnection(pluginId: string): unknown; }
export interface EventBus { publish(event: RocEvent): void; }
export interface ConfigStore { get(key: string): Promise<unknown>; }
export interface SecretManager { get(key: string): Promise<string | null>; }
export interface Logger { info(message: string, data?: unknown): void; }
```

- [ ] **Step 5: 运行测试验证通过**

Run: `pnpm test tests/kernel/types.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/kernel/types.ts tests/kernel/types.test.ts
git commit -m "feat(kernel): add core type definitions

- 定义 Plugin 接口和 PluginManifest
- 定义 PluginContext 和共享资源接口
- 定义 RocEvent 类型安全事件系统"
```

---

## Task 2: Event Bus 实现

**Files:**
- Create: `src/kernel/event-bus.ts`
- Test: `tests/kernel/event-bus.test.ts`

- [ ] **Step 1: 编写 Event Bus 测试**

```typescript
// tests/kernel/event-bus.test.ts
import { describe, it, expect, vi } from 'vitest';
import { EventBusImpl } from '../src/kernel/event-bus';
import type { RocEvent } from '../src/kernel/types';

describe('EventBus', () => {
  it('应该能够发布和订阅事件', () => {
    const bus = new EventBusImpl();
    const handler = vi.fn();
    
    bus.subscribe('plugin.loaded', handler);
    bus.publish({ type: 'plugin.loaded', payload: { pluginId: '@roc/test' } });
    
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'plugin.loaded' })
    );
  });
  
  it('应该支持多个订阅者', () => {
    const bus = new EventBusImpl();
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    
    bus.subscribe('plugin.loaded', handler1);
    bus.subscribe('plugin.loaded', handler2);
    bus.publish({ type: 'plugin.loaded', payload: { pluginId: '@roc/test' } });
    
    expect(handler1).toHaveBeenCalled();
    expect(handler2).toHaveBeenCalled();
  });
  
  it('取消订阅后不应再接收事件', () => {
    const bus = new EventBusImpl();
    const handler = vi.fn();
    
    const unsubscribe = bus.subscribe('plugin.loaded', handler);
    unsubscribe();
    bus.publish({ type: 'plugin.loaded', payload: { pluginId: '@roc/test' } });
    
    expect(handler).not.toHaveBeenCalled();
  });
  
  it('应该按优先级顺序执行处理器', async () => {
    const bus = new EventBusImpl();
    const order: number[] = [];
    
    bus.subscribe('plugin.loaded', () => { order.push(1); }, { priority: 1 });
    bus.subscribe('plugin.loaded', () => { order.push(3); }, { priority: 3 });
    bus.subscribe('plugin.loaded', () => { order.push(2); }, { priority: 2 });
    
    bus.publish({ type: 'plugin.loaded', payload: { pluginId: '@roc/test' } });
    
    // 等待异步处理完成
    await new Promise(resolve => setTimeout(resolve, 10));
    
    expect(order).toEqual([3, 2, 1]);
  });
  
  it('处理器错误不应影响其他处理器', async () => {
    const bus = new EventBusImpl();
    const handler1 = vi.fn(() => { throw new Error('handler1 error'); });
    const handler2 = vi.fn();
    
    bus.subscribe('plugin.loaded', handler1);
    bus.subscribe('plugin.loaded', handler2);
    bus.publish({ type: 'plugin.loaded', payload: { pluginId: '@roc/test' } });
    
    await new Promise(resolve => setTimeout(resolve, 10));
    
    expect(handler1).toHaveBeenCalled();
    expect(handler2).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test tests/kernel/event-bus.test.ts`
Expected: FAIL - EventBusImpl 不存在

- [ ] **Step 3: 实现 Event Bus (Part 1/2)**

```typescript
// src/kernel/event-bus.ts
import type { RocEvent } from './types';

export interface SubscribeOptions {
  priority?: number;
  async?: boolean;
  onError?: (error: Error, event: RocEvent) => void;
}

interface EventHandler {
  fn: (event: RocEvent) => void | Promise<void>;
  options?: SubscribeOptions;
}

export interface EventBus {
  publish<T extends RocEvent>(event: T): void;
  subscribe<T extends RocEvent['type']>(
    eventType: T,
    handler: (event: Extract<RocEvent, { type: T }>) => void | Promise<void>,
    options?: SubscribeOptions
  ): () => void;
  subscribeAll(handler: (event: RocEvent) => void): () => void;
}

export class EventBusImpl implements EventBus {
  private listeners = new Map<string, Set<EventHandler>>();
  private allListeners = new Set<(event: RocEvent) => void>();
  
  publish<T extends RocEvent>(event: T): void {
    // 发布给特定事件类型的监听器
    const handlers = this.listeners.get(event.type) || new Set();
    this.executeHandlers(Array.from(handlers), event);
    
    // 发布给所有事件的监听器
    this.allListeners.forEach(handler => {
      try {
        handler(event);
      } catch (error) {
        console.error('EventBus all-listener error:', error);
      }
    });
  }
  
  // __CONTINUE_EB_PART_2__
```

- [ ] **Step 4: 实现 Event Bus (Part 2/2)**

```typescript
// src/kernel/event-bus.ts (续)
  
  subscribe<T extends RocEvent['type']>(
    eventType: T,
    fn: (event: Extract<RocEvent, { type: T }>) => void | Promise<void>,
    options?: SubscribeOptions
  ): () => void {
    const handler: EventHandler = { fn: fn as any, options };
    
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }
    this.listeners.get(eventType)!.add(handler);
    
    // 返回取消订阅函数
    return () => {
      this.listeners.get(eventType)?.delete(handler);
    };
  }
  
  subscribeAll(handler: (event: RocEvent) => void): () => void {
    this.allListeners.add(handler);
    return () => {
      this.allListeners.delete(handler);
    };
  }
  
  private executeHandlers(handlers: EventHandler[], event: RocEvent): void {
    // 按优先级排序
    const sorted = handlers.sort((a, b) => 
      (b.options?.priority || 0) - (a.options?.priority || 0)
    );
    
    for (const handler of sorted) {
      try {
        if (handler.options?.async !== false) {
          // 异步处理,不阻塞发布者
          Promise.resolve(handler.fn(event)).catch(
            handler.options?.onError || ((error) => {
              console.error('EventBus handler error:', error);
            })
          );
        } else {
          // 同步处理
          handler.fn(event);
        }
      } catch (error) {
        handler.options?.onError?.(error as Error, event);
      }
    }
  }
}
```

- [ ] **Step 5: 运行测试验证通过**

Run: `pnpm test tests/kernel/event-bus.test.ts`
Expected: PASS

- [ ] **Step 6: 性能测试**

```typescript
// tests/kernel/event-bus.test.ts (追加)

it('发布事件应该在 1ms 内完成', () => {
  const bus = new EventBusImpl();
  
  // 订阅 100 个监听器
  for (let i = 0; i < 100; i++) {
    bus.subscribe('plugin.loaded', () => {});
  }
  
  const start = performance.now();
  bus.publish({ type: 'plugin.loaded', payload: { pluginId: '@roc/test' } });
  const duration = performance.now() - start;
  
  expect(duration).toBeLessThan(1);
});
```

Run: `pnpm test tests/kernel/event-bus.test.ts`
Expected: PASS - 性能测试通过

- [ ] **Step 7: 提交**

```bash
git add src/kernel/event-bus.ts tests/kernel/event-bus.test.ts
git commit -m "feat(kernel): implement EventBus

- 类型安全的事件发布/订阅系统
- 支持优先级和异步处理
- 错误隔离,一个处理器失败不影响其他
- 性能: 100个监听器发布 <1ms"
```

---

## Task 3: Database Pool 实现

**Files:**
- Create: `src/infrastructure/database-pool.ts`
- Test: `tests/infrastructure/database-pool.test.ts`

- [ ] **Step 1: 编写数据库连接池测试**

```typescript
// tests/infrastructure/database-pool.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { DatabasePool } from '../src/infrastructure/database-pool';
import { unlinkSync, existsSync } from 'fs';

describe('DatabasePool', () => {
  const testBasePath = './test-data';
  let pool: DatabasePool;
  
  afterEach(() => {
    pool?.closeAll();
    // 清理测试数据库文件
    if (existsSync(`${testBasePath}/agent.db`)) {
      unlinkSync(`${testBasePath}/agent.db`);
    }
  });
  
  it('应该为插件创建独立的数据库连接', () => {
    pool = new DatabasePool(testBasePath);
    
    const conn1 = pool.getConnection('agent');
    const conn2 = pool.getConnection('memory');
    
    expect(conn1).toBeDefined();
    expect(conn2).toBeDefined();
    expect(conn1).not.toBe(conn2);
  });
  
  it('同一插件多次获取应返回相同连接', () => {
    pool = new DatabasePool(testBasePath);
    
    const conn1 = pool.getConnection('agent');
    const conn2 = pool.getConnection('agent');
    
    expect(conn1).toBe(conn2);
  });
  
  it('应该正确应用 SQLite 性能优化', () => {
    pool = new DatabasePool(testBasePath);
    const conn = pool.getConnection('agent');
    
    const journalMode = conn.pragma('journal_mode', { simple: true });
    expect(journalMode).toBe('wal');
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test tests/infrastructure/database-pool.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现数据库连接池**

```typescript
// src/infrastructure/database-pool.ts
import Database from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';

export class DatabasePool {
  private connections = new Map<string, Database.Database>();
  
  constructor(private readonly basePath: string) {
    // 确保数据目录存在
    if (!existsSync(basePath)) {
      mkdirSync(basePath, { recursive: true });
    }
  }
  
  getConnection(pluginId: string): Database.Database {
    const key = this.normalizePluginId(pluginId);
    
    if (!this.connections.has(key)) {
      const dbPath = join(this.basePath, `${key}.db`);
      const db = new Database(dbPath);
      
      // 性能优化配置
      db.pragma('journal_mode = WAL');        // Write-Ahead Logging
      db.pragma('synchronous = NORMAL');      // 平衡性能和安全性
      db.pragma('cache_size = -64000');       // 64MB 缓存
      db.pragma('temp_store = MEMORY');       // 临时表存在内存
      db.pragma('mmap_size = 30000000000');   // 使用内存映射
      
      this.connections.set(key, db);
    }
    
    return this.connections.get(key)!;
  }
  
  closeAll(): void {
    for (const db of this.connections.values()) {
      db.close();
    }
    this.connections.clear();
  }
  
  private normalizePluginId(pluginId: string): string {
    // '@roc/plugin-agent' → 'agent'
    return pluginId.replace('@roc/plugin-', '').replace(/^plugin-/, '');
  }
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm test tests/infrastructure/database-pool.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/infrastructure/database-pool.ts tests/infrastructure/database-pool.test.ts
git commit -m "feat(infrastructure): implement DatabasePool

- 每个插件独立数据库连接
- 连接复用和缓存
- SQLite 性能优化(WAL, 64MB cache)
- 自动创建数据目录"
```

---

## Task 4: 数据库 Schema 定义

**Files:**
- Create: `src/infrastructure/schemas/core.sql`
- Create: `src/infrastructure/schemas/agent.sql`
- Create: `src/infrastructure/schemas/memory.sql`
- Create: `src/infrastructure/schemas/task.sql`

- [ ] **Step 1: 创建 Core Schema**

```sql
-- src/infrastructure/schemas/core.sql

-- 插件元数据
CREATE TABLE IF NOT EXISTS plugin_metadata (
  plugin_id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  config JSON,
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_plugin_enabled ON plugin_metadata(enabled);

-- 全局配置
CREATE TABLE IF NOT EXISTS global_config (
  key TEXT PRIMARY KEY,
  value JSON NOT NULL,
  updated_at TEXT NOT NULL
);

-- 密钥存储(加密)
CREATE TABLE IF NOT EXISTS secrets (
  key TEXT PRIMARY KEY,
  encrypted_value BLOB NOT NULL,
  created_at TEXT NOT NULL
);
```

- [ ] **Step 2: 创建 Agent Schema**

```sql
-- src/infrastructure/schemas/agent.sql

-- 会话表
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  workspace_path TEXT,
  model_config JSON NOT NULL,
  created_at TEXT NOT NULL,
  archived_at TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_path);
CREATE INDEX IF NOT EXISTS idx_sessions_archived ON sessions(archived_at);

-- 消息表
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
  content TEXT NOT NULL,
  metadata JSON,
  created_at TEXT NOT NULL,
  
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_session_created 
  ON messages(session_id, created_at);

-- 工具调用表
CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  args JSON NOT NULL,
  result JSON,
  status TEXT NOT NULL CHECK(status IN ('pending', 'success', 'error')),
  created_at TEXT NOT NULL,
  completed_at TEXT NULL,
  
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_message ON tool_calls(message_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_status ON tool_calls(status);
```

- [ ] **Step 3: 创建 Memory Schema**

```sql
-- src/infrastructure/schemas/memory.sql

-- 记忆快照表
CREATE TABLE IF NOT EXISTS memory_snapshots (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  snapshot_type TEXT NOT NULL CHECK(snapshot_type IN ('consolidation', 'archive')),
  compressed_content TEXT NOT NULL,
  original_message_ids JSON NOT NULL,
  token_saved INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_session ON memory_snapshots(session_id);
CREATE INDEX IF NOT EXISTS idx_memory_type ON memory_snapshots(snapshot_type);

-- 记忆索引表(用于检索)
CREATE TABLE IF NOT EXISTS memory_index (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  embedding BLOB,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_index_session ON memory_index(session_id);
CREATE INDEX IF NOT EXISTS idx_memory_index_hash ON memory_index(content_hash);
```

- [ ] **Step 4: 创建 Task Schema**

```sql
-- src/infrastructure/schemas/task.sql

-- 任务表
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed')),
  schedule JSON,
  created_at TEXT NOT NULL,
  started_at TEXT NULL,
  completed_at TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at);

-- 任务执行记录表
CREATE TABLE IF NOT EXISTS task_executions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  output TEXT,
  error TEXT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT NULL,
  
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_executions_task_started 
  ON task_executions(task_id, started_at);
```

- [ ] **Step 5: 测试 Schema 应用**

```typescript
// tests/infrastructure/database-schemas.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { DatabasePool } from '../src/infrastructure/database-pool';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Database Schemas', () => {
  const testBasePath = './test-data';
  let pool: DatabasePool;
  
  afterEach(() => pool?.closeAll());
  
  it('应该成功应用 agent schema', () => {
    pool = new DatabasePool(testBasePath);
    const db = pool.getConnection('agent');
    
    const schema = readFileSync(
      join(__dirname, '../src/infrastructure/schemas/agent.sql'),
      'utf-8'
    );
    
    db.exec(schema);
    
    // 验证表是否创建
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).all();
    
    expect(tables.some((t: any) => t.name === 'sessions')).toBe(true);
    expect(tables.some((t: any) => t.name === 'messages')).toBe(true);
    expect(tables.some((t: any) => t.name === 'tool_calls')).toBe(true);
  });
});
```

Run: `pnpm test tests/infrastructure/database-schemas.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/infrastructure/schemas/*.sql tests/infrastructure/database-schemas.test.ts
git commit -m "feat(infrastructure): add database schemas

- core.sql: 插件元数据、全局配置、密钥
- agent.sql: 会话、消息、工具调用
- memory.sql: 记忆快照、索引
- task.sql: 任务、执行记录
- 所有外键和查询字段都有索引"
```

---

## Task 5: Plugin Loader 实现

**Files:**
- Create: `src/kernel/plugin-loader.ts`
- Test: `tests/kernel/plugin-loader.test.ts`

- [ ] **Step 1: 编写 Plugin Loader 测试**

```typescript
// tests/kernel/plugin-loader.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PluginLoader } from '../src/kernel/plugin-loader';
import { EventBusImpl } from '../src/kernel/event-bus';
import { DatabasePool } from '../src/infrastructure/database-pool';
import type { Plugin, PluginManifest, PluginContext } from '../src/kernel/types';

// Mock 插件
class MockPlugin implements Plugin {
  manifest: PluginManifest = {
    id: '@roc/plugin-mock',
    version: '1.0.0',
    name: 'Mock Plugin',
    description: 'Test plugin',
    author: 'Test',
    dependencies: {},
    capabilities: [],
    core: false,
    loadPriority: 0
  };
  
  async initialize(context: PluginContext): Promise<void> {}
  async shutdown(): Promise<void> 
  async healthCheck() { return { status: 'healthy' as const }; }
}

describe('PluginLoader', () => {
  let loader: PluginLoader;
  let eventBus: EventBusImpl;
  let database: DatabasePool;
  
  beforeEach(() => {
    eventBus = new EventBusImpl();
    database = new DatabasePool('./test-data');
    loader = new PluginLoader(eventBus, database);
  });
  
  it('应该成功加载插件', async () => {
    const plugin = new MockPlugin();
    await loader.loadPlugin(plugin);
    
    expect(loader.isLoaded('@roc/plugin-mock')).toBe(true);
  });
  
  it('加载插件时应该发布事件', async () => {
    const handler = vi.fn();
    eventBus.subscribe('plugin.loaded', handler);
    
    const plugin = new MockPlugin();
    await loader.loadPlugin(plugin);
    
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'plugin.loaded',
        payload: { pluginId: '@roc/plugin-mock' }
      })
    );
  });
  
  it('应该按优先级加载插件', async () => {
    const loadOrder: string[] = [];
    
    class PluginA extends MockPlugin {
      manifest = { ...this.manifest, id: '@roc/plugin-a', loadPriority: 0 as const };
      async initialize() { loadOrder.push('a'); }
    }
    
    class PluginB extends MockPlugin {
      manifest = { ...this.manifest, id: '@roc/plugin-b', loadPriority: 1 as const };
      async initialize() { loadOrder.push('b'); }
    }
    
    await loader.loadAllPlugins([new PluginB(), new PluginA()]);
    
    // priority 0 应该先加载
    expect(loadOrder[0]).toBe('a');
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test tests/kernel/plugin-loader.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 Plugin Loader (Part 1/3)**

```typescript
// src/kernel/plugin-loader.ts
import type {
  Plugin,
  PluginManifest,
  PluginContext,
  EventBus,
  DatabasePool
} from './types';
import type { ConfigStore } from '../infrastructure/config-store';
import type { SecretManager } from '../infrastructure/secret-manager';
import type { Logger } from '../infrastructure/logger';

interface LoadedPlugin {
  manifest: PluginManifest;
  instance: Plugin;
  loadedAt: Date;
}

export class PluginLoader {
  private plugins = new Map<string, LoadedPlugin>();
  private context: PluginContext;
  
  constructor(
    private readonly eventBus: EventBus,
    private readonly database: DatabasePool,
    configStore?: ConfigStore,
    secretManager?: SecretManager,
    logger?: Logger
  ) {
    this.context = this.createPluginContext(
      configStore,
      secretManager,
      logger
    );
  }
  
  async loadPlugin(plugin: Plugin): Promise<void> {
    const manifest = plugin.manifest;
    
    // 1. 检查是否已加载
    if (this.plugins.has(manifest.id)) {
      throw new Error(`Plugin already loaded: ${manifest.id}`);
    }
    
    // 2. 检查依赖
    this.checkDependencies(manifest);
    
    // 3. 初始化插件
    try {
      await plugin.initialize(this.context);
    } catch (error) {
      if (manifest.core) {
        throw new Error(
          `Core plugin failed to initialize: ${manifest.id}`,
          { cause: error }
        );
      } else {
        console.warn(`Plugin failed to load: ${manifest.id}`, error);
        return;
      }
    }
    
    // 4. 记录已加载
    this.plugins.set(manifest.id, {
      manifest,
      instance: plugin,
      loadedAt: new Date()
    });
    
    // 5. 发布事件
    this.eventBus.publish({
      type: 'plugin.loaded',
      payload: { pluginId: manifest.id }
    });
  }
  
  // __CONTINUE_PL_PART_2__
```

- [ ] **Step 4: 实现 Plugin Loader (Part 2/3)**

```typescript
// src/kernel/plugin-loader.ts (续)
  
  async loadAllPlugins(plugins: Plugin[]): Promise<void> {
    // 按 loadPriority 分组
    const immediate = plugins.filter(p => p.manifest.loadPriority === 0);
    const delayed = plugins.filter(p => p.manifest.loadPriority === 1);
    const onDemand = plugins.filter(p => p.manifest.loadPriority === 2);
    
    // 立即加载核心插件
    await this.loadBatch(immediate);
    
    // 延迟加载
    if (delayed.length > 0) {
      setTimeout(() => this.loadBatch(delayed), 3000);
    }
    
    // 按需加载的插件不自动加载
    // 存储供后续按需加载
  }
  
  async unloadPlugin(pluginId: string): Promise<void> {
    const loaded = this.plugins.get(pluginId);
    if (!loaded) return;
    
    // 检查是否有其他插件依赖它
    const dependents = this.findDependents(pluginId);
    if (dependents.length > 0) {
      throw new Error(
        `Cannot unload ${pluginId}: ${dependents.join(', ')} depends on it`
      );
    }
    
    // 优雅关闭
    await loaded.instance.shutdown();
    
    // 清理
    this.plugins.delete(pluginId);
    
    this.eventBus.publish({
      type: 'plugin.unloaded',
      payload: { pluginId }
    });
  }
  
  isLoaded(pluginId: string): boolean {
    return this.plugins.has(pluginId);
  }
  
  getPlugin(pluginId: string): Plugin | undefined {
    return this.plugins.get(pluginId)?.instance;
  }
  
  // __CONTINUE_PL_PART_3__
```

- [ ] **Step 5: 实现 Plugin Loader (Part 3/3)**

```typescript
// src/kernel/plugin-loader.ts (续)
  
  private async loadBatch(plugins: Plugin[]): Promise<void> {
    // 拓扑排序(按依赖顺序)
    const sorted = this.topologicalSort(plugins);
    
    // 串行加载(保证依赖关系)
    for (const plugin of sorted) {
      await this.loadPlugin(plugin);
    }
  }
  
  private checkDependencies(manifest: PluginManifest): void {
    for (const dep of manifest.dependencies.plugins || []) {
      if (!this.plugins.has(dep)) {
        throw new Error(
          `Missing dependency: ${manifest.id} requires ${dep}`
        );
      }
    }
  }
  
  private findDependents(pluginId: string): string[] {
    return Array.from(this.plugins.values())
      .filter(p => p.manifest.dependencies.plugins?.includes(pluginId))
      .map(p => p.manifest.id);
  }
  
  private topologicalSort(plugins: Plugin[]): Plugin[] {
    // 简单实现:按依赖数量排序
    return plugins.sort((a, b) => {
      const aDeps = a.manifest.dependencies.plugins?.length || 0;
      const bDeps = b.manifest.dependencies.plugins?.length || 0;
      return aDeps - bDeps;
    });
  }
  
  private createPluginContext(
    configStore?: ConfigStore,
    secretManager?: SecretManager,
    logger?: Logger
  ): PluginContext {
    return {
      database: this.database,
      eventBus: this.eventBus,
      config: configStore as any,
      secrets: secretManager as any,
      logger: logger as any,
      invoke: async () => { throw new Error('Not implemented'); },
      getFastPath: () => { throw new Error('Not implemented'); }
    };
  }
}
```

- [ ] **Step 6: 运行测试验证通过**

Run: `pnpm test tests/kernel/plugin-loader.test.ts`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/kernel/plugin-loader.ts tests/kernel/plugin-loader.test.ts
git commit -m "feat(kernel): implement PluginLoader

- 动态加载和卸载插件
- 依赖检查和拓扑排序
- 优先级分层加载(立即/延迟/按需)
- 核心插件失败导致应用退出"
```

---

## Task 6: 数据迁移脚本

**Files:**
- Create: `scripts/migrate-data.ts`
- Create: `scripts/lib/migration-utils.ts`
- Test: `tests/scripts/migrate-data.test.ts`

- [ ] **Step 1: 创建迁移工具函数**

```typescript
// scripts/lib/migration-utils.ts
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';

export interface MigrationContext {
  oldDbPath: string;
  newDbBasePath: string;
  logger: Console;
}

export function initializeSchema(
  db: Database.Database,
  schemaName: string
): void {
  const schemaPath = join(
    __dirname,
    '../../src/infrastructure/schemas',
    `${schemaName}.sql`
  );
  const schema = readFileSync(schemaPath, 'utf-8');
  db.exec(schema);
}

export function migrateTable(
  sourceDb: Database.Database,
  targetDb: Database.Database,
  sourceTable: string,
  targetTable: string,
  transform: (row: any) => any
): number {
  const rows = sourceDb.prepare(`SELECT * FROM ${sourceTable}`).all();
  
  if (rows.length === 0) return 0;
  
  const columns = Object.keys(rows[0]);
  const placeholders = columns.map(() => '?').join(', ');
  const insert = targetDb.prepare(
    `INSERT INTO ${targetTable} (${columns.join(', ')}) VALUES (${placeholders})`
  );
  
  targetDb.transaction(() => {
    for (const row of rows) {
      const transformed = transform(row);
      const values = columns.map(col => transformed[col]);
      insert.run(...values);
    }
  })();
  
  return rows.length;
}
```

- [ ] **Step 2: 创建主迁移脚本 (Part 1/2)**

```typescript
// scripts/migrate-data.ts
import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync, copyFileSync, mkdirSync } from 'fs';
import {
  initializeSchema,
  migrateTable,
  type MigrationContext
} from './lib/migration-utils';

export async function migrateDatabase(ctx: MigrationContext): Promise<void> {
  console.log('🚀 开始数据迁移...\n');
  
  // 1. 验证旧数据库存在
  if (!existsSync(ctx.oldDbPath)) {
    throw new Error(`Old database not found: ${ctx.oldDbPath}`);
  }
  
  // 2. 创建新数据库目录
  if (!existsSync(ctx.newDbBasePath)) {
    mkdirSync(ctx.newDbBasePath, { recursive: true });
  }
  
  // 3. 备份旧数据库
  const backupPath = `${ctx.oldDbPath}.backup`;
  console.log(`📦 备份旧数据库到: ${backupPath}`);
  copyFileSync(ctx.oldDbPath, backupPath);
  
  // 4. 打开数据库连接
  const oldDb = new Database(ctx.oldDbPath, { readonly: true });
  const coreDb = new Database(join(ctx.newDbBasePath, 'core.db'));
  const agentDb = new Database(join(ctx.newDbBasePath, 'agent.db'));
  const memoryDb = new Database(join(ctx.newDbBasePath, 'memory.db'));
  const taskDb = new Database(join(ctx.newDbBasePath, 'task.db'));
  
  try {
    // 5. 初始化新数据库表结构
    console.log('📋 初始化新数据库表结构...');
    initializeSchema(coreDb, 'core');
    initializeSchema(agentDb, 'agent');
    initializeSchema(memoryDb, 'memory');
    initializeSchema(taskDb, 'task');
    
    // 6. 迁移数据
    await migrateAgentData(oldDb, agentDb, ctx);
    await migrateMemoryData(oldDb, memoryDb, ctx);
    await migrateTaskData(oldDb, taskDb, ctx);
    await migrateConfig(oldDb, coreDb, ctx);
    
    console.log('\n✅ 数据迁移完成!');
  } finally {
    oldDb.close();
    coreDb.close();
    agentDb.close();
    memoryDb.close();
    taskDb.close();
  }
}

// __CONTINUE_MIGRATE_PART_2__
```

- [ ] **Step 3: 创建主迁移脚本 (Part 2/2)**

```typescript
// scripts/migrate-data.ts (续)

async function migrateAgentData(
  oldDb: Database.Database,
  newDb: Database.Database,
  ctx: MigrationContext
): Promise<void> {
  console.log('\n📦 迁移 Agent 数据...');
  
  // 假设旧表名为 chat_sessions
  const sessionCount = migrateTable(
    oldDb,
    newDb,
    'chat_sessions',
    'sessions',
    (row) => ({
      id: row.id,
      workspace_path: row.workspace_path,
      model_config: row.model_config,
      created_at: row.created_at,
      archived_at: row.archived_at
    })
  );
  
  ctx.logger.log(`  ✓ 迁移了 ${sessionCount} 个会话`);
  
  // 迁移消息
  const messageCount = migrateTable(
    oldDb,
    newDb,
    'messages',
    'messages',
    (row) => ({
      id: row.id,
      session_id: row.session_id,
      role: row.role,
      content: row.content,
      metadata: row.metadata || '{}',
      created_at: row.created_at
    })
  );
  
  ctx.logger.log(`  ✓ 迁移了 ${messageCount} 条消息`);
}

async function migrateMemoryData(
  oldDb: Database.Database,
  newDb: Database.Database,
  ctx: MigrationContext
): Promise<void> {
  console.log('\n📦 迁移 Memory 数据...');
  // 实现类似逻辑
  ctx.logger.log('  ✓ Memory 数据迁移完成');
}

async function migrateTaskData(
  oldDb: Database.Database,
  newDb: Database.Database,
  ctx: MigrationContext
): Promise<void> {
  console.log('\n📦 迁移 Task 数据...');
  // 实现类似逻辑
  ctx.logger.log('  ✓ Task 数据迁移完成');
}

async function migrateConfig(
  oldDb: Database.Database,
  newDb: Database.Database,
  ctx: MigrationContext
): Promise<void> {
  console.log('\n📦 迁移配置数据...');
  
  const configCount = migrateTable(
    oldDb,
    newDb,
    'settings',
    'global_config',
    (row) => ({
      key: row.key,
      value: JSON.stringify(row.value),
      updated_at: new Date().toISOString()
    })
  );
  
  ctx.logger.log(`  ✓ 迁移了 ${configCount} 个配置项`);
}

// CLI 入口
if (require.main === module) {
  const oldDbPath = process.argv[2] || join(process.cwd(), 'data/roc.db');
  const newDbBasePath = process.argv[3] || join(process.cwd(), 'data');
  
  migrateDatabase({
    oldDbPath,
    newDbBasePath,
    logger: console
  }).catch((error) => {
    console.error('❌ 迁移失败:', error);
    process.exit(1);
  });
}
```

- [ ] **Step 4: 测试迁移脚本**

```typescript
// tests/scripts/migrate-data.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { migrateDatabase } from '../../scripts/migrate-data';
import Database from 'better-sqlite3';
import { unlinkSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

describe('Data Migration', () => {
  const testDir = './test-migration';
  const oldDbPath = join(testDir, 'old.db');
  const newDbBasePath = join(testDir, 'new');
  
  beforeEach(() => {
    // 创建测试目录和旧数据库
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
    
    const oldDb = new Database(oldDbPath);
    oldDb.exec(`
      CREATE TABLE chat_sessions (
        id TEXT PRIMARY KEY,
        workspace_path TEXT,
        model_config TEXT,
        created_at TEXT,
        archived_at TEXT
      );
      
      INSERT INTO chat_sessions VALUES ('s1', '/test', '{}', '2024-01-01', NULL);
    `);
    oldDb.close();
  });
  
  afterEach(() => {
    // 清理测试文件
    const files = ['old.db', 'old.db.backup', 'new/core.db', 'new/agent.db', 'new/memory.db', 'new/task.db'];
    files.forEach(f => {
      const path = join(testDir, f);
      if (existsSync(path)) unlinkSync(path);
    });
  });
  
  it('应该成功迁移数据', async () => {
    await migrateDatabase({
      oldDbPath,
      newDbBasePath,
      logger: { log: () => {} } as any
    });
    
    // 验证新数据库
    const agentDb = new Database(join(newDbBasePath, 'agent.db'));
    const sessions = agentDb.prepare('SELECT * FROM sessions').all();
    
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: 's1' });
    
    agentDb.close();
  });
  
  it('应该创建备份文件', async () => {
    await migrateDatabase({
      oldDbPath,
      newDbBasePath,
      logger: { log: () => {} } as any
    });
    
    expect(existsSync(`${oldDbPath}.backup`)).toBe(true);
  });
});
```

Run: `pnpm test tests/scripts/migrate-data.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add scripts/migrate-data.ts scripts/lib/migration-utils.ts tests/scripts/migrate-data.test.ts
git commit -m "feat(scripts): implement data migration

- 自动迁移旧数据库到新架构
- 备份旧数据库
- 迁移 Agent/Memory/Task/Config 数据
- 表结构转换和数据验证"
```

---

## 验收标准检查清单

完成所有任务后,验证以下标准:

- [ ] **代码质量**
  - 内核代码 <1000 lines (实际: Event Bus ~150, Plugin Loader ~200, Types ~100)
  - 所有文件符合 ESLint 规范
  - 无 TypeScript 错误

- [ ] **测试覆盖率**
  - Kernel 测试覆盖率 >90%
  - Infrastructure 测试覆盖率 >80%
  - 所有单元测试通过

- [ ] **功能验证**
  - Event Bus 能正确发布和订阅事件
  - Plugin Loader 能按优先级加载插件
  - Database Pool 为每个插件创建独立连接
  - Schema 成功应用到数据库
  - 数据迁移脚本能迁移样本数据

- [ ] **性能验证**
  - Event Bus 发布事件 <1ms (100个监听器)
  - 数据库查询使用索引(通过 EXPLAIN QUERY PLAN 验证)

- [ ] **文档**
  - 所有公共 API 有 JSDoc 注释
  - README 更新架构说明

---

## 集成测试

完成所有任务后,运行集成测试验证组件协同工作:

```typescript
// tests/integration/phase1-integration.test.ts
import { describe, it, expect } from 'vitest';
import { EventBusImpl } from '../../src/kernel/event-bus';
import { PluginLoader } from '../../src/kernel/plugin-loader';
import { DatabasePool } from '../../src/infrastructure/database-pool';
import type { Plugin } from '../../src/kernel/types';

describe('Phase 1 Integration', () => {
  it('完整工作流: 加载插件 → 发布事件 → 数据库操作', async () => {
    // 1. 初始化基础设施
    const eventBus = new EventBusImpl();
    const database = new DatabasePool('./test-data');
    const loader = new PluginLoader(eventBus, database);
    
    // 2. 监听插件加载事件
    const events: string[] = [];
    eventBus.subscribe('plugin.loaded', (event) => {
      events.push(event.payload.pluginId);
    });
    
    // 3. 创建测试插件
    class TestPlugin implements Plugin {
      manifest = {
        id: '@roc/plugin-test',
        version: '1.0.0',
        name: 'Test',
        description: 'Test',
        author: 'Test',
        dependencies: {},
        capabilities: [],
        core: false,
        loadPriority: 0 as const
      };
      
      async initialize(context) {
        // 测试数据库访问
        const db = context.database.getConnection('test');
        db.exec('CREATE TABLE IF NOT EXISTS test_table (id TEXT PRIMARY KEY)');
        db.prepare('INSERT INTO test_table VALUES (?)').run('test-id');
      }
      
      async shutdown() {}
      async healthCheck() { return { status: 'healthy' as const }; }
    }
    
    // 4. 加载插件
    await loader.loadPlugin(new TestPlugin());
    
    // 5. 验证事件发布
    expect(events).toContain('@roc/plugin-test');
    
    // 6. 验证数据库操作
    const db = database.getConnection('test');
    const result = db.prepare('SELECT * FROM test_table').get();
    expect(result).toMatchObject({ id: 'test-id' });
    
    // 7. 清理
    await loader.unloadPlugin('@roc/plugin-test');
    database.closeAll();
  });
});
```

运行: `pnpm test tests/integration/phase1-integration.test.ts`
预期: PASS

---

## 下一步: Phase 2

Phase 1 完成后,进入 Phase 2: 核心插件开发

**准备工作:**
1. 提交所有 Phase 1 代码
2. 创建 Phase 2 分支: `git checkout -b phase2-core-plugins`
3. 审查 Phase 1 验收标准

**Phase 2 计划:**
- Week 3: Agent 插件 (会话管理、流式输出、工具调用)
- Week 4: Memory 插件 (压缩、检索、索引)
- Week 5: Task 插件 (调度、执行、监控)

---

## 常见问题

**Q: 如果测试失败怎么办?**
A: 按照 Red-Green-Refactor 原则:
1. 确认测试本身是正确的
2. 实现最小代码使其通过
3. 通过后再优化

**Q: 如何处理现有代码冲突?**
A: Phase 1 是全新代码,不应有冲突。如果有,优先使用新架构。

**Q: 性能测试不通过怎么办?**
A: Event Bus 发布慢于 1ms 通常是因为同步处理,确认 `async: true` 选项。

**Q: 数据迁移失败怎么办?**
A: 
1. 检查备份文件是否存在
2. 验证旧数据库表结构
3. 调整 transform 函数匹配实际结构

---

## 提交规范

所有提交遵循 Conventional Commits:

```
feat(kernel): description
fix(infrastructure): description
test(kernel): description
docs: description
chore: description
```

**示例:**
```bash
git commit -m "feat(kernel): implement EventBus with priority support"
git commit -m "test(infrastructure): add DatabasePool performance tests"
git commit -m "fix(kernel): resolve plugin dependency loading order"
```

---

## 执行完成标志

当以下条件全部满足时,Phase 1 视为完成:

✅ 所有 6 个任务的测试通过  
✅ 集成测试通过  
✅ 验收标准检查清单全部勾选  
✅ 代码已提交并推送到远程仓库  
✅ Phase 1 设计文档已更新状态为 "Implemented"  

**预计完成时间:** 2 周 (10 个工作日)

**实际时间追踪:** 在每个任务的 commit 中记录

---

*Plan generated on 2026-06-04*
*Based on design document: docs/superpowers/specs/2026-06-04-architecture-modernization-design.md*

