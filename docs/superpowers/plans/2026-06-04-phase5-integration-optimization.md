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

- [ ] **Step 2: 内存优化 (目标 <150MB)**

```typescript
// Event Bus 弱引用 + 数据库缓存优化
// 预期: 120MB → 135MB
```

- [ ] **Step 3: 打包体积优化 (目标 <400MB)**

```typescript
// 代码分割 + Tree shaking
// 预期: 390MB → 395MB
```

- [ ] **Step 4: 性能测试验证**

Run: `pnpm test:performance`
Expected: 所有指标达标

- [ ] **Step 5: 提交**

```bash
git commit -am "perf: all performance targets met"
```

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
