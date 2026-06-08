# 供应商配置与渲染重构设计文档

**日期**: 2026-06-08  
**作者**: AI Assistant  
**状态**: 待审核

---

## 1. 概述

### 1.1 重构目标

本次重构旨在完成以下三个核心目标：

1. **统一配置架构** - 让供应商配置完全遵循 deepagents/langchain 的设计模式，简化适配层
2. **标准化参数管理** - 重新设计参数的组织方式，采用三层结构（CommonParams + 供应商专属参数）
3. **前端渲染重构** - 统一 tool-call 和 reasoning 视图的架构模式，对齐 deepagents 输出格式，清理代码结构

### 1.2 背景分析

**当前状态**：
- 供应商配置使用单一的 `ProviderOptions` 类型，包含所有可能的参数
- `provider-adapter.ts` 和 `langchain-model-factory.ts` 存在职责重叠
- 前端 `tool-call-view.tsx` 和 `reasoning-view.tsx` 架构不一致
- thinking/reasoning 参数散布在不同的供应商配置中

**核心问题**：
1. 类型安全性不足 - 无法在编译时确保供应商使用正确的参数
2. 职责不清晰 - 模型创建逻辑分散在多个文件
3. 前端组件模式不一致 - 难以维护和扩展
4. 参数管理混乱 - 缺乏清晰的分层

### 1.3 技术约束

- **LangChain 限制**: 不同供应商的 thinking/reasoning 参数没有统一抽象，必须保持供应商专属
- **向后兼容**: 需要支持现有配置文件的迁移
- **deepagents 集成**: 必须完全对齐 deepagents 1.10.2 的输出格式

---

## 2. 架构设计

### 2.1 后端：供应商配置类型系统

#### 2.1.1 三层参数结构

```typescript
// ============================================================================
// 层级 1: 通用参数（所有供应商共享）
// ============================================================================

export type CommonProviderParams = {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  timeoutMs?: number;
  defaultHeaders?: Record<string, string>;
};

// ============================================================================
// 层级 2: 供应商专属参数（扩展通用参数）
// ============================================================================

// OpenAI 专属参数
export type OpenAIProviderParams = CommonProviderParams & {
  // Sampling
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
  stop?: string[];
  
  // Organization
  organization?: string;
  
  // Features
  parallelToolCalls?: boolean;
  streamUsage?: boolean;
  serviceTier?: OpenAiServiceTier;
  verbosity?: OpenAiVerbosity;
  zdrEnabled?: boolean;
  useResponsesApi?: boolean;
  
  // Reasoning (o1/o3 models)
  reasoning?: {
    effort?: OpenAiReasoningEffort;
    summary?: OpenAiReasoningSummary;
  };
};

// Anthropic 专属参数
export type AnthropicProviderParams = CommonProviderParams & {
  // Sampling
  topK?: number;
  stopSequences?: string[];
  
  // Extended Thinking
  thinking?: AnthropicThinkingOption;
  
  // Beta features
  betas?: string[];
  
  // Advanced
  invocationKwargs?: Record<string, unknown>;
};

// NVIDIA 专属参数
export type NvidiaProviderParams = CommonProviderParams & {
  // Sampling
  topK?: number;
  minP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  repetitionPenalty?: number;
  seed?: number;
  stop?: string[];
  
  // Reasoning
  thinking?: boolean;
  includeReasoning?: boolean;
  
  // Features
  parallelToolCalls?: boolean;
  streamUsage?: boolean;
  toolChoice?: NvidiaToolChoice;
  
  // Guided Generation
  guidedJson?: Record<string, unknown>;
  guidedRegex?: string;
  guidedChoice?: string[];
  guidedGrammar?: string;
  
  // Infrastructure
  endpointOverride?: string;
};

// ============================================================================
// 层级 3: 类型化供应商配置（判别联合类型）
// ============================================================================

export type ProviderConfigTyped =
  | {
      type: 'openai_compatible';
      config: BaseProviderConfig;
      params: OpenAIProviderParams;
    }
  | {
      type: 'anthropic_compatible';
      config: BaseProviderConfig;
      params: AnthropicProviderParams;
    }
  | {
      type: 'nvidia';
      config: BaseProviderConfig;
      params: NvidiaProviderParams;
    }
  | {
      type: 'openrouter';
      config: BaseProviderConfig;
      params: OpenAIProviderParams;  // OpenRouter 使用 OpenAI 参数
    }
  | {
      type: 'llama_cpp';
      config: BaseProviderConfig;
      params: OpenAIProviderParams;  // llama.cpp 使用 OpenAI 参数
    };
```

#### 2.1.2 类型守卫

```typescript
export function isOpenAIProvider(
  config: ProviderConfigTyped
): config is Extract<ProviderConfigTyped, { type: 'openai_compatible' | 'openrouter' | 'llama_cpp' }> {
  return config.type === 'openai_compatible' || config.type === 'openrouter' || config.type === 'llama_cpp';
}

export function isAnthropicProvider(
  config: ProviderConfigTyped
): config is Extract<ProviderConfigTyped, { type: 'anthropic_compatible' }> {
  return config.type === 'anthropic_compatible';
}

export function isNvidiaProvider(
  config: ProviderConfigTyped
): config is Extract<ProviderConfigTyped, { type: 'nvidia' }> {
  return config.type === 'nvidia';
}
```

#### 2.1.3 配置转换工具

```typescript
/**
 * 将旧的 ProviderConfig 转换为新的类型化配置
 */
export function toTypedProviderConfig(legacy: ProviderConfig): ProviderConfigTyped;

/**
 * 将类型化配置转换回旧格式（兼容性）
 */
export function fromTypedProviderConfig(typed: ProviderConfigTyped): ProviderConfig;
```

### 2.2 后端：统一适配器模式

#### 2.2.1 职责划分

**`provider-adapter.ts`** - 唯一的模型创建入口
- 根据供应商类型创建 LangChain 模型实例
- 直接映射类型化参数到 LangChain 构造函数
- 处理供应商特定的配置转换

**`langchain-model-factory.ts`** - 简化为模型管理器
- 凭据解析
- 默认模型选择
- 采样配置管理
- 不再直接创建模型（委托给 `provider-adapter.ts`）

#### 2.2.2 适配器实现

```typescript
// provider-adapter.ts

/**
 * 根据供应商配置创建 LangChain 模型实例
 */
export function createModelFromProviderConfig(
  provider: ProviderConfig,
  credentials: { apiKey: string } | null
): BaseChatModel {
  const typedConfig = toTypedProviderConfig(provider);
  
  switch (typedConfig.type) {
    case 'anthropic_compatible':
      return createAnthropicModel(typedConfig.config, typedConfig.params, credentials);
    
    case 'openai_compatible':
    case 'openrouter':
    case 'llama_cpp':
      return createOpenAIModel(typedConfig.config, typedConfig.params, credentials);
    
    case 'nvidia':
      return createNvidiaModel(typedConfig.config, typedConfig.params, credentials);
    
    default:
      throw new Error(`Unsupported provider type: ${typedConfig.type}`);
  }
}

/**
 * 创建 Anthropic 模型实例
 */
function createAnthropicModel(
  config: BaseProviderConfig,
  params: AnthropicProviderParams,
  credentials: { apiKey: string } | null
): BaseChatModel {
  const enabledModel = config.models.find((m) => m.enabled);
  if (!enabledModel) {
    throw new Error(`Provider ${config.id} has no enabled models`);
  }
  
  const apiKey = credentials?.apiKey ?? '';
  
  return new ChatAnthropic({
    apiKey,
    model: enabledModel.id,
    anthropicApiUrl: config.endpoint || undefined,
    temperature: params.temperature,
    maxTokens: params.maxTokens,
    topP: params.topP,
    topK: params.topK,
    stopSequences: params.stopSequences,
    timeout: params.timeoutMs,
    thinking: params.thinking,
    betas: params.betas,
    clientOptions: {
      defaultHeaders: params.defaultHeaders,
    },
    invocationKwargs: params.invocationKwargs,
  });
}

// 类似的实现 createOpenAIModel 和 createNvidiaModel
```

### 2.3 前端：统一渲染架构

#### 2.3.1 组件层次结构

```
src/renderer/chat/
├── activity-block/                 # 统一的活动块基础
│   ├── ActivityBlock.tsx          # 基础容器组件
│   ├── ActivityBlockHeader.tsx    # 通用头部
│   ├── ActivityBlockBody.tsx      # 通用主体
│   └── types.ts                   # 共享类型
├── tool-call/                     # 工具调用渲染
│   ├── ToolCallBlock.tsx         # 工具调用容器
│   ├── ToolCallHeader.tsx        # 工具调用头部
│   ├── ToolDataSection.tsx       # 数据展示
│   └── types.ts                  # 工具调用类型
├── reasoning/                     # 推理内容渲染
│   ├── ReasoningBlock.tsx        # 推理容器
│   ├── ReasoningTimeline.tsx     # 时间轴
│   ├── ReasoningStep.tsx         # 单个步骤
│   ├── reasoning-parser.ts       # 解析器
│   └── types.ts                  # 推理类型
└── shared/                        # 共享工具
    ├── use-block-state.ts        # 共享状态 hook
    ├── use-copy-content.ts       # 复制功能 hook
    └── activity-animations.ts    # 动画配置
```

#### 2.3.2 统一状态管理模式

```typescript
// shared/use-block-state.ts

/**
 * 统一的块状态管理 hook
 */
export function useBlockState(initialExpanded: boolean = false) {
  const [expanded, setExpanded] = useState(initialExpanded);
  const [selected, setSelected] = useState(false);
  
  const toggle = useCallback(() => {
    setExpanded(prev => !prev);
  }, []);
  
  const select = useCallback(() => {
    setSelected(true);
  }, []);
  
  const deselect = useCallback(() => {
    setSelected(false);
  }, []);
  
  return {
    expanded,
    selected,
    toggle,
    select,
    deselect,
    setExpanded,
  };
}
```

```typescript
// shared/use-copy-content.ts

/**
 * 统一的复制功能 hook
 */
export function useCopyContent() {
  const [copied, setCopied] = useState(false);
  
  const copy = useCallback((content: unknown) => {
    const text = typeof content === 'string' 
      ? content 
      : JSON.stringify(content, null, 2);
    
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      (error) => {
        console.error('复制失败:', error);
      }
    );
  }, []);
  
  return { copied, copy };
}
```

#### 2.3.3 对齐 deepagents 输出格式

**工具调用格式支持**：
```typescript
// tool-call/types.ts

export type ToolCallStatus = 'start' | 'progress' | 'end' | 'error';

export type ToolCallBlock = {
  kind: 'tool_call';
  id: string;
  name: string;
  status: ToolCallStatus;
  input: unknown;
  output: unknown;
  error: unknown;
  startedAt?: number;
  completedAt?: number;
};
```

**Reasoning 格式支持**：
```typescript
// reasoning/types.ts

export type ReasoningBlock = {
  kind: 'reasoning';
  id: string;
  content: string;
  isStreaming: boolean;
};

/**
 * 解析来自 LangChain 的 reasoning content
 * 支持两种格式：reasoning_content 和 reasoningContent
 */
export function parseReasoningFromMessage(message: AIMessage): string | null {
  // 从 additional_kwargs 读取
  const reasoningContent = 
    message.additional_kwargs?.reasoning_content ||
    message.additional_kwargs?.reasoningContent;
  
  if (typeof reasoningContent === 'string') {
    return reasoningContent;
  }
  
  // 从 response_metadata 读取
  const metadataReasoning =
    message.response_metadata?.reasoning_content ||
    message.response_metadata?.reasoningContent;
  
  if (typeof metadataReasoning === 'string') {
    return metadataReasoning;
  }
  
  return null;
}
```

#### 2.3.4 统一样式系统

```css
/* activity-block-base.css */

.activity-block {
  border-radius: 8px;
  padding: 12px 16px;
  margin-bottom: 12px;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  transition: all 0.2s ease;
}

.activity-block:hover {
  border-color: var(--border-hover);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
}

.activity-block-header {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  user-select: none;
}

.activity-block-body {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border-subtle);
}

.activity-block-icon {
  font-size: 16px;
  flex-shrink: 0;
}

.activity-block-title {
  flex: 1;
  font-weight: 500;
  font-size: 14px;
}

.activity-block-status {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--bg-muted);
}

.activity-block-expand-btn {
  background: none;
  border: none;
  cursor: pointer;
  padding: 4px;
  color: var(--text-muted);
  transition: color 0.2s;
}

.activity-block-expand-btn:hover {
  color: var(--text-default);
}
```

---

## 3. 实施步骤

### 3.1 阶段 1: 后端类型系统重构

**工作量估计**: 4-6 小时

#### 任务清单

- [ ] **任务 1.1**: 完善 `src/shared/types/provider-config.ts`
  - 定义 `CommonProviderParams`
  - 定义 `OpenAIProviderParams`、`AnthropicProviderParams`、`NvidiaProviderParams`
  - 定义 `ProviderConfigTyped` 判别联合类型
  - 实现类型守卫函数
  - 实现 `toTypedProviderConfig` 和 `fromTypedProviderConfig` 转换函数

- [ ] **任务 1.2**: 更新 `src/main/services/deep-agent/provider-adapter.ts`
  - 重构 `createModelFromProviderConfig` 使用类型化配置
  - 简化 `createAnthropicModel` 的参数映射
  - 简化 `createOpenAIModel` 的参数映射
  - 简化 `createNvidiaModel` 的参数映射
  - 移除重复的逻辑

- [ ] **任务 1.3**: 简化 `src/main/services/langchain-model-factory.ts`
  - 移除直接的模型创建逻辑
  - 委托给 `provider-adapter.ts`
  - 保留凭据解析、默认模型选择等管理功能
  - 保留采样配置管理（llama.cpp）

- [ ] **任务 1.4**: 更新相关服务
  - 更新 `src/main/services/config-service.ts` 的类型引用
  - 更新 `src/renderer/settings-model.ts` 的类型引用

### 3.2 阶段 2: 前端组件重构

**工作量估计**: 6-8 小时

#### 任务清单

- [ ] **任务 2.1**: 创建统一基础组件
  - 创建 `src/renderer/chat/activity-block/` 目录
  - 实现 `ActivityBlock.tsx` 基础容器
  - 实现 `ActivityBlockHeader.tsx` 通用头部
  - 实现 `ActivityBlockBody.tsx` 通用主体
  - 定义共享类型 `types.ts`

- [ ] **任务 2.2**: 创建共享工具
  - 创建 `src/renderer/chat/shared/` 目录
  - 实现 `use-block-state.ts` 状态管理 hook
  - 实现 `use-copy-content.ts` 复制功能 hook
  - 实现 `activity-animations.ts` 动画配置

- [ ] **任务 2.3**: 重构工具调用渲染
  - 创建 `src/renderer/chat/tool-call/` 目录
  - 重构 `ToolCallBlock.tsx` 使用新架构
  - 实现 `ToolCallHeader.tsx` 专属头部
  - 实现 `ToolDataSection.tsx` 数据展示
  - 定义工具调用类型 `types.ts`
  - 迁移现有的 `tool-call-view.tsx` 内容

- [ ] **任务 2.4**: 重构推理内容渲染
  - 创建 `src/renderer/chat/reasoning/` 目录
  - 重构 `ReasoningBlock.tsx` 使用新架构
  - 实现 `ReasoningTimeline.tsx` 时间轴
  - 实现 `ReasoningStep.tsx` 单个步骤
  - 更新 `reasoning-parser.ts` 解析器
  - 定义推理类型 `types.ts`
  - 迁移现有的 `reasoning-view.tsx` 内容

- [ ] **任务 2.5**: 样式系统统一
  - 创建 `activity-block-base.css` 基础样式
  - 更新 `tool-call.css` 使用统一变量
  - 更新 `reasoning.css` 使用统一变量
  - 确保颜色、间距、动画一致性

- [ ] **任务 2.6**: 对齐 deepagents 输出
  - 实现 `parseReasoningFromMessage` 函数
  - 支持 `reasoning_content` 和 `reasoningContent` 两种格式
  - 验证工具调用状态映射正确
  - 测试流式 reasoning 更新

### 3.3 阶段 3: 验证和优化

**工作量估计**: 2-4 小时

#### 任务清单

- [ ] **任务 3.1**: 参数映射验证
  - 验证 Anthropic thinking 参数正确映射
  - 验证 OpenAI reasoning 参数正确映射
  - 验证 NVIDIA thinking 参数正确映射
  - 验证通用参数在所有供应商中生效

- [ ] **任务 3.2**: 前端渲染验证
  - 测试工具调用的四种状态（start/progress/end/error）
  - 测试 reasoning 内容的解析和展示
  - 测试展开/折叠交互
  - 测试复制功能
  - 测试流式更新

- [ ] **任务 3.3**: 代码清理
  - 移除旧的 `tool-call-view.tsx`（如果完全迁移）
  - 移除旧的 `reasoning-view.tsx`（如果完全迁移）
  - 更新导入路径
  - 清理未使用的类型和工具函数

- [ ] **任务 3.4**: 文档更新
  - 更新供应商配置文档
  - 更新前端组件使用文档
  - 添加迁移指南（如果需要）

---

## 4. 验收标准

### 4.1 后端验收标准

- [ ] 所有供应商参数使用类型化配置
- [ ] 编译时能检测到参数类型错误（例如：Anthropic 使用 OpenAI 专属参数）
- [ ] `provider-adapter.ts` 是唯一的模型创建入口
- [ ] `langchain-model-factory.ts` 不再包含直接的模型创建逻辑
- [ ] Anthropic thinking 参数正确映射到 `ChatAnthropic({ thinking })`
- [ ] OpenAI reasoning 参数正确映射到 `ChatOpenAI({ reasoning })`
- [ ] NVIDIA thinking 参数正确映射到 `modelKwargs.chat_template_kwargs.thinking`
- [ ] 现有配置文件可以通过 `toTypedProviderConfig` 正确转换

### 4.2 前端验收标准

- [ ] `tool-call` 和 `reasoning` 组件使用一致的架构模式
- [ ] 共享状态管理逻辑（展开/折叠/选择）
- [ ] 共享复制功能
- [ ] 统一的样式系统（颜色、间距、动画）
- [ ] 支持 deepagents 的工具调用生命周期
- [ ] 支持 LangChain 的两种 reasoning 格式（`reasoning_content` 和 `reasoningContent`）
- [ ] 支持流式 reasoning 更新
- [ ] 所有交互功能正常（展开/折叠/复制/选择）

### 4.3 质量标准

- [ ] 无 TypeScript 编译错误
- [ ] 无 ESLint 警告
- [ ] 代码覆盖率不低于现有水平
- [ ] 单元测试通过
- [ ] 集成测试通过（如果存在）

---

## 5. 风险与缓解

### 5.1 风险识别

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|----------|
| 现有配置文件不兼容 | 高 | 中 | 提供配置迁移工具和兼容层 |
| LangChain 参数映射错误 | 高 | 低 | 完整的参数映射测试和验证 |
| 前端组件迁移破坏现有功能 | 中 | 低 | 渐进式迁移，保留旧组件直到验证完成 |
| deepagents 输出格式变化 | 中 | 低 | 版本锁定 deepagents 1.10.2 |
| 性能回归 | 低 | 低 | 性能基准测试 |

### 5.2 回滚计划

如果重构出现严重问题：

1. **后端回滚**：
   - 保留 `toTypedProviderConfig` 和 `fromTypedProviderConfig` 转换函数
   - 临时回退到旧的 `langchain-model-factory.ts` 逻辑
   - 通过配置开关控制使用新旧逻辑

2. **前端回滚**：
   - 保留旧的 `tool-call-view.tsx` 和 `reasoning-view.tsx`
   - 通过 feature flag 控制使用新旧组件
   - 渐进式迁移用户到新组件

---

## 6. 未来扩展

### 6.1 短期扩展（1-3 个月）

1. **供应商动态配置**：支持运行时加载新的供应商类型
2. **参数预设**：为常见场景提供参数预设（快速/平衡/精确）
3. **前端交互增强**：工具调用重试、reasoning 步骤筛选

### 6.2 长期扩展（3-6 个月）

1. **多供应商聚合**：支持同时使用多个供应商的模型
2. **参数自动调优**：基于历史数据自动推荐参数
3. **高级渲染**：reasoning 步骤可视化、工具调用依赖图

---

## 7. 附录

### 7.1 参考资料

- [LangChain ChatAnthropic 文档](https://js.langchain.com/docs/integrations/chat/anthropic)
- [LangChain ChatOpenAI 文档](https://js.langchain.com/docs/integrations/chat/openai)
- [deepagents 1.10.2 文档](https://github.com/langchain-ai/deepagentsjs)
- [Anthropic Extended Thinking API](https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking)
- [OpenAI Reasoning API](https://platform.openai.com/docs/guides/reasoning)

### 7.2 术语表

| 术语 | 定义 |
|------|------|
| 供应商 (Provider) | LLM 服务提供商，如 Anthropic、OpenAI、NVIDIA |
| 适配器 (Adapter) | 将 Roc 配置映射到 LangChain 模型的转换层 |
| 判别联合类型 (Discriminated Union) | TypeScript 类型，使用 type 字段区分不同的子类型 |
| deepagents | LangChain 官方的 agent harness，提供开箱即用的 agent 功能 |
| thinking/reasoning | LLM 的内部推理过程，Anthropic 称为 thinking，OpenAI 称为 reasoning |

---

## 8. 变更记录

| 日期 | 版本 | 变更内容 | 作者 |
|------|------|----------|------|
| 2026-06-08 | 1.0 | 初始版本 | AI Assistant |

