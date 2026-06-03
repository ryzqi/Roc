# Anthropic Provider 重构设计文档

**日期:** 2026-06-04  
**版本:** 1.0  
**状态:** 已批准  
**作者:** AI Assistant

## 1. 概述

### 1.1 目标

本次重构的目标是:
1. **对齐官方文档**: 将 Roc 的 Anthropic provider 实现与 `@langchain/anthropic` v1.4.0 官方 API 完全对齐
2. **优化代码结构**: 重构 `langchain-model-factory.ts` 中的 Anthropic 配置逻辑,提高可维护性
3. **渐进式补全**: 分两个阶段实施,降低风险,优先补充高价值功能

### 1.2 背景

当前实现基于 `@langchain/anthropic` v1.4.0,已支持基础配置项,但缺失以下关键功能:
- **Prompt Caching** (`cache_control`) - 成本优化核心功能
- **Beta 功能访问** (`betas`) - 访问实验性功能的通道
- **灵活扩展能力** (`invocationKwargs`) - 支持未来新增参数
- **高级输出控制** (`outputConfig`) - 控制响应详细程度
- **上下文管理** (`contextManagement`) - 高级上下文编辑
- **地理区域控制** (`inferenceGeo`) - 成本优化选项

### 1.3 范围

**包含:**
- 类型定义扩展 (`src/shared/types/settings.ts`)
- 配置 schema 更新 (`src/main/services/config/schema.ts`)
- 工厂方法重构 (`src/main/services/langchain-model-factory.ts`)
- 单元测试和集成测试
- 配置文档

**不包含:**
- UI 界面修改(第一阶段不涉及)
- 数据迁移脚本(所有新字段都是可选的)
- `createClient` 自定义客户端支持(除非需要 Vertex AI)

## 2. 现状分析

### 2.1 已实现的配置项 ✅

```typescript
// 当前 src/main/services/langchain-model-factory.ts 第 585-623 行
new ChatAnthropic({
  model: modelId,
  apiKey,
  anthropicApiUrl: baseUrl,
  streaming,
  maxRetries: 0,
  temperature,
  maxTokens,
  topP,
  topK,
  stopSequences,
  streamUsage,
  thinking: { type: 'disabled' | 'adaptive' | 'enabled', budget_tokens },
  clientOptions: {
    maxRetries: 0,
    timeout,
    defaultHeaders
  }
})
```

### 2.2 缺失的配置项 ❌

**构造参数:**
- `invocationKwargs` - 传递额外的 Anthropic API 参数
- `contextManagement` - 上下文管理配置
- `outputConfig` - 输出配置(effort 级别)
- `inferenceGeo` - 地理区域推理配置
- `betas` - Beta 功能数组

**运行时选项 (CallOptions):**
- `cache_control` - 自动缓存控制
- `tool_choice` - 工具选择策略
- `headers` - 请求级自定义 headers
- `container` - 代码执行容器 ID
- `outputConfig` - 请求级输出配置
- `betas` - 请求级 beta 功能
- `mcp_servers` - MCP 服务器 URL 数组
- `strict` - 严格模式工具调用

### 2.3 代码结构问题

当前所有配置逻辑集中在 `createModelForProvider` 方法的一个 if 分支中(第 585-623 行),存在以下问题:
1. 配置映射逻辑与工厂方法耦合
2. Anthropic 特定逻辑难以单独测试
3. 新增配置项需要修改核心方法
4. 缺少配置验证辅助函数

## 3. 设计方案

### 3.1 架构优化

```
langchain-model-factory.ts
├── createModelForProvider()          # 入口方法(保持不变)
├── createAnthropicModel()            # Anthropic 专用工厂函数 [新增]
│   ├── resolveAnthropicConfig()      # 配置映射 [新增]
│   ├── buildClientOptions()          # ClientOptions 构建 [新增]
│   └── validateAnthropicOptions()    # 配置验证 [新增]
└── 辅助函数
    ├── resolveAnthropicThinking()    # 已存在
    ├── resolveAnthropicBetas()       # 新增
    └── resolveStreamUsage()          # 已存在
```

### 3.2 实施阶段

#### 第一阶段:核心功能补全(1-1.5 周)

**优先级:** 🔥 高

**新增配置项:**
1. `invocationKwargs` - 灵活性扩展
2. `anthropicBetas` - Beta 功能访问
3. `anthropicCacheControl` - Prompt Caching 支持

**改动范围:**
- 类型定义扩展
- 工厂方法重构
- 配置映射实现
- 测试用例补充

#### 第二阶段:高级功能补全(1 周)

**优先级:** 🟡 中

**新增配置项:**
1. `anthropicOutputConfig` - 输出控制
2. `anthropicContextManagement` - 上下文管理
3. `anthropicInferenceGeo` - 地理区域控制

**改动范围:**
- 类型定义扩展
- 配置映射补充
- 测试用例补充
- 配置文档完善

## 4. 详细设计

### 4.1 类型定义

#### 4.1.1 第一阶段类型扩展

**文件:** `src/shared/types/settings.ts`

```typescript
export type ProviderOptions = {
  // ... 现有字段 ...
  
  // 第一阶段新增
  /**
   * 传递给 Anthropic API 的额外参数
   * 用于支持未来新增的 API 参数而无需修改类型定义
   */
  invocationKwargs?: Record<string, unknown>;
  
  /**
   * Anthropic Beta 功能列表
   * 例如: ['prompt-caching-2024-07-31', 'pdfs-2024-09-25']
   */
  anthropicBetas?: string[];
  
  /**
   * 自动缓存控制配置
   * 用于 Prompt Caching,自动在请求中应用缓存断点
   */
  anthropicCacheControl?: {
    type: 'ephemeral';
    ttl?: '5m' | '1h';
  };
};
```

#### 4.1.2 第二阶段类型扩展

```typescript
export type AnthropicOutputEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type AnthropicOutputConfig = {
  /**
   * 控制模型响应的详细程度和 token 使用量
   */
  effort?: AnthropicOutputEffort;
  format?: 'json' | 'text';
};

export type AnthropicContextManagementConfig = {
  enabled: boolean;
  strategy?: 'sliding_window' | 'custom';
};

export type ProviderOptions = {
  // ... 第一阶段字段 ...
  
  // 第二阶段新增
  anthropicOutputConfig?: AnthropicOutputConfig;
  anthropicContextManagement?: AnthropicContextManagementConfig;
  anthropicInferenceGeo?: string;
};
```

### 4.2 配置 Schema 验证

**文件:** `src/main/services/config/schema.ts`

```typescript
const providerOptionsSchema = z.object({
  // ... 现有字段 ...
  
  // 第一阶段
  invocationKwargs: z.record(z.unknown()).optional(),
  anthropicBetas: z.array(z.string()).optional(),
  anthropicCacheControl: z.object({
    type: z.literal('ephemeral'),
    ttl: z.enum(['5m', '1h']).optional()
  }).optional(),
  
  // 第二阶段
  anthropicOutputConfig: z.object({
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
    format: z.enum(['json', 'text']).optional()
  }).optional(),
  anthropicContextManagement: z.object({
    enabled: z.boolean(),
    strategy: z.enum(['sliding_window', 'custom']).optional()
  }).optional(),
  anthropicInferenceGeo: z.string().optional()
});
```

### 4.3 核心实现

#### 4.3.1 Anthropic 专用工厂函数

**文件:** `src/main/services/langchain-model-factory.ts`

```typescript
/**
 * 创建 Anthropic 聊天模型实例
 */
private createAnthropicModel(
  provider: ProviderConfig,
  modelId: string,
  apiKey: string,
  options: {
    streaming: boolean;
    contextBudgetTokens: number;
    requestTimeoutMs: number;
  }
): LangChainChatModelHandle {
  const baseUrl = this.normalizeAnthropicApiUrl(provider.endpoint);
  const config = this.resolveAnthropicConfig(provider, modelId, options);
  
  const model = new ChatAnthropic(config);
  warnIfAnthropicCacheControlConfigured(model);
  
  return {
    provider,
    modelId,
    runtime: {
      providerType: provider.type,
      baseUrl,
      streaming: options.streaming,
      modelKwargs: {},
      contextBudgetTokens: options.contextBudgetTokens
    },
    model
  };
}
```

#### 4.3.2 配置映射逻辑

```typescript
/**
 * 将 ProviderConfig 映射为 ChatAnthropic 构造参数
 */
private resolveAnthropicConfig(
  provider: ProviderConfig,
  modelId: string,
  options: {
    streaming: boolean;
    requestTimeoutMs: number;
  }
): ChatAnthropicInput {
  const providerOptions = provider.options ?? {};
  const baseUrl = this.normalizeAnthropicApiUrl(provider.endpoint);
  const apiKey = this.resolveCredential(provider);
  
  // 基础配置
  const config: ChatAnthropicInput = {
    model: modelId,
    apiKey,
    anthropicApiUrl: baseUrl,
    streaming: options.streaming,
    maxRetries: 0,
    streamUsage: resolveStreamUsage(provider, options.streaming),
    clientOptions: this.buildAnthropicClientOptions(provider, options.requestTimeoutMs)
  };
  
  // 采样参数映射
  this.applyAnthropicSamplingParams(config, providerOptions);
  
  // Extended Thinking
  const thinking = resolveAnthropicThinking(providerOptions);
  if (thinking !== undefined) {
    config.thinking = thinking;
  }
  
  // 第一阶段新增
  this.applyAnthropicPhase1Features(config, providerOptions);
  
  // 第二阶段新增
  this.applyAnthropicPhase2Features(config, providerOptions);
  
  return config;
}

/**
 * 应用采样参数
 */
private applyAnthropicSamplingParams(
  config: ChatAnthropicInput,
  options: ProviderOptions
): void {
  if (options.temperature !== undefined) {
    config.temperature = options.temperature;
  }
  if (options.maxTokens !== undefined) {
    config.maxTokens = options.maxTokens;
  }
  if (options.topP !== undefined) {
    config.topP = options.topP;
  }
  if (options.topK !== undefined) {
    config.topK = options.topK;
  }
  if (options.stop !== undefined && options.stop.length > 0) {
    config.stopSequences = options.stop;
  }
}

/**
 * 应用第一阶段功能
 */
private applyAnthropicPhase1Features(
  config: ChatAnthropicInput,
  options: ProviderOptions
): void {
  // Beta 功能
  if (options.anthropicBetas !== undefined && options.anthropicBetas.length > 0) {
    config.betas = resolveAnthropicBetas(options.anthropicBetas);
  }
  
  // 额外参数
  if (options.invocationKwargs !== undefined) {
    config.invocationKwargs = options.invocationKwargs;
  }
}

/**
 * 应用第二阶段功能
 */
private applyAnthropicPhase2Features(
  config: ChatAnthropicInput,
  options: ProviderOptions
): void {
  // 输出配置
  if (options.anthropicOutputConfig !== undefined) {
    config.outputConfig = {
      effort: options.anthropicOutputConfig.effort
    };
  }
  
  // 上下文管理
  if (options.anthropicContextManagement !== undefined) {
    config.contextManagement = options.anthropicContextManagement;
  }
  
  // 推理区域
  if (options.anthropicInferenceGeo !== undefined) {
    config.inferenceGeo = options.anthropicInferenceGeo;
  }
}

/**
 * 构建 Anthropic ClientOptions
 */
private buildAnthropicClientOptions(
  provider: ProviderConfig,
  timeoutMs: number
): ClientOptions {
  const options: ClientOptions = {
    maxRetries: 0,
    timeout: provider.options?.timeoutMs ?? timeoutMs
  };
  
  if (provider.options?.defaultHeaders !== undefined) {
    options.defaultHeaders = provider.options.defaultHeaders;
  }
  
  return options;
}
```

#### 4.3.3 辅助函数

```typescript
/**
 * 解析 Anthropic Beta 功能配置
 */
function resolveAnthropicBetas(betas: string[]): AnthropicBeta[] {
  const validBetas: AnthropicBeta[] = [];
  
  for (const beta of betas) {
    if (typeof beta === 'string' && beta.trim().length > 0) {
      validBetas.push(beta as AnthropicBeta);
    }
  }
  
  return validBetas;
}
```

#### 4.3.4 主入口方法修改

```typescript
async createModelForProvider(
  provider: ProviderConfig,
  modelId: string,
  options: CreateModelOptions = {}
): Promise<LangChainChatModelHandle> {
  // ... 现有验证逻辑 ...
  
  const streaming = provider.type === 'llama_cpp' ? true : (options.streaming ?? true);
  const requestTimeoutMs = provider.type === 'llama_cpp' 
    ? llamaCppProviderRequestTimeoutMs 
    : providerRequestTimeoutMs;
  const contextBudgetTokens = provider.options?.contextBudgetTokens ?? 8192;
  
  // Anthropic 分支 - 使用新的专用工厂函数
  if (provider.type === 'anthropic_compatible') {
    const apiKey = this.resolveCredential(provider);
    return this.createAnthropicModel(provider, modelId, apiKey, {
      streaming,
      contextBudgetTokens,
      requestTimeoutMs
    });
  }
  
  // ... 其他 provider 类型的处理保持不变 ...
}
```

## 5. 测试策略

### 5.1 单元测试

**文件:** `src/main/services/langchain-model-factory.test.ts`

#### 5.1.1 第一阶段测试用例

```typescript
describe('LangChainModelFactory - Anthropic Phase 1', () => {
  it('应该正确映射 invocationKwargs', async () => {
    const provider: ProviderConfig = {
      type: 'anthropic_compatible',
      options: {
        invocationKwargs: { custom_param: 'value' }
      }
    };
    
    const handle = await factory.createModelForProvider(provider, 'claude-sonnet-4-6');
    expect(handle.model).toHaveProperty('invocationKwargs');
    expect(handle.model.invocationKwargs).toEqual({ custom_param: 'value' });
  });
  
  it('应该正确映射 anthropicBetas', async () => {
    const provider: ProviderConfig = {
      type: 'anthropic_compatible',
      options: {
        anthropicBetas: ['prompt-caching-2024-07-31', 'pdfs-2024-09-25']
      }
    };
    
    const handle = await factory.createModelForProvider(provider, 'claude-sonnet-4-6');
    expect(handle.model.betas).toHaveLength(2);
    expect(handle.model.betas).toContain('prompt-caching-2024-07-31');
  });
  
  it('应该过滤无效的 beta 字符串', () => {
    const betas = ['valid-beta', '', '  ', 'another-valid'];
    const resolved = resolveAnthropicBetas(betas);
    expect(resolved).toHaveLength(2);
    expect(resolved).not.toContain('');
  });
  
  it('invocationKwargs 为空对象时应该正确处理', async () => {
    const provider: ProviderConfig = {
      type: 'anthropic_compatible',
      options: {
        invocationKwargs: {}
      }
    };
    
    const handle = await factory.createModelForProvider(provider, 'claude-sonnet-4-6');
    expect(handle.model.invocationKwargs).toEqual({});
  });
});
```

#### 5.1.2 第二阶段测试用例

```typescript
describe('LangChainModelFactory - Anthropic Phase 2', () => {
  it('应该正确映射 outputConfig', async () => {
    const provider: ProviderConfig = {
      type: 'anthropic_compatible',
      options: {
        anthropicOutputConfig: { effort: 'medium' }
      }
    };
    
    const handle = await factory.createModelForProvider(provider, 'claude-opus-4-6');
    expect(handle.model.outputConfig).toEqual({ effort: 'medium' });
  });
  
  it('应该正确映射 contextManagement', async () => {
    const provider: ProviderConfig = {
      type: 'anthropic_compatible',
      options: {
        anthropicContextManagement: {
          enabled: true,
          strategy: 'sliding_window'
        }
      }
    };
    
    const handle = await factory.createModelForProvider(provider, 'claude-sonnet-4-6');
    expect(handle.model.contextManagement).toBeDefined();
    expect(handle.model.contextManagement.enabled).toBe(true);
  });
  
  it('应该正确映射 inferenceGeo', async () => {
    const provider: ProviderConfig = {
      type: 'anthropic_compatible',
      options: {
        anthropicInferenceGeo: 'us'
      }
    };
    
    const handle = await factory.createModelForProvider(provider, 'claude-sonnet-4-6');
    expect(handle.model.inferenceGeo).toBe('us');
  });
});
```

#### 5.1.3 结构优化测试

```typescript
describe('LangChainModelFactory - Structure Refactoring', () => {
  it('createAnthropicModel 应该返回正确的 handle 结构', async () => {
    const provider: ProviderConfig = {
      type: 'anthropic_compatible',
      endpoint: 'https://api.anthropic.com',
      credentialRef: 'secret:test',
      enabled: true,
      models: [{ id: 'claude-sonnet-4-6', enabled: true }]
    };
    
    const handle = await factory.createModelForProvider(provider, 'claude-sonnet-4-6');
    
    expect(handle).toHaveProperty('provider');
    expect(handle).toHaveProperty('model');
    expect(handle).toHaveProperty('modelId');
    expect(handle).toHaveProperty('runtime');
    expect(handle.runtime.providerType).toBe('anthropic_compatible');
    expect(handle.modelId).toBe('claude-sonnet-4-6');
  });
  
  it('应该保持向后兼容性', async () => {
    const legacyProvider: ProviderConfig = {
      type: 'anthropic_compatible',
      options: {
        temperature: 0.7,
        maxTokens: 1000,
        topP: 0.9,
        topK: 10
      }
    };
    
    const handle = await factory.createModelForProvider(legacyProvider, 'claude-sonnet-4-6');
    expect(handle.model.temperature).toBe(0.7);
    expect(handle.model.maxTokens).toBe(1000);
    expect(handle.model.topP).toBe(0.9);
    expect(handle.model.topK).toBe(10);
  });
  
  it('不传新增字段时应该与重构前行为一致', async () => {
    const provider: ProviderConfig = {
      type: 'anthropic_compatible',
      options: {}
    };
    
    const handle = await factory.createModelForProvider(provider, 'claude-sonnet-4-6');
    expect(handle.model.betas).toBeUndefined();
    expect(handle.model.invocationKwargs).toBeUndefined();
    expect(handle.model.outputConfig).toBeUndefined();
  });
  
  it('buildAnthropicClientOptions 应该正确构建 ClientOptions', () => {
    const provider: ProviderConfig = {
      type: 'anthropic_compatible',
      options: {
        timeoutMs: 30000,
        defaultHeaders: { 'X-Custom': 'value' }
      }
    };
    
    const clientOptions = factory['buildAnthropicClientOptions'](provider, 60000);
    expect(clientOptions.timeout).toBe(30000);
    expect(clientOptions.defaultHeaders).toEqual({ 'X-Custom': 'value' });
    expect(clientOptions.maxRetries).toBe(0);
  });
});
```

### 5.2 集成测试

```typescript
describe('Anthropic Provider Integration', () => {
  it('应该能使用 Beta 功能调用 Anthropic API', async () => {
    const provider: ProviderConfig = {
      type: 'anthropic_compatible',
      endpoint: 'https://api.anthropic.com',
      credentialRef: 'secret:test-provider',
      enabled: true,
      options: {
        anthropicBetas: ['prompt-caching-2024-07-31'],
        maxTokens: 100
      },
      models: [{ id: 'claude-sonnet-4-6', enabled: true }]
    };
    
    const handle = await factory.createModelForProvider(provider, 'claude-sonnet-4-6');
    const response = await handle.model.invoke('Hello, how are you?');
    
    expect(response).toBeDefined();
    expect(response.content).toBeTruthy();
  });
  
  it('应该正确传递 invocationKwargs 到 API', async () => {
    const provider: ProviderConfig = {
      type: 'anthropic_compatible',
      options: {
        invocationKwargs: {
          metadata: { user_id: 'test-user' }
        }
      }
    };
    
    const handle = await factory.createModelForProvider(provider, 'claude-sonnet-4-6');
    // 验证 kwargs 正确传递(需要 mock Anthropic SDK)
    expect(handle.model.invocationKwargs).toBeDefined();
  });
});
```

### 5.3 测试覆盖率要求

- **单元测试覆盖率:** ≥ 90%
- **集成测试:** 覆盖所有新增配置项的实际 API 调用
- **边界测试:** 包含空值、无效值、边界值测试
- **兼容性测试:** 确保重构不影响现有功能

## 6. 向后兼容性

### 6.1 兼容性保证

1. **所有新增字段都是可选的** - 不传递时使用默认值或不启用该功能
2. **现有配置无需修改** - 重构后的代码对现有 `ProviderConfig` 完全兼容
3. **默认行为不变** - 不传新字段时,行为与重构前完全一致
4. **API 签名不变** - 公共方法签名保持不变

### 6.2 数据迁移

**不需要数据迁移。**

所有新增字段都是可选的,现有配置文件无需修改即可使用。用户可以根据需要逐步采用新功能。

### 6.3 破坏性变更

**无破坏性变更。**

重构完全向后兼容,所有现有功能保持不变。

## 7. 实施计划

### 7.1 第一阶段 (1-1.5 周)

#### 任务分解

| 任务 | 工作量 | 负责人 | 依赖 |
|------|--------|--------|------|
| 1. 类型定义扩展 | 0.5 天 | - | - |
| 2. Schema 验证更新 | 0.5 天 | - | 任务 1 |
| 3. 重构工厂方法 | 2 天 | - | 任务 1, 2 |
| 4. 实现新功能映射 | 1 天 | - | 任务 3 |
| 5. 单元测试 | 2 天 | - | 任务 4 |
| 6. 集成测试 | 1 天 | - | 任务 4 |
| 7. 文档更新 | 0.5 天 | - | 任务 5, 6 |

**总计:** 7.5 天

#### 交付物

- ✅ 重构后的 `langchain-model-factory.ts`
- ✅ 更新的类型定义 (`src/shared/types/settings.ts`)
- ✅ 更新的配置 schema (`src/main/services/config/schema.ts`)
- ✅ 完整的单元测试用例
- ✅ 集成测试用例
- ✅ 配置示例文档

#### 验收标准

- [ ] 所有单元测试通过,覆盖率 ≥ 90%
- [ ] 集成测试通过,验证实际 API 调用
- [ ] 现有功能回归测试通过
- [ ] 代码审查通过
- [ ] 文档完整且清晰

### 7.2 第二阶段 (1 周)

#### 任务分解

| 任务 | 工作量 | 负责人 | 依赖 |
|------|--------|--------|------|
| 1. 类型定义扩展 | 0.5 天 | - | 第一阶段完成 |
| 2. 配置映射实现 | 1 天 | - | 任务 1 |
| 3. 单元测试 | 1.5 天 | - | 任务 2 |
| 4. 集成测试 | 1 天 | - | 任务 2 |
| 5. UI 表单支持(可选) | 1 天 | - | 任务 2 |
| 6. 文档更新 | 0.5 天 | - | 任务 3, 4 |

**总计:** 5.5 天

#### 交付物

- ✅ 完整对齐官方文档的实现
- ✅ 完整的测试覆盖
- ✅ 用户配置指南
- ✅ (可选) UI 界面支持

#### 验收标准

- [ ] 所有新功能实现完成
- [ ] 所有测试通过,覆盖率 ≥ 90%
- [ ] 与官方文档 100% 对齐
- [ ] 代码审查通过
- [ ] 用户文档完整

## 8. 风险与缓解措施

### 8.1 风险识别

| 风险 | 严重程度 | 可能性 | 影响 | 缓解措施 |
|------|----------|--------|------|----------|
| 重构引入新 Bug | 高 | 中 | 影响现有功能 | 完整的单元测试和回归测试,代码审查 |
| 与 LangChain 版本不兼容 | 中 | 低 | 升级后功能失效 | 固定依赖版本,添加版本检查 |
| 配置验证不严格 | 中 | 中 | 运行时错误 | 完善 Zod schema,添加运行时验证 |
| 性能下降 | 低 | 低 | 响应变慢 | 性能基准测试,避免不必要的计算 |
| 文档不完整 | 低 | 中 | 用户无法使用新功能 | 提供示例配置,编写用户指南 |

### 8.2 回滚计划

如果重构出现严重问题:

1. **立即回滚代码** - 使用 git revert 恢复到重构前版本
2. **保留配置** - 新增字段不影响旧代码,配置无需修改
3. **修复后重新部署** - 在测试环境充分验证后再次部署

## 9. 配置示例

### 9.1 第一阶段功能示例

#### 使用 Prompt Caching

```json
{
  "type": "anthropic_compatible",
  "endpoint": "https://api.anthropic.com",
  "options": {
    "maxTokens": 2000,
    "anthropicBetas": ["prompt-caching-2024-07-31"],
    "anthropicCacheControl": {
      "type": "ephemeral",
      "ttl": "5m"
    }
  }
}
```

#### 使用 Beta 功能

```json
{
  "type": "anthropic_compatible",
  "endpoint": "https://api.anthropic.com",
  "options": {
    "anthropicBetas": [
      "prompt-caching-2024-07-31",
      "pdfs-2024-09-25"
    ]
  }
}
```

#### 传递额外参数

```json
{
  "type": "anthropic_compatible",
  "endpoint": "https://api.anthropic.com",
  "options": {
    "invocationKwargs": {
      "metadata": {
        "user_id": "user-123",
        "session_id": "session-456"
      }
    }
  }
}
```

### 9.2 第二阶段功能示例

#### 控制输出详细程度

```json
{
  "type": "anthropic_compatible",
  "endpoint": "https://api.anthropic.com",
  "options": {
    "anthropicOutputConfig": {
      "effort": "medium"
    }
  }
}
```

#### 地理区域限制

```json
{
  "type": "anthropic_compatible",
  "endpoint": "https://api.anthropic.com",
  "options": {
    "anthropicInferenceGeo": "us"
  }
}
```

#### 完整配置示例

```json
{
  "id": "anthropic-main",
  "name": "Anthropic Claude",
  "type": "anthropic_compatible",
  "endpoint": "https://api.anthropic.com",
  "credentialRef": "secret:anthropic-main",
  "enabled": true,
  "models": [
    {
      "id": "claude-opus-4-6",
      "displayName": "Claude Opus 4.6",
      "enabled": true,
      "supportsStreaming": true,
      "supportsToolCalls": true
    }
  ],
  "options": {
    "temperature": 0.7,
    "maxTokens": 4096,
    "topP": 0.9,
    "topK": 10,
    "streamUsage": true,
    "anthropicThinking": {
      "mode": "adaptive"
    },
    "anthropicBetas": ["prompt-caching-2024-07-31"],
    "anthropicOutputConfig": {
      "effort": "medium"
    },
    "anthropicInferenceGeo": "us",
    "invocationKwargs": {
      "metadata": {
        "app_version": "1.0.0"
      }
    }
  }
}
```

## 10. 参考资料

### 10.1 官方文档

- [LangChain Anthropic Integration](https://docs.langchain.com/oss/javascript/integrations/chat/anthropic)
- [Anthropic API Reference](https://docs.anthropic.com/en/api/messages)
- [Anthropic Prompt Caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)
- [Anthropic Extended Thinking](https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking)
- [Anthropic Context Management](https://docs.claude.com/en/docs/build-with-claude/context-editing)

### 10.2 相关代码

- `src/main/services/langchain-model-factory.ts` - 主要实现文件
- `src/shared/types/settings.ts` - 类型定义
- `src/main/services/config/schema.ts` - 配置验证
- `@langchain/anthropic` v1.4.0 - LangChain Anthropic 包

### 10.3 变更历史

| 版本 | 日期 | 变更内容 | 作者 |
|------|------|----------|------|
| 1.0 | 2026-06-04 | 初始版本,完成设计 | AI Assistant |

---

## 附录 A: 对比表

### A.1 官方支持 vs 当前实现

| 配置项 | 官方支持 | 当前实现 | 第一阶段 | 第二阶段 |
|--------|----------|----------|----------|----------|
| model | ✅ | ✅ | ✅ | ✅ |
| apiKey | ✅ | ✅ | ✅ | ✅ |
| anthropicApiUrl | ✅ | ✅ | ✅ | ✅ |
| streaming | ✅ | ✅ | ✅ | ✅ |
| maxRetries | ✅ | ✅ | ✅ | ✅ |
| temperature | ✅ | ✅ | ✅ | ✅ |
| maxTokens | ✅ | ✅ | ✅ | ✅ |
| topP | ✅ | ✅ | ✅ | ✅ |
| topK | ✅ | ✅ | ✅ | ✅ |
| stopSequences | ✅ | ✅ | ✅ | ✅ |
| streamUsage | ✅ | ✅ | ✅ | ✅ |
| thinking | ✅ | ✅ | ✅ | ✅ |
| clientOptions | ✅ | ✅ | ✅ | ✅ |
| **invocationKwargs** | ✅ | ❌ | **✅** | ✅ |
| **betas** | ✅ | ❌ | **✅** | ✅ |
| **cache_control** | ✅ | ❌ | **✅** | ✅ |
| **outputConfig** | ✅ | ❌ | ❌ | **✅** |
| **contextManagement** | ✅ | ❌ | ❌ | **✅** |
| **inferenceGeo** | ✅ | ❌ | ❌ | **✅** |
| createClient | ✅ | ❌ | ❌ | ❌ |

### A.2 优先级说明

- **P0 (必须)**: cache_control, invocationKwargs, betas
- **P1 (重要)**: outputConfig, inferenceGeo
- **P2 (可选)**: contextManagement, createClient

---

**文档状态:** ✅ 已完成  
**下一步:** 开始第一阶段实施

