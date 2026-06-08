/**
 * Provider 配置适配器 - 将 Roc 配置映射到 deepagents 模型
 *
 * 基于 deepagents 设计理念，统一不同供应商的配置映射
 */

import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ProviderConfig } from '../../../shared/types';
import { resolveNvidiaBaseUrl } from '../../../shared/provider-defaults';

/**
 * 根据供应商配置创建 LangChain 模型实例
 */
export function createModelFromProviderConfig(
  provider: ProviderConfig,
  credentials: { apiKey: string } | null
): BaseChatModel {
  const enabledModel = provider.models.find((m) => m.enabled);
  if (!enabledModel) {
    throw new Error(`Provider ${provider.id} has no enabled models`);
  }

  const apiKey = credentials?.apiKey ?? '';
  const options = provider.options ?? {};

  switch (provider.type) {
    case 'anthropic_compatible':
      return createAnthropicModel(provider, enabledModel.id, apiKey, options);

    case 'openai_compatible':
    case 'openrouter':
    case 'llama_cpp':
      return createOpenAIModel(provider, enabledModel.id, apiKey, options);

    case 'nvidia':
      return createNvidiaModel(provider, enabledModel.id, apiKey, options);

    default:
      throw new Error(`Unsupported provider type: ${provider.type}`);
  }
}

/**
 * 创建 Anthropic 模型实例
 */
function createAnthropicModel(
  provider: ProviderConfig,
  modelId: string,
  apiKey: string,
  options: Record<string, any>
): BaseChatModel {
  const thinking = options.anthropicThinking;

  return new ChatAnthropic({
    apiKey,
    model: modelId,
    anthropicApiUrl: provider.endpoint || undefined,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    topP: options.topP,
    topK: options.topK,
    stopSequences: options.stop,
    timeout: options.timeoutMs,
    defaultHeaders: options.defaultHeaders,
    clientOptions: {
      defaultHeaders: options.defaultHeaders,
    },
    // deepagents 原生支持 thinking
    ...(thinking && {
      thinking:
        thinking.mode === 'disabled'
          ? { type: 'disabled' as const }
          : thinking.mode === 'adaptive'
            ? { type: 'enabled' as const }
            : {
                type: 'enabled' as const,
                budget_tokens: thinking.budgetTokens,
              },
    }),
    // Beta features
    ...(options.anthropicBetas && {
      clientOptions: {
        defaultHeaders: {
          ...options.defaultHeaders,
          'anthropic-beta': options.anthropicBetas.join(','),
        },
      },
    }),
  }) as BaseChatModel;
}

/**
 * 创建 OpenAI 兼容模型实例
 */
function createOpenAIModel(
  provider: ProviderConfig,
  modelId: string,
  apiKey: string,
  options: Record<string, any>
): BaseChatModel {
  const config: Record<string, any> = {
    apiKey: apiKey || 'not-needed',
    model: modelId,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    topP: options.topP,
    frequencyPenalty: options.frequencyPenalty,
    presencePenalty: options.presencePenalty,
    seed: options.seed,
    stop: options.stop,
    timeout: options.timeoutMs,
  };

  // Base URL
  if (provider.endpoint) {
    config.configuration = {
      baseURL: provider.endpoint,
    };
  }

  // Organization
  if (options.organization) {
    config.organization = options.organization;
  }

  // Streaming
  if (options.streamUsage !== undefined) {
    config.streamUsage = options.streamUsage;
  }

  // Parallel tool calls
  if (options.parallelToolCalls !== undefined) {
    config.parallelToolCalls = options.parallelToolCalls;
  }

  // Service tier
  if (options.serviceTier) {
    config.serviceTier = options.serviceTier;
  }

  // Reasoning (o1/o3 models)
  if (options.reasoning) {
    config.reasoning = options.reasoning;
  }

  // Default headers
  if (options.defaultHeaders) {
    config.configuration = {
      ...config.configuration,
      defaultHeaders: options.defaultHeaders,
    };
  }

  return new ChatOpenAI(config) as BaseChatModel;
}

/**
 * 创建 NVIDIA 模型实例
 */
function createNvidiaModel(
  provider: ProviderConfig,
  modelId: string,
  apiKey: string,
  options: Record<string, any>
): BaseChatModel {
  const baseUrl = resolveNvidiaBaseUrl(provider);

  const config: Record<string, any> = {
    apiKey,
    model: modelId,
    configuration: {
      baseURL: baseUrl,
    },
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    topP: options.topP,
    seed: options.seed,
    stop: options.stop,
    timeout: options.timeoutMs,
  };

  // NVIDIA 专属参数
  if (options.topK !== undefined) {
    config.topK = options.topK;
  }

  if (options.minP !== undefined) {
    config.minP = options.minP;
  }

  if (options.frequencyPenalty !== undefined) {
    config.frequencyPenalty = options.frequencyPenalty;
  }

  if (options.presencePenalty !== undefined) {
    config.presencePenalty = options.presencePenalty;
  }

  if (options.repetitionPenalty !== undefined) {
    config.repetitionPenalty = options.repetitionPenalty;
  }

  if (options.thinking !== undefined) {
    config.thinking = options.thinking;
  }

  if (options.includeReasoning !== undefined) {
    config.includeReasoning = options.includeReasoning;
  }

  if (options.parallelToolCalls !== undefined) {
    config.parallelToolCalls = options.parallelToolCalls;
  }

  if (options.streamUsage !== undefined) {
    config.streamUsage = options.streamUsage;
  }

  if (options.toolChoice) {
    config.toolChoice = options.toolChoice;
  }

  // Guided generation
  if (options.guidedJson) {
    config.guidedJson = options.guidedJson;
  }

  if (options.guidedRegex) {
    config.guidedRegex = options.guidedRegex;
  }

  if (options.guidedChoice) {
    config.guidedChoice = options.guidedChoice;
  }

  if (options.guidedGrammar) {
    config.guidedGrammar = options.guidedGrammar;
  }

  // Default headers
  if (options.defaultHeaders) {
    config.configuration.defaultHeaders = options.defaultHeaders;
  }

  return new ChatOpenAI(config) as BaseChatModel;
}

/**
 * 验证供应商配置是否可用于创建模型
 */
export function validateProviderConfig(provider: ProviderConfig): {
  valid: boolean;
  error: string | null;
} {
  if (!provider.enabled) {
    return { valid: false, error: 'Provider 未启用' };
  }

  const enabledModel = provider.models.find((m) => m.enabled);
  if (!enabledModel) {
    return { valid: false, error: 'Provider 没有已启用的模型' };
  }

  if (provider.credentialRef && !provider.credentialRef.startsWith('secret:')) {
    return { valid: false, error: '无效的凭据引用格式' };
  }

  return { valid: true, error: null };
}
