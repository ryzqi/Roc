# Phase 2: 核心插件实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 Agent、Memory、Task 三大核心插件,建立插件化架构的业务层基础

**Architecture:** 每个插件采用轻量 DDD 模式,包含领域模型、业务逻辑、数据访问层。插件间通过事件总线解耦通信。

**Tech Stack:** TypeScript 6.0.3, LangChain 1.4.1, DeepAgents 1.10.2, Better-SQLite3 12.10.0, Zod (验证)

**Timeline:** Week 3-5 (15 个工作日)

**Dependencies:** 必须完成 Phase 1 (基础设施层)

---

## 文件结构规划

### Agent 插件 (~800 lines)

```
src/plugins/agent/
├── index.ts                    # 插件入口 (~150 lines)
├── domain/                     # 领域模型
│   ├── session.ts              # 会话实体 (~150 lines)
│   ├── message.ts              # 消息实体 (~100 lines)
│   └── tool-call.ts            # 工具调用实体 (~80 lines)
├── services/                   # 领域服务
│   ├── agent-runtime.ts        # Agent 运行时 (~200 lines)
│   └── model-factory.ts        # 模型工厂 (~250 lines, 迁移自旧代码)
├── repository/                 # 数据访问
│   └── session-repository.ts   # 会话仓储 (~120 lines)
└── package.json                # 插件元数据
```

### Memory 插件 (~600 lines)

```
src/plugins/memory/
├── index.ts                    # 插件入口 (~150 lines)
├── domain/
│   ├── memory.ts               # 记忆实体 (~100 lines)
│   └── consolidation.ts        # 压缩策略 (~80 lines)
├── services/
│   └── consolidator.ts         # 压缩服务 (~200 lines)
├── repository/
│   └── memory-repository.ts    # 记忆仓储 (~100 lines)
└── package.json
```

### Task 插件 (~700 lines)

```
src/plugins/task/
├── index.ts                    # 插件入口 (~150 lines)
├── domain/
│   ├── task.ts                 # 任务实体 (~150 lines)
│   ├── schedule.ts             # 调度配置 (~80 lines)
│   └── execution.ts            # 执行记录 (~100 lines)
├── services/
│   └── scheduler.ts            # 调度器 (~200 lines)
├── repository/
│   └── task-repository.ts      # 任务仓储 (~120 lines)
└── package.json
```

---

## Week 3: Agent 插件

### Task 1: Agent 领域模型

**Files:**
- Create: `src/plugins/agent/domain/session.ts`
- Create: `src/plugins/agent/domain/message.ts`
- Create: `src/plugins/agent/domain/tool-call.ts`
- Test: `tests/plugins/agent/domain/session.test.ts`

- [ ] **Step 1: 编写 Session 领域模型测试**

```typescript
// tests/plugins/agent/domain/session.test.ts
import { describe, it, expect } from 'vitest';
import { Session } from '../../../src/plugins/agent/domain/session';
import { Message } from '../../../src/plugins/agent/domain/message';

describe('Session Domain Model', () => {
  it('应该创建新会话', () => {
    const session = Session.create({
      workspacePath: '/test/workspace',
      modelConfig: { model: 'gpt-4', temperature: 0.7 }
    });
    
    expect(session.id).toBeDefined();
    expect(session.workspacePath).toBe('/test/workspace');
    expect(session.messages).toHaveLength(0);
  });
  
  it('应该添加用户消息', () => {
    const session = Session.create({
      workspacePath: '/test',
      modelConfig: { model: 'gpt-4' }
    });
    
    const message = session.addUserMessage('Hello');
    
    expect(session.messages).toHaveLength(1);
    expect(message.role).toBe('user');
    expect(message.content).toBe('Hello');
  });
  
  it('应该拒绝在归档会话中添加消息', () => {
    const session = Session.create({
      workspacePath: '/test',
      modelConfig: { model: 'gpt-4' }
    });
    
    session.archive();
    
    expect(() => {
      session.addUserMessage('Test');
    }).toThrow('Cannot add message to archived session');
  });
  
  it('应该计算会话的 token 数量', () => {
    const session = Session.create({
      workspacePath: '/test',
      modelConfig: { model: 'gpt-4' }
    });
    
    session.addUserMessage('Hello world');
    session.addAssistantMessage('Hi there');
    
    // 简单估算: 每个字符约0.25 tokens
    const tokenCount = session.estimateTokens();
    expect(tokenCount).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test tests/plugins/agent/domain/session.test.ts`
Expected: FAIL - Session 类不存在

- [ ] **Step 3: 实现 Session 领域模型 (Part 1/2)**

```typescript
// src/plugins/agent/domain/session.ts
import { randomUUID } from 'crypto';
import type { Message } from './message';

export interface ModelConfig {
  model: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}

export interface SessionData {
  id: string;
  workspacePath: string;
  modelConfig: ModelConfig;
  messages: Message[];
  createdAt: Date;
  archivedAt: Date | null;
}

export class Session {
  private constructor(
    public readonly id: string,
    public readonly workspacePath: string,
    public readonly modelConfig: ModelConfig,
    private _messages: Message[],
    public readonly createdAt: Date,
    private _archivedAt: Date | null
  ) {}
  
  static create(params: {
    workspacePath: string;
    modelConfig: ModelConfig;
  }): Session {
    return new Session(
      randomUUID(),
      params.workspacePath,
      params.modelConfig,
      [],
      new Date(),
      null
    );
  }
  
  static fromData(data: SessionData): Session {
    return new Session(
      data.id,
      data.workspacePath,
      data.modelConfig,
      data.messages,
      data.createdAt,
      data.archivedAt
    );
  }
  
  // __CONTINUE_SESSION_PART_2__
```

- [ ] **Step 4: 实现 Session 领域模型 (Part 2/2)**

```typescript
// src/plugins/agent/domain/session.ts (续)
  
  get messages(): readonly Message[] {
    return this._messages;
  }
  
  get isArchived(): boolean {
    return this._archivedAt !== null;
  }
  
  addUserMessage(content: string): Message {
    this.ensureNotArchived();
    
    const message: Message = {
      id: randomUUID(),
      sessionId: this.id,
      role: 'user',
      content,
      metadata: {},
      createdAt: new Date()
    };
    
    this._messages.push(message);
    return message;
  }
  
  addAssistantMessage(content: string): Message {
    this.ensureNotArchived();
    
    const message: Message = {
      id: randomUUID(),
      sessionId: this.id,
      role: 'assistant',
      content,
      metadata: {},
      createdAt: new Date()
    };
    
    this._messages.push(message);
    return message;
  }
  
  archive(): void {
    if (this._archivedAt) {
      throw new Error('Session is already archived');
    }
    this._archivedAt = new Date();
  }
  
  estimateTokens(): number {
    // 简单估算: 每个字符约0.25 tokens
    const totalChars = this._messages.reduce(
      (sum, msg) => sum + msg.content.length,
      0
    );
    return Math.ceil(totalChars * 0.25);
  }
  
  toData(): SessionData {
    return {
      id: this.id,
      workspacePath: this.workspacePath,
      modelConfig: this.modelConfig,
      messages: [...this._messages],
      createdAt: this.createdAt,
      archivedAt: this._archivedAt
    };
  }
  
  private ensureNotArchived(): void {
    if (this.isArchived) {
      throw new Error('Cannot add message to archived session');
    }
  }
}
```

- [ ] **Step 5: 实现 Message 类型定义**

```typescript
// src/plugins/agent/domain/message.ts

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface Message {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface MessageChunk {
  content: string;
  finish_reason?: string;
}
```

- [ ] **Step 6: 实现 ToolCall 类型定义**

```typescript
// src/plugins/agent/domain/tool-call.ts

export type ToolCallStatus = 'pending' | 'success' | 'error';

export interface ToolCall {
  id: string;
  messageId: string;
  toolId: string;
  args: Record<string, unknown>;
  result: unknown | null;
  status: ToolCallStatus;
  createdAt: Date;
  completedAt: Date | null;
}
```

- [ ] **Step 7: 运行测试验证通过**

Run: `pnpm test tests/plugins/agent/domain/`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git add src/plugins/agent/domain/ tests/plugins/agent/domain/
git commit -m "feat(agent): implement domain models

- Session: 会话管理,消息添加,归档
- Message: 消息类型定义
- ToolCall: 工具调用类型定义
- 业务规则封装在实体内(Fail Fast)"
```

---

### Task 2: Agent 插件主体实现

**Files:**
- Create: `src/plugins/agent/index.ts`
- Create: `src/plugins/agent/services/agent-runtime.ts`
- Create: `src/plugins/agent/repository/session-repository.ts`
- Test: `tests/plugins/agent/index.test.ts`

- [ ] **Step 1: 编写 Agent 插件测试**

```typescript
// tests/plugins/agent/index.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { PluginTestHarness } from '../../test-harness';
import AgentPlugin from '../../../src/plugins/agent';

describe('Agent Plugin', () => {
  let harness: PluginTestHarness;
  let plugin: AgentPlugin;
  
  beforeEach(async () => {
    harness = new PluginTestHarness();
    plugin = await harness.loadPlugin(AgentPlugin) as AgentPlugin;
  });
  
  it('应该成功初始化', () => {
    expect(plugin.manifest.id).toBe('@roc/plugin-agent');
    expect(plugin.manifest.core).toBe(true);
  });
  
  it('应该注册 agent.chat.stream 能力', () => {
    const capability = plugin.manifest.capabilities.find(
      c => c.name === 'agent.chat.stream'
    );
    expect(capability).toBeDefined();
  });
  
  it('应该提供快速路径', () => {
    expect(plugin.fastPath).toBeDefined();
    expect(typeof plugin.fastPath.streamMessage).toBe('function');
  });
});
```

- [ ] **Step 2: 实现 SessionRepository**

```typescript
// src/plugins/agent/repository/session-repository.ts
import type { Database } from 'better-sqlite3';
import { Session, type SessionData } from '../domain/session';
import type { Message } from '../domain/message';

export class SessionRepository {
  constructor(private readonly db: Database) {}
  
  async findById(id: string): Promise<Session | null> {
    const sessionRow = this.db.prepare(
      'SELECT * FROM sessions WHERE id = ?'
    ).get(id);
    
    if (!sessionRow) return null;
    
    const messageRows = this.db.prepare(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC'
    ).all(id);
    
    const sessionData: SessionData = {
      id: (sessionRow as any).id,
      workspacePath: (sessionRow as any).workspace_path,
      modelConfig: JSON.parse((sessionRow as any).model_config),
      messages: messageRows.map((row: any) => ({
        id: row.id,
        sessionId: row.session_id,
        role: row.role,
        content: row.content,
        metadata: JSON.parse(row.metadata || '{}'),
        createdAt: new Date(row.created_at)
      })),
      createdAt: new Date((sessionRow as any).created_at),
      archivedAt: (sessionRow as any).archived_at 
        ? new Date((sessionRow as any).archived_at) 
        : null
    };
    
    return Session.fromData(sessionData);
  }
  
  async save(session: Session): Promise<void> {
    const data = session.toData();
    
    this.db.transaction(() => {
      // 保存或更新会话
      this.db.prepare(`
        INSERT INTO sessions (id, workspace_path, model_config, created_at, archived_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          archived_at = excluded.archived_at
      `).run(
        data.id,
        data.workspacePath,
        JSON.stringify(data.modelConfig),
        data.createdAt.toISOString(),
        data.archivedAt?.toISOString() || null
      );
      
      // 保存消息
      for (const message of data.messages) {
        this.db.prepare(`
          INSERT OR IGNORE INTO messages 
          (id, session_id, role, content, metadata, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          message.id,
          message.sessionId,
          message.role,
          message.content,
          JSON.stringify(message.metadata),
          message.createdAt.toISOString()
        );
      }
    })();
  }
}
```

- [ ] **Step 3: 实现 Agent 插件入口 (简化版)**

```typescript
// src/plugins/agent/index.ts
import type { Plugin, PluginManifest, PluginContext } from '../../kernel/types';
import { z } from 'zod';
import { SessionRepository } from './repository/session-repository';

export default class AgentPlugin implements Plugin {
  readonly manifest: PluginManifest = {
    id: '@roc/plugin-agent',
    version: '1.0.0',
    name: 'Agent Runtime',
    description: 'LangChain/DeepAgents 运行时',
    author: 'Roc Team',
    dependencies: {
      plugins: [],
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
        outputSchema: z.custom<AsyncIterable<any>>()
      },
      {
        name: 'agent.session.create',
        version: '1.0.0',
        inputSchema: z.object({
          workspacePath: z.string(),
          modelConfig: z.object({
            model: z.string()
          })
        }),
        outputSchema: z.string()
      }
    ],
    core: true,
    loadPriority: 0
  };
  
  private context!: PluginContext;
  private sessionRepo!: SessionRepository;
  
  async initialize(context: PluginContext): Promise<void> {
    this.context = context;
    
    const db = context.database.getConnection('agent');
    this.sessionRepo = new SessionRepository(db);
    
    context.logger.info('Agent plugin initialized');
  }
  
  async shutdown(): Promise<void> {
    // 清理资源
  }
  
  async healthCheck() {
    return { status: 'healthy' as const };
  }
  
  // 快速路径
  readonly fastPath = {
    streamMessage: this.streamMessageDirect.bind(this),
    createSession: this.createSessionDirect.bind(this)
  };
  
  private async streamMessageDirect(sessionId: string, message: string) {
    // 简化实现 - 实际会调用 LangChain
    const session = await this.sessionRepo.findById(sessionId);
    if (!session) throw new Error('Session not found');
    
    session.addUserMessage(message);
    
    // Mock 流式响应
    async function* mockStream() {
      yield { content: 'Response ' };
      yield { content: 'from ' };
      yield { content: 'agent' };
    }
    
    return mockStream();
  }
  
  private async createSessionDirect(workspacePath: string, modelConfig: any) {
    const { Session } = await import('./domain/session');
    const session = Session.create({ workspacePath, modelConfig });
    await this.sessionRepo.save(session);
    
    this.context.eventBus.publish({
      type: 'agent.session.created',
      payload: { sessionId: session.id }
    });
    
    return session.id;
  }
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm test tests/plugins/agent/`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/plugins/agent/ tests/plugins/agent/
git commit -m "feat(agent): implement Agent plugin

- SessionRepository 数据访问层
- Agent 插件主体,注册能力
- 快速路径支持流式消息
- 发布 session.created 事件"
```

---

*注: 由于篇幅限制,Phase 2 的完整实现包含更多任务(Memory插件、Task插件),但核心模式已展示。每个插件遵循相同结构:领域模型 → 仓储 → 服务 → 插件入口。*

---

## Week 4-5 快速概览

### Memory 插件 (Week 4)
- Task 3: Memory 领域模型 (Memory, Consolidation)
- Task 4: Consolidator 服务实现
- Task 5: Memory 插件入口,监听 agent.message.sent 事件

### Task 插件 (Week 5)  
- Task 6: Task 领域模型 (Task, Schedule, Execution)
- Task 7: Scheduler 服务实现 (cron 解析)
- Task 8: Task 插件入口,任务调度和执行

---

## 验收标准

- [ ] 所有插件测试通过
- [ ] 插件主文件 <200 lines
- [ ] 插件间通信测试通过
- [ ] Agent 插件能正确处理消息流
- [ ] Memory 插件能自动触发压缩
- [ ] Task 插件能按 cron 调度执行

---

## Phase 2 完成标志

✅ Agent/Memory/Task 三个插件全部实现  
✅ 插件间事件通信验证通过  
✅ 集成测试通过  
✅ 代码已提交  

**预计完成时间:** 3 周 (15 个工作日)

---

*Plan generated on 2026-06-04*
*Based on design document: docs/superpowers/specs/2026-06-04-architecture-modernization-design.md*

