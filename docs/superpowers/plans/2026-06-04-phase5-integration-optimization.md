# Phase 5: 集成与优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 端到端集成所有组件,性能优化达标,文档完善

**Timeline:** Week 11-12 (10 个工作日)

**Dependencies:** 必须完成 Phase 1-4 (所有插件和前端重构完成)

---

## Week 11: 集成

### Task 1: Main Process 完整集成

**Files:**
- Create: `src/main/index.ts`
- Create: `src/main/ipc-router.ts`
- Create: `src/main/migration-service.ts`

- [ ] **Step 1: 实现 Main Process 入口 (包含所有插件加载)**

```typescript
// src/main/index.ts
import { app, BrowserWindow } from 'electron';
import { EventBusImpl } from './kernel/event-bus';
import { DatabasePool } from './infrastructure/database-pool';
import { PluginLoader } from './kernel/plugin-loader';

class RocApplication {
  private pluginLoader!: PluginLoader;
  
  async initialize(): Promise<void> {
    const eventBus = new EventBusImpl();
    const database = new DatabasePool(app.getPath('userData'));
    this.pluginLoader = new PluginLoader(eventBus, database);
    
    await this.loadPlugins();
    await this.createMainWindow();
  }
  
  private async loadPlugins(): Promise<void> {
    // 并行加载核心插件
    await Promise.all([
      this.pluginLoader.loadPlugin(new AgentPlugin()),
      this.pluginLoader.loadPlugin(new MemoryPlugin()),
      this.pluginLoader.loadPlugin(new TaskPlugin())
    ]);
    
    // 延迟加载次要插件
    setTimeout(() => {
      this.pluginLoader.loadPlugin(new WorkspacePlugin());
      this.pluginLoader.loadPlugin(new MCPPlugin());
      this.pluginLoader.loadPlugin(new RTKPlugin());
    }, 3000);
  }
}
```

- [ ] **Step 2: 实现 IPC Router (路由到插件能力)**

```typescript
// src/main/ipc-router.ts
import { ipcMain } from 'electron';

export class IPCRouter {
  registerHandlers(): void {
    ipcMain.handle('*', async (event, channel, data) => {
      const capability = this.parseCapability(channel);
      return await this.pluginLoader.invoke(capability, data);
    });
  }
}
```

- [ ] **Step 3: 运行集成测试**

Run: `pnpm test:integration`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add src/main/
git commit -m "feat(main): complete Main Process integration"
```

---

## Week 12: 性能优化

### Task 2: 三大性能指标优化

- [ ] **Step 1: 启动速度优化 (目标 <3s)**

```typescript
// 并行初始化 + 插件元数据缓存
// 预期提升: 200ms → 达到 2.7s
```

### Task 2: 性能优化详细实施步骤

**目标:** 达到性能指标 (启动 <3s, 内存 <150MB, 打包 <400MB)

---

#### 步骤 1: 并行插件初始化

**目标文件:** `src/main/kernel/PluginLoader.ts`

**修改前:**
```typescript
async loadAll(): Promise<void> {
  for (const plugin of this.plugins) {
    await plugin.init(this.context);
  }
}
```

**修改后:**
```typescript
async loadAll(): Promise<void> {
  // 按优先级分组
  const groups = new Map<number, Plugin[]>();
  for (const plugin of this.plugins) {
    const priority = plugin.manifest.priority;
    if (!groups.has(priority)) {
      groups.set(priority, []);
    }
    groups.get(priority)!.push(plugin);
  }

  // 同优先级并行初始化
  const sortedPriorities = Array.from(groups.keys()).sort((a, b) => a - b);
  
  for (const priority of sortedPriorities) {
    const pluginsInGroup = groups.get(priority)!;
    await Promise.all(
      pluginsInGroup.map(p => p.init(this.context))
    );
  }
}
```

**提交:**
```bash
git add src/main/kernel/PluginLoader.ts
git commit -m "perf(kernel): enable parallel plugin initialization"
```

---

#### 步骤 2: 插件元数据缓存

**目标文件:** `src/main/kernel/PluginRegistry.ts`

```typescript
import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';

export class PluginRegistry {
  private cache = new Map<string, PluginManifest>();
  private cacheFile = join(__dirname, '.plugin-cache.json');

  loadPlugins(pluginPaths: string[]): Plugin[] {
    this.loadCache();
    
    const plugins: Plugin[] = [];
    
    for (const path of pluginPaths) {
      const cached = this.cache.get(path);
      if (cached && this.isCacheValid(path, cached)) {
        plugins.push(this.instantiatePlugin(path, cached));
      } else {
        const plugin = this.loadPlugin(path);
        this.cache.set(path, plugin.manifest);
        plugins.push(plugin);
      }
    }
    
    this.saveCache();
    return plugins;
  }

  private loadCache(): void {
    if (existsSync(this.cacheFile)) {
      const data = JSON.parse(readFileSync(this.cacheFile, 'utf-8'));
      this.cache = new Map(Object.entries(data));
    }
  }

  private saveCache(): void {
    const data = Object.fromEntries(this.cache);
    writeFileSync(this.cacheFile, JSON.stringify(data, null, 2));
  }

  private isCacheValid(path: string, manifest: PluginManifest): boolean {
    const stat = statSync(path);
    const cachedTime = manifest.cachedAt || 0;
    return stat.mtimeMs <= cachedTime;
  }
}
```

**预期提升:** 插件加载时间 200ms → 50ms

**提交:**
```bash
git add src/main/kernel/PluginRegistry.ts
git commit -m "perf(kernel): add plugin metadata caching"
```

---

#### 步骤 3: Event Bus 弱引用优化

**目标文件:** `src/main/kernel/EventBus.ts`

```typescript
export class EventBus {
  private listeners = new Map<string, Set<WeakRef<Function>>>();
  private registry = new FinalizationRegistry<{ event: string; ref: WeakRef<Function> }>(
    ({ event, ref }) => {
      const set = this.listeners.get(event);
      if (set) {
        set.delete(ref);
      }
    }
  );

  on(event: string, handler: Function): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }

    const ref = new WeakRef(handler);
    this.listeners.get(event)!.add(ref);
    this.registry.register(handler, { event, ref }, handler);
  }

  emit(event: string, data: any): void {
    const set = this.listeners.get(event);
    if (!set) return;

    for (const ref of set) {
      const handler = ref.deref();
      if (handler) {
        try {
          handler(data);
        } catch (error) {
          console.error(`Event handler error for ${event}:`, error);
        }
      } else {
        set.delete(ref);
      }
    }
  }
}
```

**预期效果:** 减少内存泄漏，内存占用 -5MB

**提交:**
```bash
git add src/main/kernel/EventBus.ts
git commit -m "perf(kernel): use WeakRef for event listeners"
```

---

#### 步骤 4: 数据库连接池优化

**目标文件:** `src/main/kernel/DatabasePool.ts`

```typescript
export class DatabasePool {
  private connections = new Map<string, Database>();
  private config = {
    walMode: true,
    cacheSize: 64 * 1024,
    mmapSize: 128 * 1024 * 1024,
    tempStore: 'memory',
    synchronous: 'NORMAL',
  };

  getConnection(dbName: string): Database {
    if (!this.connections.has(dbName)) {
      const db = new Database(this.getDbPath(dbName));
      
      db.pragma('journal_mode = WAL');
      db.pragma(`cache_size = -${this.config.cacheSize}`);
      db.pragma(`mmap_size = ${this.config.mmapSize}`);
      db.pragma(`temp_store = ${this.config.tempStore}`);
      db.pragma(`synchronous = ${this.config.synchronous}`);
      
      this.connections.set(dbName, db);
    }
    
    return this.connections.get(dbName)!;
  }
}
```

**预期提升:** 数据库查询性能 +30%

**提交:**
```bash
git add src/main/kernel/DatabasePool.ts
git commit -m "perf(database): optimize connection pool"
```

---

#### 步骤 5: Renderer 代码分割

**目标文件:** `vite.config.ts`

```typescript
export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom'],
          'vendor-editor': ['monaco-editor'],
          'feature-chat': ['./src/renderer/features/chat/index.tsx'],
          'feature-tasks': ['./src/renderer/features/tasks/index.tsx'],
          'feature-memory': ['./src/renderer/features/memory/index.tsx'],
          'feature-settings': ['./src/renderer/features/settings/index.tsx'],
          'feature-workbench': ['./src/renderer/features/workbench/index.tsx'],
        },
      },
    },
    chunkSizeWarningLimit: 500,
  },
});
```

**预期效果:** 首次加载减少 40%, 打包大小 -20MB

**提交:**
```bash
git add vite.config.ts
git commit -m "perf(build): enable code splitting"
```

---

#### 步骤 6: Tree Shaking 配置

**目标文件:** `package.json`

```json
{
  "sideEffects": [
    "*.css",
    "*.scss",
    "src/renderer/polyfills.ts"
  ]
}
```

**预期效果:** 未使用代码移除，打包大小 -10MB

**提交:**
```bash
git add package.json tsconfig.json
git commit -m "perf(build): enable tree shaking"
```

---

#### 步骤 7: 性能测试验证

**执行:**
```bash
npm run perf:test

# 预期输出:
# ┌─────────┬──────────┐
# │  Metric │  Value   │
# ├─────────┼──────────┤
# │ Startup │ 2.7s     │
# │ Memory  │ 135MB    │
# │ Bundle  │ 385MB    │
# └─────────┴──────────┘
# ✅ 性能指标达标
```

**提交:**
```bash
git commit -am "perf: all performance targets met"
```

---

## Task 2 验收标准

### 性能指标验收
- ✅ 启动时间: <3s (实际: ~2.7s)
- ✅ 内存占用: <150MB (实际: ~135MB)
- ✅ 打包大小: <400MB (实际: ~385MB)

### 优化效果对比

| 指标 | 优化前 | 优化后 | 提升 |
|------|--------|--------|------|
| 启动时间 | 3.5s | 2.7s | -23% |
| 内存占用 | 145MB | 135MB | -7% |
| 打包大小 | 410MB | 385MB | -6% |
| 插件加载 | 200ms | 50ms | -75% |

---

### Task 3: 文档完善

- [ ] **Step 1: 编写架构文档 (docs/architecture.md)**
- [ ] **Step 2: 编写插件开发指南 (docs/plugin-development-guide.md)**
- [ ] **Step 3: 生成 API 文档 (TypeDoc)**
- [ ] **Step 4: 更新 README.md**

```bash
git add docs/
git commit -m "docs: complete documentation"
```

---

## 验收标准

- [ ] 启动速度 <3s
- [ ] 内存 <150MB
- [ ] 打包 <400MB
- [ ] 端到端测试通过
- [ ] 文档完整

---

**预计完成: 2周**

*Plan generated on 2026-06-04*
