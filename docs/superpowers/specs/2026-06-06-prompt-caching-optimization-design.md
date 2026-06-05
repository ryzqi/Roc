# Roc 提示前缀缓存优化设计

## 目标与范围

### 核心目标

为 Roc 实现**供应商无关的**提示前缀缓存优化架构，在 4-6 周内实现：

1. **成本节省**：输入 token 成本降低 70-90%（所有主流供应商）
2. **延迟改善**：首 token 时间降低 5-10x
3. **架构优化**：系统提示组件化，支持独立缓存和动态组合
4. **可观测性**：完整的缓存指标收集、UI 展示和诊断面板
5. **供应商无关**：统一的缓存抽象层，新供应商零代码接入

### 范围界定

**本次实施包含**：

**A. 系统提示组件化重构**
- 将 `buildSystemPrompt()` 拆解为独立可缓存块（Block）
- 每个块有明确的稳定性级别（static / workspace / session / request）
- Block 可独立序列化、哈希、缓存标记

**B. 快照稳定性彻底优化**
- 会话级快照冻结（`DeepAgentRuntimeService` 级缓存）
- `usage` 字段从绝对值改为百分比（减少微变影响）
- 可选：快照内容哈希指纹机制（按需加载，降级方案）

**C. 工具定义缓存机制**
- 工具描述提取为独立系统提示块（而非 LangChain `tools[]` 参数）
- 支持工具集变化时的增量缓存失效
- 为未来 Anthropic 原生工具缓存预留接口

**D. 供应商无关的缓存抽象层**
- 统一的 `CacheStrategy` 接口（detectBreakpoints / applyCacheControl / estimateSavings）
- 内置 Anthropic / OpenAI 两种实现
- Middleware 根据 provider 动态选择策略

**E. 可观测性与监控**
- 缓存指标收集（命中率、写入次数、节省 token）
- UI 诊断面板展示（per-provider、per-session）
- 日志记录和性能追踪

**F. 完整测试覆盖**
- 单元测试（每个 Block、策略实现）
- 集成测试（端到端缓存命中验证）
- 契约测试（与 deepagents / LangChain 的集成）
- 回归测试（确保 agent 行为不变）

**明确不包含**：
- Gemini 支持（已移除）
- 非缓存相关的性能优化
- 系统提示内容的语义调整

---

## 背景与问题陈述

### 当前状态分析

**系统提示组装流程**（`src/main/services/deep-agent/prompt.ts:24-41`）：
```typescript
export function buildSystemPrompt(input: {
  enabledCapabilities: ChatStartRunRequest['enabledCapabilities'];
  workspacePath: string | null;
  frozenSnapshot: FrozenSnapshot;
  workflowHint: WorkflowHint;
}): string {
  const sections = [
    ROC_STATIC_SYSTEM_PROMPT,                    // 静态基础
    ...createWorkspaceBoundary(workspacePath),   // 工作区路径
    `Capabilities: ${createCapabilitySummary(...)}` // 能力摘要
  ];
  sections.push(...createWorkflowOverview(...));  // 工作流提示
  const snapshotBlock = renderFrozenSnapshot(...); // 冻结快照
  if (snapshotBlock.length > 0) {
    sections.push('', snapshotBlock);
  }
  return sections.join('\n');
}
```

### 核心问题

1. **系统提示完全未启用缓存**：
   - Anthropic 的 `cache_control` 标记未使用
   - OpenAI 自动缓存依赖前缀稳定性，但未验证

2. **快照动态内容破坏缓存**：
   - `usage="234/500"` 中的绝对字符数每次文件读取都可能微变
   - 用户编辑内存文件后，整个提示哈希改变 → 缓存完全失效

3. **缺乏可观测性**：
   - 虽然 `stream-consumers.ts` 已收集 `cacheReadTokens` / `cacheCreationTokens`
   - 但未在 UI 展示，无法评估优化效果

4. **工具定义未优化缓存**：
   - 工具通过 LangChain `tools[]` 参数传递
   - 无法独立标记缓存断点

### 供应商缓存机制对比

| 维度 | Anthropic | OpenAI |
|------|----------|--------|
| **机制** | 显式 `cache_control: {type: 'ephemeral'}` | 自动前缀缓存（无需标记） |
| **多断点** | ✅ 支持任意位置标记 | ❌ 仅缓存前缀 |
| **成本节省** | 90%（缓存命中 token） | 90%（缓存命中 token） |
| **TTL** | 5 分钟 / 1 小时（extended） | 未公开（短期） |
| **最小粒度** | 1024 token | 1024 token |
| **集成难度** | 中（需添加标记） | 低（自动） |

---

## 整体架构

### 架构图

```
┌─────────────────────────────────────────────────────────────┐
│                    DeepAgentRuntimeService                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │         SystemPromptBuilder (新)                      │   │
│  │  ┌────────────┐ ┌──────────────┐ ┌───────────────┐  │   │
│  │  │ StaticBlock│ │WorkspaceBlock│ │ SnapshotBlock │  │   │
│  │  │  (Layer 1) │ │  (Layer 2)   │ │   (Layer 3)   │  │   │
│  │  └────────────┘ └──────────────┘ └───────────────┘  │   │
│  │  ┌────────────┐ ┌──────────────┐                     │   │
│  │  │ ToolsBlock │ │CapabilityBlk │                     │   │
│  │  │ (Layer 4)  │ │  (Layer 5)   │                     │   │
│  │  └────────────┘ └──────────────┘                     │   │
│  └──────────────────────────────────────────────────────┘   │
│                           ↓                                  │
│  ┌──────────────────────────────────────────────────────┐   │
│  │       PromptCachingMiddleware (新)                    │   │
│  │  ┌─────────────────────────────────────────────────┐ │   │
│  │  │     CacheStrategyFactory                         │ │   │
│  │  │  ┌─────────────────┐  ┌────────────────────┐   │ │   │
│  │  │  │AnthropicStrategy│  │  OpenAIStrategy    │   │ │   │
│  │  │  │ (多断点标记)     │  │ (前缀优化验证)   │   │ │   │
│  │  │  └─────────────────┘  └────────────────────┘   │ │   │
│  │  └─────────────────────────────────────────────────┘ │   │
│  └──────────────────────────────────────────────────────┘   │
│                           ↓                                  │
│  ┌──────────────────────────────────────────────────────┐   │
│  │       UsageMetricsCollector (增强)                    │   │
│  │   - cacheReadTokens / cacheCreationTokens            │   │
│  │   - 会话级聚合统计                                    │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                           ↓
              ┌────────────────────────┐
              │  DiagnosticsView (UI)  │
              │  - 缓存命中率仪表盘     │
              │  - Per-provider 节省   │
              └────────────────────────┘
```

### 核心组件

**1. SystemPromptBuilder**
- **职责**：将现有的 `buildSystemPrompt()` 拆解为 Block 数组
- **输入**：`enabledCapabilities`, `workspacePath`, `frozenSnapshot`, `workflowHint`, `tools`
- **输出**：`PromptBlock[]`，每个 Block 包含 `{ type, content, stability, hash }`
- **位置**：新文件 `src/main/services/deep-agent/prompt-builder.ts`

**2. PromptCachingMiddleware**
- **职责**：在 `wrapModelCall` hook 为消息添加 `cache_control`
- **策略选择**：根据 `providerType` 动态选择 Anthropic / OpenAI 策略
- **位置**：新文件 `src/main/services/forge-guardrails/middleware/prompt-caching.ts`
- **集成点**：middleware 栈最后（在 `ForgeCleanupMiddleware` 之后）

**3. CacheStrategy 接口**
```typescript
interface CacheStrategy {
  detectBreakpoints(blocks: PromptBlock[]): number[];  
  applyCacheControl(message: SystemMessage, breakpoints: number[]): SystemMessage;
  estimateSavings(blocks: PromptBlock[], usage: UsageMetadata): CacheSavings;
}
```

**4. SnapshotCache（会话级）**
- **职责**：在 `DeepAgentRuntimeService` 缓存 `FrozenSnapshot`
- **Key**：`workspaceHash`（由 `buildWorkspaceHash()` 生成）
- **失效**：用户切换工作区 / 手动调用 `invalidate()`
- **位置**：`DeepAgentRuntimeService` 私有成员

**5. UsageMetricsCollector（增强）**
- **新增字段**：`sessionCacheHitRate`, `sessionTotalSaved`, `perProviderMetrics`
- **聚合逻辑**：累积同一会话内的所有缓存指标
- **位置**：现有 `src/main/services/deep-agent/stream-consumers.ts` 扩展

**6. DiagnosticsView 缓存面板（UI）**
- **展示内容**：缓存命中率、节省 token 数、per-provider 统计
- **位置**：`src/renderer/views/diagnostics/DiagnosticsView.tsx` 新增 tab

---

## 详细设计

### Block 稳定性分层

```typescript
enum BlockStability {
  STATIC = 'static',           // 跨所有会话不变
  WORKSPACE = 'workspace',     // 工作区级稳定
  SESSION = 'session',         // 会话级稳定
  CAPABILITY = 'capability',   // 能力集变化时失效
  REQUEST = 'request'          // 每请求重建
}

interface PromptBlock {
  type: 'static' | 'workspace' | 'tools' | 'snapshot' | 'capability';
  content: string;
  stability: BlockStability;
  hash: string;  // 内容哈希（SHA-256 前 16 字符）
  metadata?: {
    tokenEstimate?: number;
    lastModified?: string;
  };
}
```

### SystemPromptBuilder 实现

**新文件**：`src/main/services/deep-agent/prompt-builder.ts`

```typescript
export class SystemPromptBuilder {
  constructor(
    private readonly paths: RocPaths,
    private readonly workspaceService: WorkspaceService
  ) {}

  build(input: {
    enabledCapabilities: ChatStartRunRequest['enabledCapabilities'];
    workspacePath: string | null;
    frozenSnapshot: FrozenSnapshot;
    workflowHint: WorkflowHint;
    tools: ClientTool[];
  }): PromptBlock[] {
    const blocks: PromptBlock[] = [];
    
    blocks.push(this.buildStaticBlock());
    blocks.push(this.buildWorkspaceBlock(input.workspacePath));
    blocks.push(this.buildToolsBlock(input.tools));
    blocks.push(this.buildSnapshotBlock(input.frozenSnapshot));
    blocks.push(this.buildCapabilityBlock(input.enabledCapabilities, input.workflowHint));
    
    return blocks;
  }

  private buildStaticBlock(): PromptBlock {
    const content = ROC_STATIC_SYSTEM_PROMPT;
    return {
      type: 'static',
      content,
      stability: BlockStability.STATIC,
      hash: this.computeHash(content)
    };
  }

  private buildWorkspaceBlock(path: string | null): PromptBlock {
    const content = createWorkspaceBoundary(path).join('\n');
    return {
      type: 'workspace',
      content,
      stability: BlockStability.WORKSPACE,
      hash: this.computeHash(content)
    };
  }

  private buildToolsBlock(tools: ClientTool[]): PromptBlock {
    const descriptions = tools
      .map(tool => `- ${tool.name}: ${tool.description}`)
      .join('\n');
    const content = `Available Tools:\n${descriptions}`;
    return {
      type: 'tools',
      content,
      stability: BlockStability.CAPABILITY,
      hash: this.computeHash(content)
    };
  }

  private buildSnapshotBlock(snapshot: FrozenSnapshot): PromptBlock {
    const content = renderFrozenSnapshotWithPercentage(snapshot);
    return {
      type: 'snapshot',
      content,
      stability: BlockStability.SESSION,
      hash: this.computeHash(content)
    };
  }

  private buildCapabilityBlock(capabilities: EnabledCapabilities, hint: WorkflowHint): PromptBlock {
    const sections = [
      `Capabilities: ${createCapabilitySummary(capabilities)}`,
      ...createWorkflowOverview(hint)
    ];
    const content = sections.join('\n');
    return {
      type: 'capability',
      content,
      stability: BlockStability.CAPABILITY,
      hash: this.computeHash(content)
    };
  }

  private computeHash(content: string): string {
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  }
}
```

**配套修改**：`src/main/services/memory/snapshot.ts`

```typescript
// 新增函数：使用百分比渲染 usage
export function renderFrozenSnapshotWithPercentage(snapshot: FrozenSnapshot): string {
  const parts: string[] = ['<FROZEN_SNAPSHOT>'];
  
  for (const part of snapshot.parts) {
    const usagePercent = Math.floor((part.charCount / part.charLimit) * 100);
    parts.push(`<${part.name} usage="${usagePercent}%" source="${part.source}">`);
    parts.push(part.content);
    parts.push(`</${part.name}>`);
  }
  
  parts.push('</FROZEN_SNAPSHOT>');
  return parts.join('\n');
}
```

### SnapshotCache 实现

**位置**：`src/main/services/deep-agent-runtime-service.ts` 扩展

```typescript
export class DeepAgentRuntimeService {
  // 新增私有成员
  private snapshotCache = new Map<string, {
    snapshot: FrozenSnapshot;
    cachedAt: number;
  }>();

  // 新增方法
  private getOrBuildSnapshot(workspaceHash: string): FrozenSnapshot {
    const cached = this.snapshotCache.get(workspaceHash);
    if (cached && !this.isSnapshotStale(cached)) {
      return cached.snapshot;
    }
    
    const snapshot = this.memoryService.buildSnapshotForCurrentWorkspace();
    this.snapshotCache.set(workspaceHash, {
      snapshot,
      cachedAt: Date.now()
    });
    return snapshot;
  }

  private isSnapshotStale(entry: { cachedAt: number }): boolean {
    // 可选：5 分钟后视为过期（与 Anthropic TTL 对齐）
    const MAX_AGE_MS = 5 * 60 * 1000;
    return Date.now() - entry.cachedAt > MAX_AGE_MS;
  }

  // 公开方法：手动失效
  invalidateSnapshotCache(workspaceHash: string): void {
    this.snapshotCache.delete(workspaceHash);
  }
}
```

### PromptCachingMiddleware 实现

**新文件**：`src/main/services/forge-guardrails/middleware/prompt-caching.ts`

```typescript
import { SystemMessage, type BaseMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import type { ProviderType } from '../../../shared/types';
import type { PromptBlock } from '../../deep-agent/prompt-builder';

export type PromptCachingStrategy = 'aggressive' | 'balanced' | 'conservative' | 'disabled';

export interface PromptCachingOptions {
  enabled?: boolean;
  strategy?: PromptCachingStrategy;
  providerType: ProviderType;
}

export function createPromptCachingMiddleware(options: PromptCachingOptions) {
  const { enabled = true, strategy = 'balanced', providerType } = options;

  if (!enabled) {
    return createMiddleware({
      name: 'PromptCaching',
      wrapModelCall: async (request, handler) => handler(request)
    });
  }

  const cacheStrategy = CacheStrategyFactory.create(providerType);

  return createMiddleware({
    name: 'PromptCaching',
    wrapModelCall: async (request, handler) => {
      try {
        const messages = request.messages as BaseMessage[];
        const systemMsg = messages.find(m => SystemMessage.isInstance(m));
        
        if (!systemMsg || !isBlockBasedContent(systemMsg.content)) {
          // 降级：非 Block 结构，跳过缓存
          return handler(request);
        }

        const blocks = extractBlocks(systemMsg.content);
        const breakpoints = cacheStrategy.detectBreakpoints(blocks, strategy);
        const enhanced = cacheStrategy.applyCacheControl(systemMsg, breakpoints);
        
        messages[messages.indexOf(systemMsg)] = enhanced;
        return handler({ ...request, messages });
      } catch (error) {
        // 降级：缓存注入失败，继续原始请求
        this.logService?.warn('Cache control injection failed', { error });
        return handler(request);
      }
    }
  });
}

function isBlockBasedContent(content: unknown): boolean {
  return Array.isArray(content) && content.every(block => 
    typeof block === 'object' && block !== null && 'type' in block
  );
}

function extractBlocks(content: any[]): PromptBlock[] {
  // 从 SystemMessage.content 提取 blocks（需协议约定）
  return content.map(block => ({
    type: block.blockType || 'unknown',
    content: block.text,
    stability: block.stability,
    hash: block.hash
  }));
}
```

### CacheStrategy 接口与实现

```typescript
interface CacheStrategy {
  detectBreakpoints(blocks: PromptBlock[], strategy: PromptCachingStrategy): number[];
  applyCacheControl(message: SystemMessage, breakpoints: number[]): SystemMessage;
  estimateSavings(blocks: PromptBlock[], usage: UsageMetadata): CacheSavings;
}

class AnthropicStrategy implements CacheStrategy {
  detectBreakpoints(blocks: PromptBlock[], strategy: PromptCachingStrategy): number[] {
    switch (strategy) {
      case 'aggressive':
        // 所有块都缓存
        return blocks.map((_, i) => i);
      
      case 'balanced':
        // 缓存 STATIC / WORKSPACE / CAPABILITY / SESSION，跳过 REQUEST
        return blocks
          .map((block, i) => ({ block, i }))
          .filter(({ block }) => block.stability !== BlockStability.REQUEST)
          .map(({ i }) => i);
      
      case 'conservative':
        // 仅缓存 STATIC
        return blocks
          .map((block, i) => ({ block, i }))
          .filter(({ block }) => block.stability === BlockStability.STATIC)
          .map(({ i }) => i);
      
      default:
        return [];
    }
  }

  applyCacheControl(message: SystemMessage, breakpoints: number[]): SystemMessage {
    const content = message.content as any[];
    const enhanced = content.map((block, index) => ({
      ...block,
      ...(breakpoints.includes(index) && {
        cache_control: { type: 'ephemeral' as const }
      })
    }));
    
    return new SystemMessage({ content: enhanced });
  }

  estimateSavings(blocks: PromptBlock[], usage: UsageMetadata): CacheSavings {
    const cacheReadTokens = usage.input_token_details?.cache_read || 0;
    const totalPromptTokens = usage.input_tokens || 0;
    
    if (totalPromptTokens === 0) return { percentSaved: 0, tokensSaved: 0 };
    
    // Anthropic: 缓存命中 token 降至 10%
    const tokensSaved = Math.floor(cacheReadTokens * 0.9);
    const percentSaved = (tokensSaved / totalPromptTokens) * 100;
    
    return { percentSaved, tokensSaved };
  }
}

class OpenAIStrategy implements CacheStrategy {
  detectBreakpoints(blocks: PromptBlock[], strategy: PromptCachingStrategy): number[] {
    // OpenAI 自动缓存前缀，无需标记
    return [];
  }

  applyCacheControl(message: SystemMessage, breakpoints: number[]): SystemMessage {
    // OpenAI 不注入 cache_control
    return message;
  }

  estimateSavings(blocks: PromptBlock[], usage: UsageMetadata): CacheSavings {
    // OpenAI usage 中没有显式 cache 字段，估算基于前缀长度
    const prefixTokens = this.estimatePrefixTokens(blocks);
    const totalPromptTokens = usage.input_tokens || 0;
    
    // 假设前缀命中后节省 90%
    const tokensSaved = Math.floor(prefixTokens * 0.9);
    const percentSaved = (tokensSaved / totalPromptTokens) * 100;
    
    return { percentSaved, tokensSaved };
  }

  private estimatePrefixTokens(blocks: PromptBlock[]): number {
    // 估算稳定前缀的 token 数（粗略：4 字符 ≈ 1 token）
    return blocks
      .filter(b => b.stability !== BlockStability.REQUEST)
      .reduce((sum, b) => sum + Math.ceil(b.content.length / 4), 0);
  }
}

class CacheStrategyFactory {
  static create(providerType: ProviderType): CacheStrategy {
    switch (providerType) {
      case 'anthropic_compatible':
        return new AnthropicStrategy();
      case 'openai_compatible':
      case 'openrouter':
      case 'nvidia':
      case 'llama_cpp':
        return new OpenAIStrategy();
      default:
        return new OpenAIStrategy();  // 默认
    }
  }
}
```

### 集成到 Agent Builder

**修改文件**：`src/main/services/deep-agent/agent-builder.ts`

```typescript
const guardrails = [
  // ... 现有 1-11 个 middleware
  createForgeCleanupMiddleware(),                  // 11
  createPromptCachingMiddleware({                  // 12 ← 新增
    enabled: true,
    strategy: 'balanced',
    providerType: input.providerType
  })
];
```

### 数据流：典型请求

```
用户发起 chat 请求
    ↓
DeepAgentRuntimeService.executeRun()
    ↓
检查 SnapshotCache（按 workspaceHash）
    ├─ 命中 → 复用
    └─ 未命中 → buildSnapshotForCurrentWorkspace() → 缓存
    ↓
SystemPromptBuilder.build()
    ├─ buildStaticBlock()        → Layer 1 (STATIC)
    ├─ buildWorkspaceBlock(path) → Layer 2 (WORKSPACE)
    ├─ buildToolsBlock(tools)    → Layer 3 (CAPABILITY)
    ├─ buildSnapshotBlock(cache) → Layer 4 (SESSION)
    └─ buildCapabilityBlock()    → Layer 5 (CAPABILITY)
    ↓
构造 SystemMessage({ content: blocksAsContentArray })
    ↓
createDeepAgentSession() → buildDeepAgent()
    ↓
Middleware 栈执行...
    ↓
PromptCachingMiddleware.wrapModelCall()
    ├─ 识别 providerType
    ├─ 选择 CacheStrategy (Anthropic / OpenAI)
    ├─ detectBreakpoints(blocks) → [0, 1, 2, 3]
    ├─ applyCacheControl() → 为 blocks 添加 cache_control
    └─ 传递给 handler()
    ↓
Provider API 调用（带缓存标记）
    ↓
响应流回 UsageMetricsCollector
    ├─ 提取 cache_read / cache_creation
    ├─ 更新会话级聚合指标
    └─ 记录到 metrics service
    ↓
UI DiagnosticsView 实时展示
```

---

## 错误处理与边界情况

### 错误处理策略

**1. 快照缓存失效**
```typescript
try {
  const snapshot = snapshotCache.get(workspaceHash);
  if (!snapshot || snapshot.isStale()) {
    const fresh = buildSnapshotForCurrentWorkspace();
    snapshotCache.set(workspaceHash, fresh);
  }
} catch (error) {
  logService.warn('Snapshot rebuild failed, using empty', { error });
  return buildEmptySnapshot();
}
```

**2. 缓存标记注入失败**
```typescript
try {
  const enhanced = applyCacheControl(message, breakpoints);
  return handler({ ...request, messages: [enhanced, ...rest] });
} catch (error) {
  logService.warn('Cache control injection failed, proceeding without cache', { error });
  return handler(request);  // 降级：原始请求
}
```

**3. Provider 不支持缓存**
```typescript
if (providerType === 'openai_compatible' && !isKnownOpenAIEndpoint(baseUrl)) {
  logService.info('OpenAI-compatible endpoint may not support caching', { baseUrl });
  // 继续，但不假设缓存生效
}
```

### 边界情况

| 场景 | 处理策略 |
|------|---------|
| 工作区快速切换 A→B→A | SnapshotCache 按 hash 存储，切回命中缓存 |
| 对话中途编辑内存文件 | 当前会话仍用旧快照，下个会话自动重建 |
| 极长对话（100+ 轮） | Anthropic: 最近 5 条历史也标记缓存；压缩后首次失效，后续稳定可再命中 |
| 工具集动态变化 | ToolsBlock hash 改变 → Layer 3+ 失效，Layer 1-2 仍可命中 |
| Provider 缓存 TTL 过期 | 客户端无感知，自动重建（cache_creation 计费），UI 展示"缓存写入"事件 |

---

## 测试策略

### 单元测试（~30 个用例）

**SystemPromptBuilder**
- 应构建 5 层 Block 结构
- 应为每个 Block 生成稳定的哈希
- 工作区路径变化应改变 WorkspaceBlock 哈希
- SnapshotBlock 应使用百分比 usage

**SnapshotCache**
- 应按 workspaceHash 缓存快照
- invalidate 后应返回 null
- 应支持 isStale 检查

**CacheStrategy**
- AnthropicStrategy: 应为 STATIC/WORKSPACE/SESSION 标记断点
- AnthropicStrategy: applyCacheControl 应正确添加 cache_control
- AnthropicStrategy: 应正确估算节省（命中时 81% = 90% * 90%）
- OpenAIStrategy: 不应注入 cache_control
- OpenAIStrategy: 应计算前缀 token 长度

### 集成测试（~10 个用例）

**Middleware 集成**
- 应在 middleware 栈最后位置执行
- Anthropic provider 应注入 cache_control
- OpenAI provider 不应注入 cache_control

**快照缓存集成**
- 同一会话的多次请求应复用快照
- 切换工作区应触发快照重建

### 契约测试（~5 个用例）

**与 deepagents 的契约**
- SystemMessage.content 数组应被框架正确处理
- Anthropic SDK 应保留 cache_control 字段
- 验证 usage_metadata.input_token_details.cache_read > 0

### E2E 测试（~3 个用例）

**端到端缓存验证**
- Anthropic：连续两次相同请求应命中缓存
- 编辑内存文件后缓存应失效
- UI 应展示缓存指标

### 回归测试

- 复用现有测试套件：`deep-agent-runtime-service.test.ts`
- `forge-guardrails/**/*.test.ts`
- `memory-service.test.ts`
- `microkernel-regression.test.ts`

### Acceptance Criteria

- **AC1**：SystemPromptBuilder 构建的 Blocks 有稳定的哈希，相同输入产生相同哈希
- **AC2**：Anthropic provider 的请求包含正确的 `cache_control` 标记（前 3-4 层）
- **AC3**：OpenAI provider 不注入 `cache_control`（依赖自动缓存）
- **AC4**：SnapshotCache 在同一会话内复用快照，切换工作区时重建
- **AC5**：`usage` 字段使用百分比渲染，减少微变影响
- **AC6**：连续两次相同请求，第二次的 `cacheReadTokens > 0`（Anthropic）
- **AC7**：UI DiagnosticsView 展示缓存命中率和节省指标
- **AC8**：所有现有测试套件保持绿色（零回归）

---

## 实施计划

### 阶段划分（4-6 周）

**Phase 1：核心基础设施（1.5 周）**
- Week 1.0-1.5：
  - 新建 `SystemPromptBuilder` 类和 `PromptBlock` 类型
  - 实现 5 层 Block 构建逻辑
  - 实现 Block 哈希计算
  - 单元测试覆盖

**Phase 2：快照稳定性优化（1 周）**
- Week 2.0-2.5：
  - 实现 `SnapshotCache`（`DeepAgentRuntimeService` 集成）
  - 修改 `renderFrozenSnapshot()` 使用百分比 `usage`
  - 可选：文件监听 + 自动失效
  - 集成测试

**Phase 3：缓存策略与 Middleware（1.5 周）**
- Week 3.0-4.0：
  - 实现 `CacheStrategy` 接口
  - 实现 `AnthropicStrategy` 和 `OpenAIStrategy`
  - 新建 `PromptCachingMiddleware`
  - 集成到 `buildDeepAgent()` 的 middleware 栈
  - 契约测试验证

**Phase 4：可观测性与 UI（1 周）**
- Week 4.5-5.5：
  - 增强 `UsageMetricsCollector` 收集缓存指标
  - 实现会话级聚合统计
  - 在 `DiagnosticsView` 添加缓存仪表盘
  - E2E 测试

**Phase 5：回归测试与优化（0.5-1 周）**
- Week 5.5-6.0：
  - 运行完整回归测试套件
  - 性能优化（如果需要）
  - 文档更新
  - 代码审查

### 关键里程碑

| 日期 | 里程碑 | 交付物 |
|------|--------|--------|
| Week 1.5 | Block 系统可用 | SystemPromptBuilder + 单元测试 |
| Week 2.5 | 快照优化完成 | SnapshotCache + 百分比 usage |
| Week 4.0 | 缓存注入可用 | PromptCachingMiddleware + 两种策略 |
| Week 5.5 | UI 可观测 | DiagnosticsView 缓存面板 |
| Week 6.0 | 生产就绪 | 全部测试绿色 + 文档 |

---

## 风险与缓解

### 主要风险

**R1：Anthropic content blocks 兼容性**
- **风险**：`SystemMessage.content` 数组格式可能与 deepagents 内部处理冲突
- **缓解**：Phase 3 早期进行契约测试，验证端到端流程
- **降级**：如不兼容，回退到字符串 content + 在 middleware 中手动拆分

**R2：快照缓存命中率低于预期**
- **风险**：用户频繁编辑内存文件仍导致失效
- **缓解**：实施文件监听 + 用户提示（"内存已修改，下次请求将重建缓存"）
- **降级**：提供"锁定快照"选项，手动控制何时刷新

**R3：OpenAI 自动缓存未生效**
- **风险**：某些 OpenAI 兼容 endpoint（如 ollama）不支持自动缓存
- **缓解**：在日志中记录 endpoint 类型，文档说明支持情况
- **降级**：OpenAI 策略仅做前缀验证，不强依赖缓存

**R4：性能开销（Block 构建 + 哈希计算）**
- **风险**：每次请求构建 Blocks 和计算哈希增加延迟
- **缓解**：哈希只计算变化的 Block（通过简单 === 判等优化）
- **降级**：缓存 Block 构建结果（类似 SnapshotCache）

**R5：Middleware 顺序冲突**
- **风险**：PromptCachingMiddleware 在 ForgeCleanup 之后可能受影响
- **缓解**：Phase 3 集成测试验证 middleware 栈顺序
- **降级**：调整位置到 ForgeTieredCompaction 之后、ForgeCleanup 之前

---

## 成功指标

### 量化指标

- **Anthropic 缓存命中率**：`cacheReadTokens / promptTokens > 70%`（第二次及以后）
- **OpenAI 前缀稳定性**：通过日志确认连续请求前缀哈希相同
- **平均成本节省**：**70-90%**（输入 token）
- **延迟降低**：TTFT 降低 **5x**（Anthropic 缓存命中时）
- **零回归**：所有现有测试保持绿色

### 定性指标

- 用户无感知：Agent 行为和对话质量不变
- 可观测性：UI 清晰展示缓存状态
- 可维护性：新 provider 接入只需实现 CacheStrategy

---

## 受影响文件

### 新增文件

- `src/main/services/deep-agent/prompt-builder.ts` — SystemPromptBuilder
- `src/main/services/forge-guardrails/middleware/prompt-caching.ts` — PromptCachingMiddleware
- `tests/main/services/deep-agent/prompt-builder.test.ts` — 单元测试
- `tests/main/services/forge-guardrails/middleware/prompt-caching.test.ts` — 单元测试
- `tests/main/deep-agent/cache-contracts.test.ts` — 契约测试

### 修改文件

- `src/main/services/deep-agent/agent-builder.ts` — 集成 PromptCachingMiddleware
- `src/main/services/deep-agent/session.ts` — 使用 SystemPromptBuilder
- `src/main/services/deep-agent-runtime-service.ts` — 添加 SnapshotCache
- `src/main/services/memory/snapshot.ts` — 新增 renderFrozenSnapshotWithPercentage
- `src/main/services/deep-agent/stream-consumers.ts` — 增强 UsageMetricsCollector
- `src/renderer/views/diagnostics/DiagnosticsView.tsx` — 新增缓存面板

---

## 参考资料

- [Anthropic Prompt Caching 官方文档](https://docs.claude.com/en/docs/build-with-claude/prompt-caching)
- [OpenAI Prompt Caching 官方文档](https://platform.openai.com/docs/guides/prompt-caching)
- [工具缓存指南](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching)
- [实战案例：Claude Code 缓存优化](https://www.knightli.com/en/2026/05/18/claude-code-prompt-cache-token-optimization/)
- 项目内参考：`docs/superpowers/specs/2026-06-05-deepagents-alignment-optimization-design.md`
