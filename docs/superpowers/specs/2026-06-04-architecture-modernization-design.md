# Roc 架构现代化设计文档

> **状态:** Draft  
> **日期:** 2026-06-04  
> **作者:** Architecture Team  
> **版本:** 1.0.0

---

## 执行摘要

本文档描述了 Roc 项目的全面架构现代化方案,采用**插件化微内核 + 轻量 DDD**混合架构,旨在解决当前代码库的三大核心问题:

1. **代码可维护性问题** — 最大文件 1486 行,难以理解和修改
2. **模块化解耦问题** — 服务层高耦合(AppService 17 个依赖)
3. **可扩展性问题** — 添加新功能需要修改多个文件

**核心设计原则:**
- 插件化架构实现零耦合模块划分
- 事件驱动通信避免直接依赖
- 领域驱动设计封装业务逻辑
- 性能优化保证生产可用

**预期收益:**
- 文件大小从 1486 行降至 <300 行
- 内存增加 <15MB (总计 ~135MB)
- 打包体积增加 <5MB (总计 ~395MB)
- 启动时间增加 <200ms (总计 ~2.7s)
- 模块解耦度达到 100% (零硬依赖)

---

## 目录

1. [当前架构分析](#1-当前架构分析)
2. [设计目标与约束](#2-设计目标与约束)
3. [方案选型](#3-方案选型)
4. [目标架构设计](#4-目标架构设计)
5. [核心组件设计](#5-核心组件设计)
6. [数据库重新设计](#6-数据库重新设计)
7. [性能优化策略](#7-性能优化策略)
8. [迁移策略](#8-迁移策略)
9. [测试策略](#9-测试策略)
10. [实施路线图](#10-实施路线图)
11. [风险管理](#11-风险管理)
12. [成功指标](#12-成功指标)

---

## 1. 当前架构分析

### 1.1 项目概况

**技术栈:**
- Electron 41.6.1 (桌面应用框架)
- React 19.2.6 (UI 框架)
- LangChain 1.4.1 + DeepAgents 1.10.2 (AI Agent 运行时)
- Better-SQLite3 12.10.0 (数据持久化)
- TypeScript 6.0.3

**代码规模:**
- 254 个 TypeScript/TSX 文件
- 打包体积: 390MB
- 运行时内存: ~120MB

### 1.2 核心问题

**问题 1: 超大文件难以维护**

| 文件 | 行数 | 问题 |
|------|------|------|
| `langchain-model-factory.ts` | 1486 | 职责过多:模型创建、配置、推理、NVIDIA适配 |
| `deep-agent-runtime-service.ts` | 1076 | 包含运行时、工具、流处理多个职责 |
| `App.tsx` | 923 | UI、状态管理、路由、IPC 混在一起 |
| `providers-section.tsx` | 912 | 表单、验证、状态管理耦合 |

**问题 2: 服务层高耦合**

```typescript
// src/main/services/app-service.ts
export class AppService {
  constructor(
    private readonly paths: RocPaths,
    private readonly configService: ConfigService,
    private readonly databaseService: DatabaseService,
    private readonly memoryService: MemoryService,
    // ... 还有 13 个服务依赖
  ) {}
}
```

**影响:**
- 难以单独测试某个服务
- 修改一个服务可能影响多个其他服务
- 无法独立部署或禁用某个功能

**问题 3: 扩展性受限**

添加新功能(如新的 AI 模型集成)需要修改:
1. `langchain-model-factory.ts` (添加模型支持)
2. `app-service.ts` (注册新服务)
3. `config-service.ts` (添加配置)
4. `ipc-*.ts` (添加 IPC 接口)
5. UI 组件 (添加设置界面)

**至少 5 个文件,极易引入 bug**


### 1.3 Forge 启发

参考 Forge 论文(DOI: 10.1145/3786335.3813193)的设计原则:

1. **Fail Fast, Fail Loud** — 禁止防御式编程,错误显式抛出
2. **Explicit Over Implicit** — 所有配置显式声明
3. **Control Flow Is Not Memory** — 控制流状态独立于消息历史
4. **Client Adapter Is the Abstraction Boundary** — 适配器隔离外部依赖
5. **Context Is a First-Class Resource** — 上下文作为一等公民管理

这些原则将指导我们的架构设计。

---

## 2. 设计目标与约束

### 2.1 核心目标

**目标 1: 代码可维护性**
- 任何文件不超过 300 行
- 文件职责单一清晰
- 易于定位和修改

**目标 2: 模块化解耦**
- 模块间零硬依赖
- 通过事件通信
- 可独立开发测试

**目标 3: 可扩展性**
- 新功能不修改现有代码
- 支持插件化扩展
- 为第三方插件铺路

**目标 4: 性能可控**
- 打包体积 <400MB
- 运行内存 <150MB
- 启动时间 <3s
- 运行性能不退化

### 2.2 约束条件

**硬约束:**
- ✅ 保持 Electron + React + LangChain 技术栈
- ✅ 接受数据库重新设计
- ✅ 接受一次性重写(不需要向后兼容)
- ✅ 提供数据迁移脚本

**软约束:**
- 尽量复用现有业务逻辑
- 保持用户体验连续性
- 14 周内完成开发

---

## 3. 方案选型

### 3.1 候选方案对比

我们评估了三种架构方案:

| 维度 | 方案A:插件化微内核 | 方案B:分层DDD | 方案C:事件溯源+CQRS |
|------|-------------------|--------------|-------------------|
| **打包体积** | +8MB (398MB) | +4MB (394MB) | +15MB (405MB) |
| **运行内存** | +25MB (145MB) | +15MB (135MB) | +50MB (170MB) |
| **启动速度** | +300ms (2.8s) | +100ms (2.6s) | +500ms (3.0s) |
| **运行性能** | -2% | -5% | 写-15%/读+40% |
| **模块解耦** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ |
| **可扩展性** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐ |
| **实现复杂度** | ⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ |

### 3.2 最终选择:混合方案

**核心架构:** 插件化微内核 (方案A)
**插件内部:** 轻量DDD模式 (方案B简化版)

**选择理由:**
1. 插件化实现最彻底的解耦
2. 事件驱动通信天然适合 Electron 架构
3. DDD 封装业务逻辑避免贫血模型
4. 性能开销可控且可优化


---

## 4. 目标架构设计

### 4.1 整体架构层次

```
┌─────────────────────────────────────────────────────┐
│  Renderer Process (React UI)                        │
│  ├─ Feature Modules (按功能域组织)                   │
│  ├─ Shared Components (原子化组件库)                │
│  └─ View Models (Presenter 层)                      │
└─────────────────────────────────────────────────────┘
                    ↕ IPC Bridge
┌─────────────────────────────────────────────────────┐
│  Main Process - Micro-Kernel                        │
│  ├─ Plugin Loader (动态加载/卸载)                    │
│  ├─ Event Bus (发布订阅)                            │
│  ├─ Lifecycle Manager (启动/关闭协调)               │
│  └─ Plugin Context (共享基础设施)                   │
└─────────────────────────────────────────────────────┘
                    ↕ Plugin API
┌─────────────────────────────────────────────────────┐
│  Plugins (独立可插拔模块)                            │
│  ├─ @roc/plugin-agent (Agent 运行时)                │
│  ├─ @roc/plugin-memory (记忆管理)                   │
│  ├─ @roc/plugin-task (任务调度)                     │
│  ├─ @roc/plugin-workspace (工作区)                  │
│  ├─ @roc/plugin-mcp (MCP 集成)                      │
│  └─ @roc/plugin-rtk (RTK 工具)                      │
└─────────────────────────────────────────────────────┘
                    ↕ Repository Pattern
┌─────────────────────────────────────────────────────┐
│  Infrastructure Layer                                │
│  ├─ Database (每插件独立数据库)                      │
│  ├─ External Adapters (LangChain/MCP)               │
│  └─ System Services (IPC/Window)                    │
└─────────────────────────────────────────────────────┘
```

### 4.2 核心设计决策

**决策 1: 插件即边界**

每个功能域是独立插件,包含:
- 领域模型 (Session, Message, Task...)
- 业务逻辑 (AgentRuntime, Consolidator...)
- 数据访问 (Repository)
- 对外接口 (Capabilities)

**好处:**
- 文件自然小于 300 行 (每个领域模型 ~150 行)
- 职责清晰
- 可独立测试

**决策 2: 事件驱动通信**

插件间通过事件总线通信,避免直接依赖:

```typescript
// Memory 插件监听 Agent 事件
context.eventBus.subscribe('agent.message.sent', async (event) => {
  if (needsCompression(event.payload.sessionId)) {
    await consolidate(event.payload.sessionId);
  }
});
```

**好处:**
- 零耦合
- 易于扩展
- 天然支持异步

**决策 3: 快速路径优化**

热路径(如流式输出)直接调用,跳过事件总线:

```typescript
// 插件暴露快速路径
readonly fastPath = {
  streamMessage: this.streamMessageDirect.bind(this)
};

// 内核提供快速访问
context.getFastPath('@roc/plugin-agent').streamMessage(...)
```

**好处:**
- 性能无损
- 保持架构灵活性


---

## 5. 核心组件设计

### 5.1 Plugin 标准接口

所有插件实现统一接口:

```typescript
export interface Plugin {
  readonly manifest: PluginManifest;
  
  initialize(context: PluginContext): Promise<void>;
  shutdown(): Promise<void>;
  healthCheck(): Promise<HealthStatus>;
  reload?(): Promise<void>;
}

export interface PluginManifest {
  id: string;                    // '@roc/plugin-agent'
  version: string;               // '1.0.0'
  name: string;
  description: string;
  dependencies: {
    plugins?: string[];          // 依赖的其他插件
    kernel?: string;             // 最低内核版本
  };
  capabilities: CapabilityDescriptor[];
  core: boolean;                 // 核心插件启动失败会导致应用退出
  loadPriority: 0 | 1 | 2;      // 0=立即, 1=延迟3s, 2=按需
}
```

**示例: Agent 插件清单**

```typescript
readonly manifest: PluginManifest = {
  id: '@roc/plugin-agent',
  version: '1.0.0',
  name: 'Agent Runtime',
  description: 'LangChain/DeepAgents 运行时',
  dependencies: {
    plugins: ['@roc/plugin-memory'],
    kernel: '1.0.0'
  },
  capabilities: [
    {
      name: 'agent.chat.stream',
      version: '1.0.0',
      inputSchema: z.object({
        sessionId: z.string(),
        message: z.string()
      }),
      outputSchema: z.custom<AsyncIterable<MessageChunk>>()
    }
  ],
  core: true,
  loadPriority: 0
};
```

### 5.2 Event Bus 设计

类型安全的事件总线:

```typescript
export type RocEvent =
  | { type: 'agent.session.created'; payload: { sessionId: string } }
  | { type: 'agent.message.sent'; payload: { sessionId: string; content: string } }
  | { type: 'memory.consolidated'; payload: { sessionId: string; removedCount: number } }
  | { type: 'task.completed'; payload: { taskId: string; result: unknown } };

export interface EventBus {
  publish<T extends RocEvent>(event: T): void;
  subscribe<T extends RocEvent['type']>(
    eventType: T,
    handler: (event: Extract<RocEvent, { type: T }>) => void | Promise<void>
  ): () => void;
}
```

**使用示例:**

```typescript
// 发布事件
eventBus.publish({
  type: 'agent.message.sent',
  payload: { sessionId: 'abc', content: 'Hello' }
});

// 订阅事件
const unsubscribe = eventBus.subscribe('agent.message.sent', (event) => {
  console.log('Message:', event.payload.content);
});
```

### 5.3 Plugin Loader

动态加载和生命周期管理:

```typescript
export class PluginLoader {
  async loadPlugin(manifest: PluginManifest): Promise<void> {
    // 1. 检查依赖
    this.checkDependencies(manifest);
    
    // 2. 动态导入
    const module = await import(`../plugins/${manifest.id}`);
    const plugin: Plugin = new module.default();
    
    // 3. 初始化
    await plugin.initialize(this.context);
    
    // 4. 注册能力
    this.registerCapabilities(manifest);
    
    // 5. 发布事件
    this.eventBus.publish({
      type: 'plugin.loaded',
      payload: { pluginId: manifest.id }
    });
  }
  
  async loadAllPlugins(manifests: PluginManifest[]): Promise<void> {
    // 按优先级分组
    const immediate = manifests.filter(m => m.loadPriority === 0);
    const delayed = manifests.filter(m => m.loadPriority === 1);
    
    // 立即加载核心插件
    await this.loadBatch(immediate);
    
    // 3秒后加载延迟插件
    setTimeout(() => this.loadBatch(delayed), 3000);
  }
}
```


### 5.4 核心插件概览

**@roc/plugin-agent**
- **职责:** LLM 交互、工具调用、流式输出
- **领域模型:** Session, Message, ToolCall
- **能力:** `agent.chat.stream`, `agent.tool.call`
- **依赖:** @roc/plugin-memory

**@roc/plugin-memory**
- **职责:** 会话记忆管理、压缩、检索
- **领域模型:** Memory, Consolidation
- **能力:** `memory.consolidate`, `memory.search`
- **依赖:** 无

**@roc/plugin-task**
- **职责:** 任务调度、执行、监控
- **领域模型:** Task, Schedule, Execution
- **能力:** `task.schedule`, `task.execute`
- **依赖:** @roc/plugin-agent

**@roc/plugin-workspace**
- **职责:** 工作区、文件、Git、终端
- **领域模型:** Workspace, File, GitRepo
- **能力:** `workspace.select`, `file.read`, `git.status`
- **依赖:** 无

**@roc/plugin-mcp**
- **职责:** Model Context Protocol 集成
- **能力:** `mcp.connect`, `mcp.query`
- **依赖:** @roc/plugin-agent

**@roc/plugin-rtk**
- **职责:** RTK 工具集成
- **能力:** `rtk.execute`
- **依赖:** @roc/plugin-workspace

---

## 6. 数据库重新设计

### 6.1 新架构原则

**原则 1: 每插件独立数据库**

```
data/
├── core.db        # 核心配置、插件元数据、密钥
├── agent.db       # Agent 插件专属
├── memory.db      # Memory 插件专属
├── task.db        # Task 插件专属
└── workspace.db   # Workspace 插件专属
```

**好处:**
- 插件可独立备份/恢复
- 避免单一数据库过大
- 插件卸载时可清理数据

**原则 2: 每个表必须有索引**

所有外键、查询字段都建立索引,避免全表扫描。

### 6.2 Agent 数据库 Schema

```sql
-- agent.db

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  workspace_path TEXT,
  model_config JSON NOT NULL,
  created_at TEXT NOT NULL,
  archived_at TEXT NULL,
  
  INDEX idx_workspace (workspace_path),
  INDEX idx_archived (archived_at)
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,  -- 'user' | 'assistant' | 'system' | 'tool'
  content TEXT NOT NULL,
  metadata JSON,
  created_at TEXT NOT NULL,
  
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  INDEX idx_session_created (session_id, created_at)
);

CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  args JSON NOT NULL,
  result JSON,
  status TEXT NOT NULL,  -- 'pending' | 'success' | 'error'
  created_at TEXT NOT NULL,
  
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  INDEX idx_message (message_id)
);
```

### 6.3 Memory 数据库 Schema

```sql
-- memory.db

CREATE TABLE memory_snapshots (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  snapshot_type TEXT NOT NULL,  -- 'consolidation' | 'archive'
  compressed_content TEXT NOT NULL,
  original_message_ids JSON NOT NULL,
  token_saved INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  
  INDEX idx_session (session_id)
);

CREATE TABLE memory_index (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  embedding BLOB,  -- 向量嵌入(可选)
  created_at TEXT NOT NULL,
  
  INDEX idx_session (session_id),
  INDEX idx_hash (content_hash)
);
```

### 6.4 数据库连接池

```typescript
export class DatabasePool {
  private connections = new Map<string, Database>();
  
  getConnection(pluginId: string): Database {
    if (!this.connections.has(pluginId)) {
      const dbPath = join(this.basePath, `${pluginId}.db`);
      const db = new Database(dbPath);
      
      // 性能优化
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
      db.pragma('cache_size = -64000');  // 64MB
      
      this.connections.set(pluginId, db);
    }
    
    return this.connections.get(pluginId)!;
  }
}
```


---

## 7. 性能优化策略

### 7.1 打包体积优化

**当前基线:** 390MB  
**目标:** <400MB (+10MB)

**策略:**

1. **代码分割**

```typescript
// electron.vite.config.ts
export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        output: {
          manualChunks: (id) => {
            if (id.includes('src/plugins/agent')) return 'plugin-agent';
            if (id.includes('src/plugins/memory')) return 'plugin-memory';
            if (id.includes('@langchain')) return 'langchain';
          }
        }
      }
    }
  }
});
```

2. **懒加载插件**

```typescript
// 核心插件立即加载
loadPriority: 0  // Agent, Memory

// 次要插件延迟加载
loadPriority: 1  // MCP, RTK (3秒后)

// 可选插件按需加载
loadPriority: 2  // 第三方插件
```

3. **Tree Shaking**

确保所有依赖支持 ES Module,移除未使用代码。

### 7.2 内存占用优化

**当前基线:** ~120MB  
**目标:** <150MB (+30MB)

**策略:**

1. **事件总线使用弱引用**

```typescript
class EventBus {
  private listeners = new WeakMap<Plugin, Map<string, Handler>>();
  
  subscribe(plugin: Plugin, event: string, handler: Handler) {
    // 插件卸载时自动清理
  }
}
```

2. **共享基础设施**

```typescript
class PluginContext {
  // 所有插件共享同一个数据库连接池
  readonly database: DatabasePool;
  readonly httpClient: HttpClient;  // 共享 HTTP 客户端
  readonly modelFactory: LangChainModelFactory;  // 共享模型工厂
}
```

3. **数据库查询优化**

- 使用 prepared statements
- 添加适当索引
- 限制结果集大小

### 7.3 启动速度优化

**当前基线:** ~2.5s  
**目标:** <3s (+500ms)

**策略:**

1. **并行初始化**

```typescript
await Promise.all([
  corePlugin.initialize(),
  agentPlugin.initialize(),
  uiPlugin.initialize()
]);
```

2. **延迟初始化非关键插件**

```typescript
// 3秒后再加载 Memory 插件
setTimeout(() => memoryPlugin.initialize(), 3000);
```

3. **插件元数据缓存**

```typescript
// 第一次启动扫描插件
const metadata = scanPlugins();
writeCache('plugin-metadata.json', metadata);

// 后续启动直接读缓存
const metadata = readCache('plugin-metadata.json');
```

### 7.4 运行时性能优化

**目标:** 热路径零开销

**策略:**

1. **快速路径直接调用**

```typescript
// 热路径: 流式输出
const stream = pluginContext.getFastPath('@roc/plugin-agent')
  .streamMessage(sessionId, message);

// 冷路径: 压缩记忆
await pluginContext.invoke('memory.consolidate', { sessionId });
```

2. **事件批处理**

```typescript
// 100个小事件合并为1个批量事件
const batch: Event[] = [];
const timer = setInterval(() => {
  if (batch.length > 0) {
    eventBus.publish({ type: 'batch', payload: batch });
    batch.length = 0;
  }
}, 100);
```

3. **数据库 WAL 模式**

```sql
PRAGMA journal_mode = WAL;  -- Write-Ahead Logging
PRAGMA synchronous = NORMAL;
```


---

## 8. 迁移策略

### 8.1 迁移方式

采用 **Big Bang 迁移**:
- 在新分支完整实现新架构
- 一次性切换,不保持向后兼容
- 提供自动数据迁移脚本

### 8.2 数据迁移脚本

```typescript
// scripts/migrate-data.ts

export async function migrateDatabase(ctx: MigrationContext): Promise<void> {
  console.log('🚀 开始数据迁移...');
  
  const oldDb = new Database(ctx.oldDbPath, { readonly: true });
  const agentDb = new Database(join(ctx.newDbBasePath, 'agent.db'));
  const memoryDb = new Database(join(ctx.newDbBasePath, 'memory.db'));
  const taskDb = new Database(join(ctx.newDbBasePath, 'task.db'));
  
  try {
    // 1. 初始化新数据库表结构
    await initializeSchema(agentDb, 'agent');
    await initializeSchema(memoryDb, 'memory');
    await initializeSchema(taskDb, 'task');
    
    // 2. 迁移 Agent 数据
    console.log('📦 迁移 Agent 数据...');
    await migrateAgentData(oldDb, agentDb);
    
    // 3. 迁移 Memory 数据
    console.log('📦 迁移 Memory 数据...');
    await migrateMemoryData(oldDb, memoryDb);
    
    // 4. 迁移 Task 数据
    console.log('📦 迁移 Task 数据...');
    await migrateTaskData(oldDb, taskDb);
    
    console.log('✅ 迁移完成!');
  } finally {
    oldDb.close();
    agentDb.close();
    memoryDb.close();
    taskDb.close();
  }
}
```

### 8.3 用户迁移流程

首次启动时自动检测并迁移:

```typescript
export class MigrationService {
  async checkMigration(): Promise<boolean> {
    const oldDbPath = join(this.paths.dataDir, 'roc.db');
    const newCoreDbPath = join(this.paths.dataDir, 'core.db');
    
    // 如果旧数据库存在且新数据库不存在,需要迁移
    return fs.existsSync(oldDbPath) && !fs.existsSync(newCoreDbPath);
  }
  
  async performMigration(window: BrowserWindow): Promise<void> {
    // 1. 显示迁移进度窗口
    window.webContents.send('migration.start');
    
    // 2. 备份旧数据库
    window.webContents.send('migration.progress', {
      step: 'backup',
      message: '正在备份旧数据...'
    });
    await this.backupOldDatabase();
    
    // 3. 执行迁移
    window.webContents.send('migration.progress', {
      step: 'migrate',
      message: '正在迁移数据库...'
    });
    await migrateDatabase({...});
    
    // 4. 验证数据完整性
    window.webContents.send('migration.progress', {
      step: 'verify',
      message: '正在验证数据完整性...'
    });
    await this.verifyMigration();
    
    // 5. 完成
    window.webContents.send('migration.complete');
  }
}
```


---

## 9. 测试策略

### 9.1 测试金字塔

```
        /\
       /E2E\        10% (端到端测试)
      /------\
     /Integration\  30% (集成测试)
    /------------\
   /   Unit Tests  \ 60% (单元测试)
  /----------------\
```

### 9.2 插件单元测试

```typescript
// tests/plugins/agent-plugin.test.ts

describe('AgentPlugin', () => {
  let harness: PluginTestHarness;
  let plugin: AgentPlugin;
  
  beforeEach(async () => {
    harness = new PluginTestHarness();
    plugin = await harness.loadPlugin(AgentPlugin);
  });
  
  it('应该成功初始化', () => {
    expect(plugin.manifest.id).toBe('@roc/plugin-agent');
  });
  
  it('应该创建新会话', async () => {
    const sessionId = await plugin.fastPath.createSession({
      workspacePath: '/test',
      modelConfig: { model: 'gpt-4' }
    });
    
    expect(sessionId).toBeDefined();
  });
  
  it('未配置模型时健康检查应返回 unhealthy', async () => {
    const health = await plugin.healthCheck();
    expect(health.status).toBe('unhealthy');
  });
});
```

### 9.3 集成测试

```typescript
// tests/integration/plugin-communication.test.ts

describe('插件间通信', () => {
  it('Agent 消息应触发 Memory 压缩', async () => {
    const loader = new PluginLoader(/* ... */);
    
    // 加载插件
    await loader.loadAllPlugins([
      AgentPlugin.manifest,
      MemoryPlugin.manifest
    ]);
    
    // 创建会话并发送消息
    const sessionId = await loader.context.invoke('agent.session.create', {
      workspacePath: '/test'
    });
    
    // 发送大量消息直到触发压缩
    for (let i = 0; i < 100; i++) {
      await loader.context.invoke('agent.message.send', {
        sessionId,
        content: 'Large message'.repeat(100)
      });
    }
    
    // 验证压缩事件已发布
    const events = capturedEvents();
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'memory.consolidated' })
    );
  });
});
```

### 9.4 性能测试

```typescript
// tests/performance/plugin-overhead.test.ts

describe('插件性能', () => {
  it('事件总线发布应在 1ms 内完成', () => {
    const eventBus = new EventBusImpl();
    
    // 订阅 100 个监听器
    for (let i = 0; i < 100; i++) {
      eventBus.subscribe('test.event', () => {});
    }
    
    const start = performance.now();
    eventBus.publish({ type: 'test.event', payload: {} });
    const duration = performance.now() - start;
    
    expect(duration).toBeLessThan(1);
  });
  
  it('快速路径应比事件总线快 10x', async () => {
    // 测试快速路径 vs 事件总线性能差异
  });
});
```

### 9.5 测试覆盖率目标

| 层级 | 目标覆盖率 |
|------|-----------|
| Kernel | >90% |
| Plugins | >85% |
| Infrastructure | >80% |
| Renderer | >70% |
| **总体** | **>80%** |


---

## 10. 实施路线图

总计 **14 周**,分为 6 个阶段。

### Phase 1: 基础设施 (Week 1-2)

**目标:** 搭建内核和基础设施层

**交付物:**
- ✅ Event Bus 实现及测试
- ✅ Plugin Loader 实现及测试
- ✅ Database Pool 实现及测试
- ✅ Config Store 实现及测试
- ✅ Secret Manager 实现及测试
- ✅ 新数据库 Schema 设计
- ✅ 数据迁移脚本

**验收标准:**
- 内核代码 <1000 lines
- 所有基础设施单元测试通过
- 数据迁移脚本可成功迁移样本数据

---

### Phase 2: 核心插件 (Week 3-5)

**目标:** 实现 Agent、Memory、Task 三大核心插件

**Week 3 - Agent 插件:**
- ✅ 定义领域模型 (Session, Message, ToolCall)
- ✅ 实现 SessionRepository
- ✅ 实现 ModelFactory (迁移 langchain-model-factory.ts)
- ✅ 实现流式消息处理
- ✅ 实现快速路径
- ✅ 编写插件测试

**Week 4 - Memory 插件:**
- ✅ 定义领域模型 (Memory, Consolidation)
- ✅ 实现 MemoryRepository
- ✅ 实现 Consolidator
- ✅ 订阅 Agent 事件自动压缩
- ✅ 编写插件测试

**Week 5 - Task 插件:**
- ✅ 定义领域模型 (Task, Schedule, Execution)
- ✅ 实现 TaskRepository
- ✅ 实现 Scheduler
- ✅ 集成 cron 解析
- ✅ 编写插件测试

**验收标准:**
- 每个插件主文件 <200 lines
- 所有插件单元测试通过
- 插件间通信集成测试通过

---

### Phase 3: 次要插件 (Week 6-7)

**目标:** 实现 Workspace、MCP、RTK 插件

**Week 6 - Workspace 插件:**
- ✅ 迁移文件服务
- ✅ 迁移 Git 服务
- ✅ 迁移终端服务
- ✅ 编写测试

**Week 7 - MCP & RTK 插件:**
- ✅ 迁移 MCP 集成
- ✅ 迁移 RTK 集成
- ✅ 编写测试

**验收标准:**
- 所有插件测试通过
- 与核心插件的集成测试通过

---

### Phase 4: Renderer 重构 (Week 8-10)

**目标:** 重构前端为 Feature Module + View Model 架构

**Week 8 - 基础设施:**
- ✅ 实现 IPC Bridge
- ✅ 实现 View Model 基类
- ✅ 实现 Observable 原语
- ✅ 提取共享组件库

**Week 9-10 - Feature Modules:**
- ✅ 重构 Chat Feature (923 lines → ~500 lines)
- ✅ 重构 Tasks Feature
- ✅ 重构 Memory Feature
- ✅ 重构 Settings Feature (423 lines → ~300 lines)
- ✅ 重构 Workbench Feature

**验收标准:**
- 所有 Feature Module 主文件 <200 lines
- UI 组件文件 <100 lines
- View Model 文件 <150 lines
- 所有 UI 测试通过

---

### Phase 5: 集成与优化 (Week 11-12)

**目标:** 端到端集成,性能优化,文档完善

**Week 11 - 集成:**
- ✅ Main Process 集成所有插件
- ✅ IPC Router 连接前后端
- ✅ 端到端测试
- ✅ 用户验收测试

**Week 12 - 优化:**
- ✅ 性能测试和优化
  - 启动速度 <3s
  - 内存占用 <150MB
  - 打包体积 <400MB
- ✅ 懒加载优化
- ✅ 代码分割优化
- ✅ 数据库查询优化

**Week 12 - 文档:**
- ✅ 架构文档
- ✅ 插件开发指南
- ✅ 迁移指南
- ✅ API 文档

**验收标准:**
- 所有性能指标达标
- 所有端到端测试通过
- 文档完整

---

### Phase 6: 发布准备 (Week 13-14)

**目标:** 最终测试、打包、发布

**Week 13:**
- ✅ 完整回归测试
- ✅ 生产环境烟雾测试
- ✅ 编写 Release Notes
- ✅ 打包和签名

**Week 14:**
- ✅ Beta 测试
- ✅ 修复关键 Bug
- ✅ 正式发布

**验收标准:**
- 所有关键 Bug 修复
- Beta 测试无重大问题
- 发布文档完整


---

## 11. 风险管理

### 11.1 高风险项

**风险 1: 数据迁移失败**
- **影响:** 用户数据丢失或损坏
- **概率:** 中
- **缓解措施:**
  - 迁移前自动备份旧数据库
  - 迁移后验证数据完整性
  - 提供回滚机制
  - Beta 测试阶段充分验证
  - 保留旧数据库至少 30 天

**风险 2: 性能退化**
- **影响:** 用户体验下降
- **概率:** 中
- **缓解措施:**
  - 早期建立性能基准
  - 每个 Phase 都进行性能测试
  - 快速路径优化热路径
  - 懒加载减少初始负载
  - 持续监控关键性能指标

**风险 3: 插件依赖冲突**
- **影响:** 插件加载失败,功能不可用
- **概率:** 低
- **缓解措施:**
  - 拓扑排序自动解决依赖顺序
  - 插件加载失败时有清晰错误信息
  - 核心插件与可选插件分离
  - 提供插件依赖可视化工具

**风险 4: 开发周期延长**
- **影响:** 项目延期
- **概率:** 中
- **缓解措施:**
  - 每周 milestone review
  - 优先实现核心功能
  - 次要功能可以后续迭代
  - 保持团队沟通频繁
  - 预留 2 周缓冲时间

### 11.2 中风险项

**风险 5: 第三方库兼容性**
- **影响:** 功能缺失或不稳定
- **概率:** 低
- **缓解措施:**
  - 早期验证 LangChain/DeepAgents 集成
  - 适配器模式隔离外部依赖
  - 保持依赖版本稳定

**风险 6: Electron 限制**
- **影响:** 某些功能无法实现
- **概率:** 低
- **缓解措施:**
  - 研究 Electron 最佳实践
  - Preload 白名单严格控制
  - 遵循 Electron 安全建议

---

## 12. 成功指标

### 12.1 代码质量指标

| 指标 | 当前 | 目标 | 测量方法 |
|------|------|------|----------|
| **最大文件行数** | 1486 | <300 | ESLint max-lines |
| **平均文件行数** | ~250 | <150 | 统计所有源文件 |
| **单文件依赖数** | 17 | <8 | 依赖注入参数数量 |
| **循环依赖** | 未知 | 0 | madge 工具检测 |
| **测试覆盖率** | 未知 | >80% | Vitest coverage |
| **插件独立性** | 0% | 100% | 零硬依赖 |

### 12.2 性能指标

| 指标 | 当前 | 目标 | 测量方法 |
|------|------|------|----------|
| **冷启动时间** | ~2.5s | <3s | 从启动到首屏渲染 |
| **热启动时间** | ~1.5s | <2s | 应用已运行时重启 |
| **内存占用(闲置)** | ~120MB | <150MB | Chrome DevTools |
| **内存占用(活跃)** | ~200MB | <250MB | 流式输出时 |
| **打包体积** | 390MB | <400MB | release/ 目录大小 |
| **IPC 调用延迟** | 未知 | <5ms | Performance API |
| **流式输出延迟** | 未知 | <50ms | 首个 chunk 到达 |

### 12.3 可维护性指标

| 指标 | 目标 | 测量方法 |
|------|------|----------|
| **新插件开发时间** | <3 天 | 从需求到测试通过 |
| **Bug 修复时间** | <1 天 | 从报告到部署 |
| **代码审查时间** | <2 小时 | PR 提交到合并 |
| **新人上手时间** | <1 周 | 从入职到提交首个 PR |
| **文档完整度** | 100% | 所有公共 API 有文档 |

### 12.4 用户体验指标

| 指标 | 目标 | 测量方法 |
|------|------|----------|
| **数据迁移成功率** | >99% | Beta 测试统计 |
| **迁移时间** | <30s | 对于普通用户数据量 |
| **迁移失败回滚率** | 100% | 失败时自动回滚 |
| **功能完整性** | 100% | 所有旧功能保留 |
| **用户满意度** | >90% | Beta 测试问卷 |

---

## 13. 附录

### 13.1 参考资料

1. **Forge 论文**
   - Zambelli, A. *Forge: A Reliability Layer for Self-Hosted LLM Tool-Calling.*
   - DOI: 10.1145/3786335.3813193
   - 启发: Fail Fast、显式压倒隐式、控制流独立

2. **架构模式**
   - Martin Fowler. *Patterns of Enterprise Application Architecture*
   - 插件架构、仓储模式、领域驱动设计

3. **Electron 最佳实践**
   - Electron Security Checklist
   - Context Isolation、IPC 白名单

### 13.2 术语表

| 术语 | 定义 |
|------|------|
| **Plugin** | 独立可插拔的功能模块 |
| **Capability** | 插件对外提供的能力接口 |
| **Event Bus** | 插件间通信的事件总线 |
| **Fast Path** | 绕过事件总线的直接调用路径 |
| **Domain Model** | 领域驱动设计中的业务实体 |
| **Repository** | 数据访问抽象层 |
| **View Model** | 连接 UI 和业务逻辑的桥梁 |

### 13.3 项目结构清单

```
roc/
├── src/
│   ├── kernel/                   # 微内核 (~1000 lines)
│   ├── plugins/                  # 插件集合
│   │   ├── agent/                # ~800 lines
│   │   ├── memory/               # ~600 lines
│   │   ├── task/                 # ~700 lines
│   │   ├── workspace/            # ~500 lines
│   │   ├── mcp/                  # ~400 lines
│   │   └── rtk/                  # ~300 lines
│   ├── infrastructure/           # 基础设施层
│   ├── main/                     # Main Process (~500 lines)
│   ├── preload/                  # Preload (~100 lines)
│   ├── renderer/                 # Renderer Process
│   │   ├── features/             # Feature Modules
│   │   │   ├── chat/             # ~500 lines
│   │   │   ├── tasks/            # ~400 lines
│   │   │   ├── memory/           # ~300 lines
│   │   │   ├── settings/         # ~350 lines
│   │   │   └── workbench/        # ~450 lines
│   │   └── shared/               # 共享组件库
│   └── shared/                   # 跨进程共享
├── tests/                        # 测试
├── scripts/                      # 脚本
├── docs/                         # 文档
└── package.json
```

---

## 结论

本设计文档描述了 Roc 项目的全面架构现代化方案,采用**插件化微内核 + 轻量 DDD**混合架构,在解决代码可维护性、模块化解耦、可扩展性问题的同时,保持性能可控。

**核心价值:**
1. ✅ 文件大小从 1486 行降至 <300 行
2. ✅ 模块间零硬依赖,完全解耦
3. ✅ 新功能=新插件,零侵入式扩展
4. ✅ 性能开销可控 (+15MB 内存, +200ms 启动)
5. ✅ 14 周可完成,风险可控

**下一步行动:**
1. Review 本设计文档
2. 获得团队和用户批准
3. 创建开发分支 `architecture-modernization`
4. 启动 Phase 1: 基础设施开发

---

**文档版本历史:**
- v1.0.0 (2026-06-04): 初始版本

**审核状态:** 待审核

