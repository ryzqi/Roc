/**
 * 供应商配置类型系统 - 基于 deepagents 设计理念重构
 *
 * 核心改进：
 * 1. 分层配置：基础配置 + 通用参数 + 供应商专属参数
 * 2. 类型安全：使用判别联合类型，避免参数混淆
 * 3. 可扩展：新增供应商只需扩展联合类型
 */

import type { ProviderModel, ProviderType } from './settings';

// ============================================================================
// 基础配置
// ============================================================================

export type BaseProviderConfig = {
  id: string;
  name: string;
  enabled: boolean;
  models: ProviderModel[];
  endpoint: string;
  credentialRef: string | null;
};

// ============================================================================
// 通用参数（所有 provider 共享）
// ============================================================================

export type CommonProviderParams = {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  timeoutMs?: number;
  defaultHeaders?: Record<string, string>;
};

// ============================================================================
// OpenAI 专属参数
// ============================================================================

export type OpenAiReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type OpenAiReasoningSummary = 'auto' | 'concise' | 'detailed';
export type OpenAiServiceTier = 'auto' | 'default' | 'flex' | 'scale' | 'priority';
export type OpenAiVerbosity = 'low' | 'medium' | 'high';

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

// ============================================================================
// Anthropic 专属参数
// ============================================================================

export type AnthropicThinkingMode = 'disabled' | 'adaptive' | 'enabled';

export type AnthropicThinkingOption =
  | { mode: 'disabled' }
  | { mode: 'adaptive' }
  | { mode: 'enabled'; budgetTokens: number };

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

// ============================================================================
// NVIDIA 专属参数
// ============================================================================

export type NvidiaToolChoice =
  | 'auto'
  | 'required'
  | 'none'
  | { type: 'function'; function: { name: string } };

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
// 供应商配置联合类型
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
      params: OpenAIProviderParams;
    }
  | {
      type: 'llama_cpp';
      config: BaseProviderConfig;
      params: OpenAIProviderParams;
    };

// ============================================================================
// 类型守卫
// ============================================================================

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

// ============================================================================
// 配置转换工具
// ============================================================================

/**
 * 将旧的 ProviderConfig 转换为新的类型化配置
 */
export function toTypedProviderConfig(legacy: {
  id: string;
  name: string;
  type: ProviderType;
  enabled: boolean;
  models: ProviderModel[];
  endpoint: string;
  credentialRef: string | null;
  options?: Record<string, any>;
}): ProviderConfigTyped {
  const baseConfig: BaseProviderConfig = {
    id: legacy.id,
    name: legacy.name,
    enabled: legacy.enabled,
    models: legacy.models,
    endpoint: legacy.endpoint,
    credentialRef: legacy.credentialRef,
  };

  const opts = legacy.options ?? {};

  switch (legacy.type) {
    case 'anthropic_compatible': {
      const thinking = opts.anthropicThinking as AnthropicThinkingOption | undefined;
      return {
        type: 'anthropic_compatible',
        config: baseConfig,
        params: {
          temperature: opts.temperature,
          maxTokens: opts.maxTokens,
          topP: opts.topP,
          topK: opts.topK,
          timeoutMs: opts.timeoutMs,
          defaultHeaders: opts.defaultHeaders,
          stopSequences: opts.stop,
          thinking,
          betas: opts.anthropicBetas,
          invocationKwargs: opts.invocationKwargs,
        },
      };
    }

    case 'nvidia': {
      return {
        type: 'nvidia',
        config: baseConfig,
        params: {
          temperature: opts.temperature,
          maxTokens: opts.maxTokens,
          topP: opts.topP,
          topK: opts.topK,
          minP: opts.minP,
          frequencyPenalty: opts.frequencyPenalty,
          presencePenalty: opts.presencePenalty,
          repetitionPenalty: opts.repetitionPenalty,
          seed: opts.seed,
          stop: opts.stop,
          timeoutMs: opts.timeoutMs,
          defaultHeaders: opts.defaultHeaders,
          thinking: opts.thinking,
          includeReasoning: opts.includeReasoning,
          parallelToolCalls: opts.parallelToolCalls,
          streamUsage: opts.streamUsage,
          toolChoice: opts.toolChoice,
          guidedJson: opts.guidedJson,
          guidedRegex: opts.guidedRegex,
          guidedChoice: opts.guidedChoice,
          guidedGrammar: opts.guidedGrammar,
          endpointOverride: opts.endpointOverride,
        },
      };
    }

    case 'openai_compatible':
    case 'openrouter':
    case 'llama_cpp':
    default: {
      return {
        type: legacy.type as 'openai_compatible' | 'openrouter' | 'llama_cpp',
        config: baseConfig,
        params: {
          temperature: opts.temperature,
          maxTokens: opts.maxTokens,
          topP: opts.topP,
          frequencyPenalty: opts.frequencyPenalty,
          presencePenalty: opts.presencePenalty,
          seed: opts.seed,
          stop: opts.stop,
          timeoutMs: opts.timeoutMs,
          defaultHeaders: opts.defaultHeaders,
          organization: opts.organization,
          parallelToolCalls: opts.parallelToolCalls,
          streamUsage: opts.streamUsage,
          serviceTier: opts.serviceTier,
          verbosity: opts.verbosity,
          zdrEnabled: opts.zdrEnabled,
          useResponsesApi: opts.useResponsesApi,
          reasoning: opts.reasoning,
        },
      };
    }
  }
}

/**
 * 将类型化配置转换回旧格式（兼容性）
 */
export function fromTypedProviderConfig(typed: ProviderConfigTyped): {
  id: string;
  name: string;
  type: ProviderType;
  enabled: boolean;
  models: ProviderModel[];
  endpoint: string;
  credentialRef: string | null;
  options?: Record<string, any>;
} {
  return {
    ...typed.config,
    type: typed.type,
    options: typed.params as Record<string, any>,
  };
}
