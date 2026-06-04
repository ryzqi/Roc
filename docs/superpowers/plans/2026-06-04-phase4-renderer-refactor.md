# Phase 4: Renderer 重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重构前端为 Feature Module + View Model 架构,将 App.tsx 从 923 行降至 <150 行,所有组件 <100 行

**Architecture:** 采用 MVP (Model-View-Presenter) 模式,ViewModel 作为 Presenter 层连接 UI 和业务逻辑。Feature Module 按功能域组织,共享组件原子化。

**Tech Stack:** React 19.2.6, TypeScript 6.0.3, Motion 12.39.0 (动画), Lucide React 1.16.0 (图标)

**Timeline:** Week 8-10 (15 个工作日)

**Dependencies:** 必须完成 Phase 1-3 (所有插件已实现)

---

## 文件结构规划

```
src/renderer/
├── app/
│   ├── App.tsx                 # 主入口 (~150 lines, 从 923 降低)
│   ├── AppContext.tsx          # 全局上下文 (~80 lines)
│   └── routing.ts              # 路由配置 (~50 lines)
├── features/
│   ├── chat/                   # 聊天功能 (~500 lines)
│   │   ├── components/
│   │   │   ├── ChatComposer.tsx        (~80 lines)
│   │   │   ├── MessageList.tsx         (~100 lines)
│   │   │   ├── MessageRow.tsx          (~60 lines)
│   │   │   └── StreamingIndicator.tsx  (~40 lines)
│   │   ├── models/
│   │   │   ├── ChatViewModel.ts        (~120 lines)
│   │   │   └── MessageViewModel.ts     (~80 lines)
│   │   ├── hooks/
│   │   │   ├── useChatSession.ts       (~60 lines)
│   │   │   └── useMessageStream.ts     (~50 lines)
│   │   └── index.tsx                   (~60 lines)
│   ├── tasks/                  # 任务管理 (~400 lines)
│   ├── memory/                 # 记忆管理 (~300 lines)
│   ├── settings/               # 设置面板 (~350 lines)
│   └── workbench/              # 工作台 (~450 lines)
├── shared/
│   ├── ipc-bridge.ts           # IPC 通信 (~150 lines)
│   ├── observable.ts           # 响应式原语 (~80 lines)
│   ├── view-model-base.ts      # ViewModel 基类 (~100 lines)
│   ├── components/             # 原子组件库
│   │   ├── Button.tsx          (~50 lines)
│   │   ├── Input.tsx           (~60 lines)
│   │   ├── Dialog.tsx          (~80 lines)
│   │   ├── Spinner.tsx         (~30 lines)
│   │   └── ...
│   ├── hooks/
│   │   ├── useIPC.ts           (~40 lines)
│   │   ├── useAsyncState.ts    (~50 lines)
│   │   └── useObservable.ts    (~30 lines)
│   └── types/
│       └── index.ts            # 共享类型定义
└── main.tsx                    # 渲染进程入口 (~50 lines)
```

---

## Week 8: 基础设施

### Task 1: Observable 响应式系统

**Files:**
- Create: `src/renderer/shared/observable.ts`
- Test: `tests/renderer/shared/observable.test.ts`

- [ ] **Step 1: 编写 Observable 测试**

```typescript
// tests/renderer/shared/observable.test.ts
import { describe, it, expect, vi } from 'vitest';
import { Observable, ObservableArray } from '../../../src/renderer/shared/observable';

describe('Observable', () => {
  it('应该通知订阅者值的变化', () => {
    const obs = new Observable(0);
    const listener = vi.fn();
    
    obs.subscribe(listener);
    obs.set(1);
    
    expect(listener).toHaveBeenCalledWith(1);
  });
  
  it('应该支持取消订阅', () => {
    const obs = new Observable(0);
    const listener = vi.fn();
    
    const unsubscribe = obs.subscribe(listener);
    unsubscribe();
    obs.set(1);
    
    expect(listener).not.toHaveBeenCalled();
  });
  
  it('相同值不应触发通知', () => {
    const obs = new Observable(0);
    const listener = vi.fn();
    
    obs.subscribe(listener);
    obs.set(0);
    
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('ObservableArray', () => {
  it('应该响应式推送元素', () => {
    const arr = new ObservableArray<number>([]);
    const listener = vi.fn();
    
    arr.subscribe(listener);
    arr.push(1);
    
    expect(listener).toHaveBeenCalledWith([1]);
  });
  
  it('应该响应式替换数组', () => {
    const arr = new ObservableArray([1, 2]);
    const listener = vi.fn();
    
    arr.subscribe(listener);
    arr.replace([3, 4, 5]);
    
    expect(listener).toHaveBeenCalledWith([3, 4, 5]);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test tests/renderer/shared/observable.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 Observable**

```typescript
// src/renderer/shared/observable.ts

export class Observable<T> {
  private listeners = new Set<(value: T) => void>();
  
  constructor(private _value: T) {}
  
  get value(): T {
    return this._value;
  }
  
  set(newValue: T): void {
    if (this._value !== newValue) {
      this._value = newValue;
      this.notify();
    }
  }
  
  subscribe(listener: (value: T) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  
  private notify(): void {
    this.listeners.forEach(l => l(this._value));
  }
}

export class ObservableArray<T> extends Observable<T[]> {
  push(item: T): void {
    this.set([...this.value, item]);
  }
  
  replace(items: T[]): void {
    this.set(items);
  }
  
  clear(): void {
    this.set([]);
  }
  
  filter(predicate: (item: T) => boolean): T[] {
    return this.value.filter(predicate);
  }
  
  find(predicate: (item: T) => boolean): T | undefined {
    return this.value.find(predicate);
  }
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm test tests/renderer/shared/observable.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/renderer/shared/observable.ts tests/renderer/shared/observable.test.ts
git commit -m "feat(renderer): implement Observable system

- 响应式原语 Observable<T>
- 响应式数组 ObservableArray<T>
- 订阅/取消订阅机制
- 值变化时自动通知"
```

---

### Task 2: IPC Bridge 实现

**Files:**
- Create: `src/renderer/shared/ipc-bridge.ts`
- Test: `tests/renderer/shared/ipc-bridge.test.ts`

- [ ] **Step 1: 实现 IPC Bridge**

```typescript
// src/renderer/shared/ipc-bridge.ts

/**
 * IPC Bridge - 类型安全的 IPC 通信层
 */
export class IPCBridge {
  /**
   * 调用能力(单次请求-响应)
   */
  async invoke<TInput, TOutput>(
    capability: string,
    input: TInput
  ): Promise<TOutput> {
    return await window.api.invoke(capability, input);
  }
  
  /**
   * 流式调用(持续接收数据)
   */
  async *stream<TInput, TOutput>(
    capability: string,
    input: TInput
  ): AsyncIterable<TOutput> {
    const streamId = this.generateId();
    
    // 开始流
    await window.api.invoke(`${capability}.start`, {
      streamId,
      ...input
    });
    
    // 监听数据
    const queue = new AsyncQueue<TOutput>();
    
    const unsubscribeData = window.api.on(`stream.${streamId}.data`, (data) => {
      queue.push(data);
    });
    
    window.api.on(`stream.${streamId}.end`, () => {
      queue.close();
      unsubscribeData();
    });
    
    window.api.on(`stream.${streamId}.error`, (error) => {
      queue.error(error);
      unsubscribeData();
    });
    
    // 返回异步迭代器
    yield* queue;
  }
  
  /**
   * 订阅事件
   */
  subscribe<T>(
    event: string,
    handler: (data: T) => void
  ): () => void {
    return window.api.on(event, handler);
  }
  
  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(7)}`;
  }
}

/**
 * 异步队列 - 用于流式数据
 */
class AsyncQueue<T> {
  private queue: T[] = [];
  private resolvers: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;
  private errorValue: Error | null = null;
  
  push(item: T): void {
    if (this.closed) return;
    
    if (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!;
      resolve({ value: item, done: false });
    } else {
      this.queue.push(item);
    }
  }
  
  close(): void {
    this.closed = true;
    this.resolvers.forEach(resolve => 
      resolve({ value: undefined, done: true } as any)
    );
    this.resolvers = [];
  }
  
  error(err: Error): void {
    this.errorValue = err;
    this.close();
  }
  
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.errorValue) {
        throw this.errorValue;
      }
      
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
      } else if (this.closed) {
        return;
      } else {
        const result = await new Promise<IteratorResult<T>>((resolve) => {
          this.resolvers.push(resolve);
        });
        
        if (result.done) return;
        yield result.value;
      }
    }
  }
}
```

- [ ] **Step 2: 提交**

```bash
git add src/renderer/shared/ipc-bridge.ts
git commit -m "feat(renderer): implement IPC Bridge

- 类型安全的 invoke/stream/subscribe
- 异步队列支持流式数据
- 自动生成唯一 stream ID"
```

---

### Task 3: ViewModel 基类

**Files:**
- Create: `src/renderer/shared/view-model-base.ts`
- Create: `src/renderer/shared/hooks/useObservable.ts`

- [ ] **Step 1: 实现 ViewModel 基类**

```typescript
// src/renderer/shared/view-model-base.ts
import { Observable } from './observable';

export interface ViewModelOptions {
  autoDispose?: boolean;
}

export abstract class ViewModelBase {
  protected subscriptions: Array<() => void> = [];
  
  constructor(protected options: ViewModelOptions = {}) {}
  
  /**
   * 注册订阅,自动清理
   */
  protected addSubscription(unsubscribe: () => void): void {
    this.subscriptions.push(unsubscribe);
  }
  
  /**
   * 创建响应式状态
   */
  protected createObservable<T>(initialValue: T): Observable<T> {
    return new Observable(initialValue);
  }
  
  /**
   * 清理资源
   */
  dispose(): void {
    this.subscriptions.forEach(unsub => unsub());
    this.subscriptions = [];
  }
}
```

- [ ] **Step 2: 实现 useObservable Hook**

```typescript
// src/renderer/shared/hooks/useObservable.ts
import { useState, useEffect } from 'react';
import type { Observable } from '../observable';

/**
 * 将 Observable 桥接到 React 状态
 */
export function useObservable<T>(observable: Observable<T>): T {
  const [value, setValue] = useState(observable.value);
  
  useEffect(() => {
    return observable.subscribe(setValue);
  }, [observable]);
  
  return value;
}
```

- [ ] **Step 3: 提交**

```bash
git add src/renderer/shared/view-model-base.ts src/renderer/shared/hooks/useObservable.ts
git commit -m "feat(renderer): implement ViewModel base class

- ViewModelBase 基类,统一生命周期管理
- useObservable Hook 桥接 Observable 到 React
- 自动订阅清理"
```

---

## Week 9-10: Feature Modules 重构

### Task 4: Chat Feature 重构 (最复杂,优先处理)

**Files:**
- Create: `src/renderer/features/chat/models/ChatViewModel.ts`
- Create: `src/renderer/features/chat/models/MessageViewModel.ts`
- Create: `src/renderer/features/chat/components/ChatComposer.tsx`
- Create: `src/renderer/features/chat/components/MessageList.tsx`
- Refactor: From `src/renderer/features/chat-panel/Chat.tsx` (923 lines)

- [ ] **Step 1: 实现 ChatViewModel**

```typescript
// src/renderer/features/chat/models/ChatViewModel.ts
import { ViewModelBase } from '../../../shared/view-model-base';
import { ObservableArray, Observable } from '../../../shared/observable';
import { IPCBridge } from '../../../shared/ipc-bridge';
import { MessageViewModel } from './MessageViewModel';

export class ChatViewModel extends ViewModelBase {
  private sessionId: string | null = null;
  readonly messages = new ObservableArray<MessageViewModel>([]);
  readonly isStreaming = new Observable<boolean>(false);
  readonly error = new Observable<Error | null>(null);
  
  constructor(private readonly ipc: IPCBridge) {
    super();
  }
  
  async initialize(workspacePath: string): Promise<void> {
    try {
      // 调用 Agent 插件创建会话
      this.sessionId = await this.ipc.invoke('agent.session.create', {
        workspacePath,
        modelConfig: { model: 'gpt-4' }
      });
      
      // 加载历史消息
      const history = await this.ipc.invoke('agent.session.getHistory', {
        sessionId: this.sessionId
      });
      
      this.messages.replace(
        history.map((msg: any) => new MessageViewModel(msg))
      );
    } catch (err) {
      this.error.set(err as Error);
    }
  }
  
  async sendMessage(content: string): Promise<void> {
    if (!this.sessionId) throw new Error('Session not initialized');
    
    // 添加用户消息
    const userMsg = new MessageViewModel({
      role: 'user',
      content,
      timestamp: new Date()
    });
    this.messages.push(userMsg);
    
    // 创建助手消息占位符
    const assistantMsg = new MessageViewModel({
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      streaming: true
    });
    this.messages.push(assistantMsg);
    
    this.isStreaming.set(true);
    
    try {
      // 流式调用
      const stream = this.ipc.stream('agent.chat.stream', {
        sessionId: this.sessionId,
        message: content
      });
      
      for await (const chunk of stream) {
        assistantMsg.appendChunk(chunk.content);
      }
      
      assistantMsg.finalize();
    } catch (err) {
      this.error.set(err as Error);
      assistantMsg.setError(err as Error);
    } finally {
      this.isStreaming.set(false);
    }
  }
  
  // Getters for UI
  get messagesView(): readonly MessageViewModel[] {
    return this.messages.value;
  }
  
  get isStreamingView(): boolean {
    return this.isStreaming.value;
  }
  
  get errorView(): Error | null {
    return this.error.value;
  }
}
```

- [ ] **Step 2: 实现 MessageViewModel**

```typescript
// src/renderer/features/chat/models/MessageViewModel.ts
import { Observable } from '../../../shared/observable';

export interface MessageData {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  streaming?: boolean;
}

export class MessageViewModel {
  private content = new Observable<string>('');
  private streaming = new Observable<boolean>(false);
  private error = new Observable<Error | null>(null);
  
  constructor(private readonly data: MessageData) {
    this.content.set(data.content);
    this.streaming.set(data.streaming || false);
  }
  
  appendChunk(chunk: string): void {
    this.content.set(this.content.value + chunk);
  }
  
  finalize(): void {
    this.streaming.set(false);
  }
  
  setError(err: Error): void {
    this.error.set(err);
    this.streaming.set(false);
  }
  
  get contentView(): string {
    return this.content.value;
  }
  
  get isStreamingView(): boolean {
    return this.streaming.value;
  }
  
  get hasError(): boolean {
    return this.error.value !== null;
  }
  
  get role(): string {
    return this.data.role;
  }
}
```

- [ ] **Step 3: 实现 ChatComposer 组件**

```typescript
// src/renderer/features/chat/components/ChatComposer.tsx
import { useState } from 'react';
import { useObservable } from '../../../shared/hooks/useObservable';
import type { ChatViewModel } from '../models/ChatViewModel';

export function ChatComposer({ viewModel }: { viewModel: ChatViewModel }) {
  const [input, setInput] = useState('');
  const isStreaming = useObservable(viewModel.isStreaming);
  
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isStreaming) return;
    
    await viewModel.sendMessage(input);
    setInput('');
  };
  
  return (
    <form onSubmit={handleSubmit} className="chat-composer">
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="输入消息..."
        disabled={isStreaming}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit(e);
          }
        }}
      />
      <button type="submit" disabled={isStreaming || !input.trim()}>
        {isStreaming ? '发送中...' : '发送'}
      </button>
    </form>
  );
}
```

- [ ] **Step 4: 提交**

```bash
git add src/renderer/features/chat/
git commit -m "feat(renderer): refactor Chat feature to MVVM

- ChatViewModel: 分离业务逻辑
- MessageViewModel: 消息展示逻辑
- ChatComposer: 纯UI组件 <80 lines
- 从923行重构到~500行总计"
```

---

*注: 其他 Features (Tasks/Memory/Settings/Workbench) 遵循相同模式,每个都是:ViewModel → Components → Hooks → Index。验收标准:所有组件<100 lines, ViewModel<150 lines。*

---

## 验收标准

- [ ] App.tsx 从 923 行降至 <150 行
- [ ] 所有 Feature Module 主文件 <200 lines
- [ ] UI 组件文件 <100 lines
- [ ] ViewModel 文件 <150 lines
- [ ] 所有功能正常工作,无回归
- [ ] 性能无退化

---

## Phase 4 完成标志

✅ 所有 Feature Modules 重构完成  
✅ MVVM 架构实施  
✅ 文件大小符合标准  
✅ 所有测试通过  
✅ 代码已提交  

**预计完成时间:** 3 周 (15 个工作日)

---

*Plan generated on 2026-06-04*
