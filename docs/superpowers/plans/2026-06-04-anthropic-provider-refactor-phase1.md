# Anthropic Provider 重构 - 第一阶段实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 对齐 @langchain/anthropic v1.4.0 官方 API,补充核心功能(invocationKwargs, betas, cache_control),优化代码结构

**Architecture:** 将 Anthropic 配置逻辑从 createModelForProvider 提取为独立的 createAnthropicModel 方法,添加配置映射和验证辅助函数,支持新增的三个核心配置项

**Tech Stack:** TypeScript, Zod, @langchain/anthropic v1.4.0, Vitest

---

## 文件结构

### 新增文件
- 无(所有改动在现有文件中)

### 修改文件
- `src/shared/types/settings.ts` - 添加第一阶段类型定义
- `src/main/services/config/schema.ts` - 添加配置验证 schema
- `src/main/services/langchain-model-factory.ts` - 重构 Anthropic 工厂方法
- `src/main/services/langchain-model-factory.test.ts` - 添加单元测试

---

## Task 1: 扩展类型定义

**Files:**
- Modify: `src/shared/types/settings.ts:120-152`

- [ ] **Step 1: 定位 ProviderOptions 类型定义**

运行:
```bash
grep -n "export type ProviderOptions" src/shared/types/settings.ts
```

预期: 找到 ProviderOptions 类型定义的行号

- [ ] **Step 2: 在 ProviderOptions 中添加第一阶段字段**

在 `ProviderOptions` 类型的末尾(现有字段之后)添加:

```typescript
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
   * @deprecated 这是 CallOptions,应该在运行时传递而非构造参数
   * 保留此字段用于未来的 CallOptions 传递支持
   */
  anthropicCacheControl?: {
    type: 'ephemeral';
    ttl?: '5m' | '1h';
  };
```

- [ ] **Step 3: 验证 TypeScript 编译**

运行:
```bash
pnpm typecheck
```

预期: TypeScript 编译通过,无类型错误

- [ ] **Step 4: Commit**

```bash
git add src/shared/types/settings.ts
git commit -m "feat(types): add Anthropic phase 1 config types

- Add invocationKwargs for extra API parameters
- Add anthropicBetas for beta features
- Add anthropicCacheControl (placeholder for future CallOptions support)"
```

---

## Task 2: 更新配置 Schema 验证

**Files:**
- Modify: `src/main/services/config/schema.ts`

- [ ] **Step 1: 定位 providerOptionsSchema 定义**

运行:
```bash
grep -n "providerOptionsSchema" src/main/services/config/schema.ts | head -1
```

预期: 找到 schema 定义的行号

- [ ] **Step 2: 在 providerOptionsSchema 中添加验证规则**

在 `providerOptionsSchema` 的末尾添加(现有字段之后):

```typescript
  invocationKwargs: z.record(z.unknown()).optional(),
  anthropicBetas: z.array(z.string()).optional(),
  anthropicCacheControl: z.object({
    type: z.literal('ephemeral'),
    ttl: z.enum(['5m', '1h']).optional()
  }).optional()
```

- [ ] **Step 3: 验证 TypeScript 编译**

运行:
```bash
pnpm typecheck
```

预期: TypeScript 编译通过

- [ ] **Step 4: Commit**

```bash
git add src/main/services/config/schema.ts
git commit -m "feat(config): add Anthropic phase 1 schema validation

- Add invocationKwargs validation (Record<string, unknown>)
- Add anthropicBetas validation (string array)
- Add anthropicCacheControl validation (ephemeral type with optional ttl)"
```

---

## Task 3: 添加 resolveAnthropicBetas 辅助函数测试

**Files:**
- Create: `src/main/services/langchain-model-factory.test.ts` (如果不存在)
- Modify: `src/main/services/langchain-model-factory.test.ts`

- [ ] **Step 1: 编写 resolveAnthropicBetas 的失败测试**

在测试文件中添加新的测试套件:

```typescript
describe('resolveAnthropicBetas', () => {
  it('应该过滤掉空字符串', () => {
    const betas = ['valid-beta', '', 'another-valid'];
    const resolved = resolveAnthropicBetas(betas);
    expect(resolved).toHaveLength(2);
    expect(resolved).toEqual(['valid-beta', 'another-valid']);
  });
  
  it('应该过滤掉只包含空格的字符串', () => {
    const betas = ['valid', '  ', '\t', 'also-valid'];
    const resolved = resolveAnthropicBetas(betas);
    expect(resolved).toHaveLength(2);
    expect(resolved).toEqual(['valid', 'also-valid']);
  });
  
  it('应该返回空数组当输入为空数组时', () => {
    const resolved = resolveAnthropicBetas([]);
    expect(resolved).toEqual([]);
  });
  
  it('应该保留所有有效的 beta 字符串', () => {
    const betas = ['prompt-caching-2024-07-31', 'pdfs-2024-09-25'];
    const resolved = resolveAnthropicBetas(betas);
    expect(resolved).toHaveLength(2);
    expect(resolved).toEqual(betas);
  });
});
```

- [ ] **Step 2: 运行测试,确认失败**

运行:
```bash
pnpm test src/main/services/langchain-model-factory.test.ts
```

预期: 测试失败,提示 `resolveAnthropicBetas is not defined`

- [ ] **Step 3: 在 langchain-model-factory.ts 中实现 resolveAnthropicBetas**

在文件末尾(所有辅助函数区域)添加:

```typescript
/**
 * 解析 Anthropic Beta 功能配置
 * 过滤掉空字符串和只包含空格的字符串
 */
function resolveAnthropicBetas(betas: string[]): string[] {
  const validBetas: string[] = [];
  
  for (const beta of betas) {
    if (typeof beta === 'string' && beta.trim().length > 0) {
      validBetas.push(beta);
    }
  }
  
  return validBetas;
}
```

- [ ] **Step 4: 运行测试,确认通过**

运行:
```bash
pnpm test src/main/services/langchain-model-factory.test.ts -t "resolveAnthropicBetas"
```

预期: 所有测试通过

- [ ] **Step 5: Commit**

```bash
git add src/main/services/langchain-model-factory.ts src/main/services/langchain-model-factory.test.ts
git commit -m "feat(langchain): add resolveAnthropicBetas helper

- Filter out empty and whitespace-only beta strings
- Return validated beta array for ChatAnthropic
- Add comprehensive unit tests"
```

---

## Task 4: 提取 buildAnthropicClientOptions 方法(TDD)

**Files:**
- Modify: `src/main/services/langchain-model-factory.ts`
- Modify: `src/main/services/langchain-model-factory.test.ts`

- [ ] **Step 1: 编写 buildAnthropicClientOptions 的失败测试**

在测试文件中添加:

```typescript
describe('LangChainModelFactory - buildAnthropicClientOptions', () => {
  let factory: LangChainModelFactory;
  
  beforeEach(() => {
    // 假设有工厂实例的创建代码
    // factory = new LangChainModelFactory(configService, secretService);
  });
  
  it('应该使用 provider.options.timeoutMs 当指定时', () => {
    const provider: ProviderConfig = {
      type: 'anthropic_compatible',
      options: {
        timeoutMs: 30000
      }
    } as ProviderConfig;
    
    const result = factory['buildAnthropicClientOptions'](provider, 60000);
    expect(result.timeout).toBe(30000);
    expect(result.maxRetries).toBe(0);
  });
  
  it('应该使用默认 timeout 当 provider.options.timeoutMs 未指定', () => {
    const provider: ProviderConfig = {
      type: 'anthropic_compatible',
      options: {}
    } as ProviderConfig;
    
    const result = factory['buildAnthropicClientOptions'](provider, 60000);
    expect(result.timeout).toBe(60000);
  });
  
  it('应该包含 defaultHeaders 当指定时', () => {
    const provider: ProviderConfig = {
      type: 'anthropic_compatible',
      options: {
        defaultHeaders: { 'X-Custom': 'value' }
      }
    } as ProviderConfig;
    
    const result = factory['buildAnthropicClientOptions'](provider, 60000);
    expect(result.defaultHeaders).toEqual({ 'X-Custom': 'value' });
  });
  
  it('应该不包含 defaultHeaders 当未指定时', () => {
    const provider: ProviderConfig = {
      type: 'anthropic_compatible',
      options: {}
    } as ProviderConfig;
    
    const result = factory['buildAnthropicClientOptions'](provider, 60000);
    expect(result.defaultHeaders).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试,确认失败**

运行:
```bash
pnpm test src/main/services/langchain-model-factory.test.ts -t "buildAnthropicClientOptions"
```

预期: 测试失败,提示方法不存在

- [ ] **Step 3: 实现 buildAnthropicClientOptions 私有方法**

在 `LangChainModelFactory` 类中添加私有方法:

```typescript
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

- [ ] **Step 4: 运行测试,确认通过**

运行:
```bash
pnpm test src/main/services/langchain-model-factory.test.ts -t "buildAnthropicClientOptions"
```

预期: 所有测试通过

- [ ] **Step 5: Commit**

```bash
git add src/main/services/langchain-model-factory.ts src/main/services/langchain-model-factory.test.ts
git commit -m "refactor(langchain): extract buildAnthropicClientOptions

- Extract ClientOptions building logic to separate method
- Support timeoutMs and defaultHeaders
- Add unit tests for all branches"
```

---

## Task 5: 提取 applyAnthropicSamplingParams 方法(TDD)

**Files:**
- Modify: `src/main/services/langchain-model-factory.ts`
- Modify: `src/main/services/langchain-model-factory.test.ts`

- [ ] **Step 1: 编写 applyAnthropicSamplingParams 的失败测试**

```typescript
describe('LangChainModelFactory - applyAnthropicSamplingParams', () => {
  let factory: LangChainModelFactory;
  
  it('应该应用所有指定的采样参数', () => {
    const config = {} as any;
    const options: ProviderOptions = {
      temperature: 0.7,
      maxTokens: 1000,
      topP: 0.9,
      topK: 10,
      stop: ['stop1', 'stop2']
    };
    
    factory['applyAnthropicSamplingParams'](config, options);
    
    expect(config.temperature).toBe(0.7);
    expect(config.maxTokens).toBe(1000);
    expect(config.topP).toBe(0.9);
    expect(config.topK).toBe(10);
    expect(config.stopSequences).toEqual(['stop1', 'stop2']);
  });
  
  it('应该跳过未定义的参数', () => {
    const config = {} as any;
    const options: ProviderOptions = {
      temperature: 0.7
    };
    
    factory['applyAnthropicSamplingParams'](config, options);
    
    expect(config.temperature).toBe(0.7);
    expect(config.maxTokens).toBeUndefined();
    expect(config.topP).toBeUndefined();
  });
  
  it('应该跳过空的 stop 数组', () => {
    const config = {} as any;
    const options: ProviderOptions = {
      stop: []
    };
    
    factory['applyAnthropicSamplingParams'](config, options);
    
    expect(config.stopSequences).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试,确认失败**

运行:
```bash
pnpm test src/main/services/langchain-model-factory.test.ts -t "applyAnthropicSamplingParams"
```

预期: 测试失败

- [ ] **Step 3: 实现 applyAnthropicSamplingParams 私有方法**

```typescript
/**
 * 应用采样参数到 Anthropic 配置
 */
private applyAnthropicSamplingParams(
  config: any,
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
```

- [ ] **Step 4: 运行测试,确认通过**

运行:
```bash
pnpm test src/main/services/langchain-model-factory.test.ts -t "applyAnthropicSamplingParams"
```

预期: 所有测试通过

- [ ] **Step 5: Commit**

```bash
git add src/main/services/langchain-model-factory.ts src/main/services/langchain-model-factory.test.ts
git commit -m "refactor(langchain): extract applyAnthropicSamplingParams

- Extract sampling parameters application to separate method
- Handle temperature, maxTokens, topP, topK, stop
- Add unit tests for all branches"
```

---

## Task 6: 实现 applyAnthropicPhase1Features 方法(TDD)

**Files:**
- Modify: `src/main/services/langchain-model-factory.ts`
- Modify: `src/main/services/langchain-model-factory.test.ts`

- [ ] **Step 1: 编写 applyAnthropicPhase1Features 的失败测试**

```typescript
describe('LangChainModelFactory - applyAnthropicPhase1Features', () => {
  let factory: LangChainModelFactory;
  
  it('应该应用 anthropicBetas', () => {
    const config = {} as any;
    const options: ProviderOptions = {
      anthropicBetas: ['prompt-caching-2024-07-31', 'pdfs-2024-09-25']
    };
    
    factory['applyAnthropicPhase1Features'](config, options);
    
    expect(config.betas).toEqual(['prompt-caching-2024-07-31', 'pdfs-2024-09-25']);
  });
  
  it('应该应用 invocationKwargs', () => {
    const config = {} as any;
    const options: ProviderOptions = {
      invocationKwargs: { metadata: { user_id: 'test' } }
    };
    
    factory['applyAnthropicPhase1Features'](config, options);
    
    expect(config.invocationKwargs).toEqual({ metadata: { user_id: 'test' } });
  });
  
  it('应该跳过未定义的第一阶段功能', () => {
    const config = {} as any;
    const options: ProviderOptions = {};
    
    factory['applyAnthropicPhase1Features'](config, options);
    
    expect(config.betas).toBeUndefined();
    expect(config.invocationKwargs).toBeUndefined();
  });
  
  it('应该过滤空的 beta 数组', () => {
    const config = {} as any;
    const options: ProviderOptions = {
      anthropicBetas: []
    };
    
    factory['applyAnthropicPhase1Features'](config, options);
    
    expect(config.betas).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试,确认失败**

运行:
```bash
pnpm test src/main/services/langchain-model-factory.test.ts -t "applyAnthropicPhase1Features"
```

预期: 测试失败

- [ ] **Step 3: 实现 applyAnthropicPhase1Features 私有方法**

```typescript
/**
 * 应用第一阶段功能到 Anthropic 配置
 */
private applyAnthropicPhase1Features(
  config: any,
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
```

- [ ] **Step 4: 运行测试,确认通过**

运行:
```bash
pnpm test src/main/services/langchain-model-factory.test.ts -t "applyAnthropicPhase1Features"
```

预期: 所有测试通过

- [ ] **Step 5: Commit**

```bash
git add src/main/services/langchain-model-factory.ts src/main/services/langchain-model-factory.test.ts
git commit -m "feat(langchain): add applyAnthropicPhase1Features

- Apply anthropicBetas with validation
- Apply invocationKwargs
- Add unit tests for all branches"
```

---

## Task 7: 创建 createAnthropicModel 方法(重构准备)

**Files:**
- Modify: `src/main/services/langchain-model-factory.ts:585-623`

- [ ] **Step 1: 复制现有的 Anthropic 分支代码作为基础**

找到 `createModelForProvider` 方法中第 585-623 行的 Anthropic 分支:

```typescript
if (provider.type === 'anthropic_compatible') {
  // 现有代码
}
```

- [ ] **Step 2: 创建新的 createAnthropicModel 私有方法**

在 `LangChainModelFactory` 类中添加:

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
  const providerOptions = provider.options ?? {};
  
  // 基础配置
  const config: any = {
    model: modelId,
    apiKey,
    anthropicApiUrl: baseUrl,
    streaming: options.streaming,
    maxRetries: 0,
    streamUsage: resolveStreamUsage(provider, options.streaming),
    clientOptions: this.buildAnthropicClientOptions(provider, options.requestTimeoutMs)
  };
  
  // 应用采样参数
  this.applyAnthropicSamplingParams(config, providerOptions);
  
  // Extended Thinking
  const thinking = resolveAnthropicThinking(providerOptions);
  if (thinking !== undefined) {
    config.thinking = thinking;
  }
  
  // 第一阶段新增功能
  this.applyAnthropicPhase1Features(config, providerOptions);
  
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

- [ ] **Step 3: 验证 TypeScript 编译**

运行:
```bash
pnpm typecheck
```

预期: 编译通过

- [ ] **Step 4: 在 createModelForProvider 中调用新方法**

替换 `createModelForProvider` 中的 Anthropic 分支(第 585-623 行):

```typescript
if (provider.type === 'anthropic_compatible') {
  const apiKey = this.resolveCredential(provider);
  return this.createAnthropicModel(provider, modelId, apiKey, {
    streaming,
    contextBudgetTokens,
    requestTimeoutMs
  });
}
```

- [ ] **Step 5: 运行所有测试,确认重构没有破坏现有功能**

运行:
```bash
pnpm test src/main/services/langchain-model-factory.test.ts
```

预期: 所有测试通过

- [ ] **Step 6: Commit**

```bash
git add src/main/services/langchain-model-factory.ts
git commit -m "refactor(langchain): extract createAnthropicModel method

- Move Anthropic model creation to dedicated method
- Use extracted helper methods for clean separation
- Apply phase 1 features (betas, invocationKwargs)
- No behavior changes, pure refactoring"
```

---

## Task 8: 添加端到端集成测试

**Files:**
- Modify: `src/main/services/langchain-model-factory.test.ts`

- [ ] **Step 1: 编写完整的 Phase 1 集成测试**

```typescript
describe('LangChainModelFactory - Anthropic Phase 1 Integration', () => {
  let factory: LangChainModelFactory;
  let configService: ConfigService;
  let secretService: SecretService;
  
  beforeEach(() => {
    // 初始化依赖(根据实际情况调整)
    // factory = new LangChainModelFactory(configService, secretService);
  });
  
  it('应该正确创建包含 invocationKwargs 的模型', async () => {
    const provider: ProviderConfig = {
      id: 'test',
      name: 'Test Anthropic',
      type: 'anthropic_compatible',
      endpoint: 'https://api.anthropic.com',
      credentialRef: 'secret:test',
      enabled: true,
      models: [
        { id: 'claude-sonnet-4-6', displayName: 'Test', enabled: true, supportsStreaming: true, supportsToolCalls: true }
      ],
      options: {
        maxTokens: 1000,
        invocationKwargs: {
          metadata: { user_id: 'test-user', session_id: 'test-session' }
        }
      }
    };
    
    const handle = await factory.createModelForProvider(provider, 'claude-sonnet-4-6');
    
    expect(handle.model).toHaveProperty('invocationKwargs');
    expect(handle.model.invocationKwargs).toEqual({
      metadata: { user_id: 'test-user', session_id: 'test-session' }
    });
    expect(handle.model.maxTokens).toBe(1000);
  });
  
  it('应该正确创建包含 betas 的模型', async () => {
    const provider: ProviderConfig = {
      id: 'test',
      name: 'Test Anthropic',
      type: 'anthropic_compatible',
      endpoint: 'https://api.anthropic.com',
      credentialRef: 'secret:test',
      enabled: true,
      models: [
        { id: 'claude-sonnet-4-6', displayName: 'Test', enabled: true, supportsStreaming: true, supportsToolCalls: true }
      ],
      options: {
        anthropicBetas: ['prompt-caching-2024-07-31', 'pdfs-2024-09-25']
      }
    };
    
    const handle = await factory.createModelForProvider(provider, 'claude-sonnet-4-6');
    
    expect(handle.model.betas).toHaveLength(2);
    expect(handle.model.betas).toContain('prompt-caching-2024-07-31');
    expect(handle.model.betas).toContain('pdfs-2024-09-25');
  });
  
  it('应该保持向后兼容性 - 不传新字段时行为不变', async () => {
    const provider: ProviderConfig = {
      id: 'test',
      name: 'Test Anthropic',
      type: 'anthropic_compatible',
      endpoint: 'https://api.anthropic.com',
      credentialRef: 'secret:test',
      enabled: true,
      models: [
        { id: 'claude-sonnet-4-6', displayName: 'Test', enabled: true, supportsStreaming: true, supportsToolCalls: true }
      ],
      options: {
        temperature: 0.7,
        maxTokens: 2000
      }
    };
    
    const handle = await factory.createModelForProvider(provider, 'claude-sonnet-4-6');
    
    expect(handle.model.temperature).toBe(0.7);
    expect(handle.model.maxTokens).toBe(2000);
    expect(handle.model.betas).toBeUndefined();
    expect(handle.model.invocationKwargs).toBeUndefined();
  });
  
  it('应该正确创建包含所有第一阶段功能的模型', async () => {
    const provider: ProviderConfig = {
      id: 'test',
      name: 'Test Anthropic',
      type: 'anthropic_compatible',
      endpoint: 'https://api.anthropic.com',
      credentialRef: 'secret:test',
      enabled: true,
      models: [
        { id: 'claude-opus-4-6', displayName: 'Test', enabled: true, supportsStreaming: true, supportsToolCalls: true }
      ],
      options: {
        temperature: 0.8,
        maxTokens: 4000,
        anthropicBetas: ['prompt-caching-2024-07-31'],
        anthropicThinking: { mode: 'adaptive' },
        invocationKwargs: {
          metadata: { app_version: '1.0.0' }
        }
      }
    };
    
    const handle = await factory.createModelForProvider(provider, 'claude-opus-4-6');
    
    expect(handle.model.temperature).toBe(0.8);
    expect(handle.model.maxTokens).toBe(4000);
    expect(handle.model.thinking).toEqual({ type: 'adaptive' });
    expect(handle.model.betas).toEqual(['prompt-caching-2024-07-31']);
    expect(handle.model.invocationKwargs).toEqual({ metadata: { app_version: '1.0.0' } });
  });
});
```

- [ ] **Step 2: 运行集成测试**

运行:
```bash
pnpm test src/main/services/langchain-model-factory.test.ts -t "Phase 1 Integration"
```

预期: 所有测试通过

- [ ] **Step 3: Commit**

```bash
git add src/main/services/langchain-model-factory.test.ts
git commit -m "test(langchain): add Anthropic phase 1 integration tests

- Test invocationKwargs end-to-end
- Test betas end-to-end
- Test backward compatibility
- Test combined phase 1 features"
```

---

## Task 9: 运行完整测试套件并验证

**Files:**
- N/A

- [ ] **Step 1: 运行完整的单元测试**

运行:
```bash
pnpm test
```

预期: 所有测试通过

- [ ] **Step 2: 检查测试覆盖率**

运行:
```bash
pnpm test --coverage
```

预期: langchain-model-factory.ts 覆盖率 ≥ 90%

- [ ] **Step 3: 运行 TypeScript 类型检查**

运行:
```bash
pnpm typecheck
```

预期: 无类型错误

- [ ] **Step 4: 手动测试 - 创建测试配置文件**

创建 `test-anthropic-phase1.json`:

```json
{
  "type": "anthropic_compatible",
  "endpoint": "https://api.anthropic.com",
  "options": {
    "maxTokens": 1000,
    "anthropicBetas": ["prompt-caching-2024-07-31"],
    "invocationKwargs": {
      "metadata": {
        "test_phase": "phase1",
        "test_date": "2026-06-04"
      }
    }
  }
}
```

- [ ] **Step 5: 最终 Commit**

```bash
git add .
git commit -m "chore: complete Anthropic provider phase 1 refactor

Phase 1 完成:
- ✅ 类型定义扩展 (invocationKwargs, betas)
- ✅ Schema 验证更新
- ✅ 代码结构重构 (createAnthropicModel, 辅助方法)
- ✅ 新功能实现 (betas, invocationKwargs)
- ✅ 完整测试覆盖 (单元测试 + 集成测试)
- ✅ 向后兼容性保证

测试覆盖率: ≥90%
破坏性变更: 无"
```

---

## 验收检查清单

完成所有任务后,执行以下验收检查:

- [ ] ✅ 所有单元测试通过
- [ ] ✅ 所有集成测试通过
- [ ] ✅ 测试覆盖率 ≥ 90%
- [ ] ✅ TypeScript 编译无错误
- [ ] ✅ 向后兼容性验证通过
- [ ] ✅ 新功能(betas, invocationKwargs)工作正常
- [ ] ✅ 代码已提交到 git
- [ ] ✅ 设计文档已更新(如有变更)

---

## 下一步

第一阶段完成后,可以进行:

1. **代码审查** - 请团队成员审查重构代码
2. **生产验证** - 在测试环境验证新功能
3. **第二阶段准备** - 基于第一阶段经验,规划第二阶段实施
4. **文档更新** - 更新用户文档,添加配置示例

---

**计划状态:** ✅ 已完成  
**预计工作量:** 7.5 天  
**下一个计划:** Anthropic Provider 重构 - 第二阶段




