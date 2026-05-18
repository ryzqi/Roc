import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { convertChunksToEvents } from '@langchain/core/language_models/compat';
import type { ChatModelStreamEvent } from '@langchain/core/language_models/event';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import { AIMessageChunk, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import type { Runnable } from '@langchain/core/runnables';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI, type ChatOpenAICallOptions } from '@langchain/openai';
import { fixedNvidiaBaseUrl } from '../../shared/provider-defaults';
import type { ProviderConfig, ProviderType } from '../../shared/types';
import type { ConfigService } from './config-service';
import { RocDomainError } from './errors';
import { providerRequestTimeoutMs } from './provider-request-retry';
import type { SecretService } from './secret-service';

export type LangChainModelRuntime = {
  providerType: ProviderType;
  baseUrl: string | null;
  streaming: boolean;
  modelKwargs: Record<string, unknown>;
};

export type LangChainChatModelHandle = {
  provider: ProviderConfig;
  model: BaseChatModel;
  modelId: string;
  runtime: LangChainModelRuntime;
};

type CreateModelOptions = {
  cacheTtl?: '5m' | '1h';
  streaming?: boolean;
};

const openAiNoAuthPlaceholderKey = 'roc-no-auth';

class ReasoningAwareChatOpenAI extends ChatOpenAI {
  async *_streamChatModelEvents(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun
  ): AsyncGenerator<ChatModelStreamEvent> {
    yield* convertChunksToEvents(
      normalizeOpenAiReasoningChunks(super._streamResponseChunks(messages, options, runManager)),
      {
        signal: options.signal
      }
    );
  }

  override withConfig(config: Partial<ChatOpenAICallOptions>): Runnable<BaseLanguageModelInput, AIMessageChunk, ChatOpenAICallOptions> {
    const newModel = new ReasoningAwareChatOpenAI(this.fields);
    newModel.defaultOptions = {
      ...this.defaultOptions,
      ...config
    };
    return newModel;
  }
}

export class LangChainModelFactory {
  constructor(
    private readonly configService: ConfigService,
    private readonly secretService: SecretService
  ) {}

  async createDefaultChatModel(options: CreateModelOptions = {}): Promise<LangChainChatModelHandle> {
    const defaultModelState = this.configService.getDefaultModelState();
    if (defaultModelState.status !== 'ready' || defaultModelState.modelId === null || defaultModelState.providerId === null) {
      throw this.configService.createDefaultModelError(defaultModelState);
    }

    const provider = this.resolveProviderById(defaultModelState.providerId);
    return await this.createModelForProvider(provider, defaultModelState.modelId, options);
  }

  async createProviderChatModel(providerId: string, options: CreateModelOptions = {}): Promise<LangChainChatModelHandle> {
    const provider = this.resolveProviderById(providerId);
    const model = provider.models.find((item) => item.enabled);
    if (model === undefined) {
      throw new RocDomainError({
        code: 'provider_model_missing',
        message: 'Provider 没有已启用模型。',
        category: 'validation',
        retryable: false,
        userAction: '请先为该 Provider 配置至少一个已启用模型。'
      });
    }
    return await this.createModelForProvider(provider, model.id, options);
  }

  async createChatModelByModelId(modelId: string, options: CreateModelOptions = {}): Promise<LangChainChatModelHandle> {
    const matches = this.configService
      .getProviders()
      .providers.filter((provider) => provider.models.some((candidate) => candidate.id === modelId));

    if (matches.length === 0) {
      throw new RocDomainError({
        code: 'provider_model_missing',
        message: '恢复运行需要的模型不存在或未启用。',
        category: 'validation',
        retryable: false,
        userAction: '请检查默认模型与 Provider 配置后重新发起本轮任务。'
      });
    }
    if (matches.length > 1) {
      throw new RocDomainError({
        code: 'provider_model_ambiguous',
        message: '恢复运行需要的模型映射到多个 Provider，无法确定恢复上下文。',
        category: 'validation',
        retryable: false,
        userAction: '请确保该模型 ID 只存在于一个已配置 Provider 中后重试。'
      });
    }

    return await this.createModelForProvider(matches[0]!, modelId, options);
  }

  async createModelForProvider(
    provider: ProviderConfig,
    modelId: string,
    options: CreateModelOptions = {}
  ): Promise<LangChainChatModelHandle> {
    if (!provider.enabled) {
      throw new RocDomainError({
        code: 'provider_disabled',
        message: 'Provider 未启用。',
        category: 'validation',
        retryable: false,
        userAction: '请先启用 Provider 后再发起调用。'
      });
    }

    const targetModel = provider.models.find((item) => item.id === modelId);
    if (targetModel === undefined || !targetModel.enabled) {
      throw new RocDomainError({
        code: 'provider_model_missing',
        message: 'Provider 模型不存在或未启用。',
        category: 'validation',
        retryable: false,
        userAction: '请从已启用模型列表中选择一个模型。'
      });
    }

    const apiKey = this.resolveCredential(provider);
    const temperature = provider.options?.temperature;
    const maxTokens = provider.options?.maxTokens;
    const streaming = options.streaming ?? true;

    if (provider.type === 'anthropic_compatible') {
      const baseUrl = this.normalizeAnthropicApiUrl(provider.endpoint);
      const cacheControl =
        options.cacheTtl === undefined
          ? undefined
          : {
              type: 'ephemeral' as const,
              ttl: options.cacheTtl
            };
      const model = new ChatAnthropic({
        model: modelId,
        apiKey,
        anthropicApiUrl: baseUrl,
        streaming,
        maxRetries: 0,
        temperature,
        maxTokens,
        clientOptions: {
          maxRetries: 0,
          timeout: providerRequestTimeoutMs
        }
      });
      if (cacheControl !== undefined) {
        const anthropicModelWithDefaults = model as ChatAnthropic & {
          defaultOptions?: {
            cache_control?: {
              type: 'ephemeral';
              ttl?: '5m' | '1h';
            };
          };
        };
        anthropicModelWithDefaults.defaultOptions = {
          ...anthropicModelWithDefaults.defaultOptions,
          cache_control: cacheControl
        };
      }
      return {
        provider,
        modelId,
        runtime: {
          providerType: provider.type,
          baseUrl,
          streaming,
          modelKwargs: {}
        },
        model
      };
    }

    if (provider.type !== 'openai_compatible' && provider.type !== 'nvidia' && provider.type !== 'llama_cpp') {
      throw new RocDomainError({
        code: 'provider_type_unsupported',
        message: '当前 Provider 类型尚未支持 LangChain 聊天执行。',
        category: 'external',
        retryable: false,
        userAction: '请先使用 OpenAI-compatible、Anthropic-compatible、NVIDIA 或 llama.cpp Provider。'
      });
    }

    const modelKwargs: Record<string, unknown> = {};
    if (provider.type === 'nvidia' && provider.options?.thinking === true) {
      modelKwargs.chat_template_kwargs = {
        thinking: true
      };
    }
    if (provider.type === 'llama_cpp') {
      modelKwargs.cache_prompt = true;
    }

    const baseUrl = provider.type === 'nvidia' ? fixedNvidiaBaseUrl : provider.endpoint.trim();
    const apiKeyForChatModel =
      provider.type === 'llama_cpp' && apiKey.length === 0 ? openAiNoAuthPlaceholderKey : apiKey;
    const openAiConfiguration =
      provider.type === 'llama_cpp' && apiKey.length === 0
        ? {
            baseURL: baseUrl,
            maxRetries: 0,
            fetch: createFetchWithoutAuthorization()
          }
        : {
            baseURL: baseUrl,
            maxRetries: 0
          };
    const chatModel = streaming ? new ReasoningAwareChatOpenAI({
      model: modelId,
      apiKey: apiKeyForChatModel,
      streaming,
      maxRetries: 0,
      temperature,
      maxTokens,
      timeout: providerRequestTimeoutMs,
      configuration: openAiConfiguration,
      modelKwargs
    }) : new ChatOpenAI({
      model: modelId,
      apiKey: apiKeyForChatModel,
      streaming,
      maxRetries: 0,
      temperature,
      maxTokens,
      timeout: providerRequestTimeoutMs,
      configuration: openAiConfiguration,
      modelKwargs
    });

    return {
      provider,
      modelId,
      runtime: {
        providerType: provider.type,
        baseUrl,
        streaming,
        modelKwargs
      },
      model: chatModel
    };
  }

  buildPromptMessages(input: string, capabilitySummary: string): [SystemMessage, HumanMessage] {
    return [
      new SystemMessage(`Roc capability boundary: ${capabilitySummary}`),
      new HumanMessage(input)
    ];
  }

  private resolveProviderById(providerId: string): ProviderConfig {
    const provider = this.configService.getProviders().providers.find((item) => item.id === providerId);
    if (provider === undefined) {
      throw new RocDomainError({
        code: 'provider_not_found',
        message: `找不到 Provider ${providerId}。`,
        category: 'not_found',
        retryable: false,
        userAction: '请刷新设置页后重试。'
      });
    }
    return provider;
  }

  private normalizeAnthropicApiUrl(endpoint: string): string {
    const url = new URL(endpoint.trim());
    const path = url.pathname.replace(/\/+$/, '');
    if (path.endsWith('/v1/messages')) {
      url.pathname = path.slice(0, -'/v1/messages'.length) || '/';
      return url.toString();
    }
    if (path.endsWith('/v1')) {
      url.pathname = path.slice(0, -'/v1'.length) || '/';
      return url.toString();
    }
    url.pathname = path.length === 0 ? '/' : path;
    return url.toString();
  }

  private resolveCredential(provider: ProviderConfig): string {
    const credentialRef = provider.credentialRef;
    if (credentialRef === null) {
      if (provider.type === 'llama_cpp') {
        return '';
      }
      throw new RocDomainError({
        code: 'provider_credential_missing',
        message: 'Provider 缺少凭据引用。',
        category: 'validation',
        retryable: false,
        userAction: '请在设置页为 Provider 录入 API Key 后再重试。'
      });
    }

    const trimmed = credentialRef.trim();
    if (trimmed.length === 0) {
      throw new RocDomainError({
        code: 'provider_credential_ref_invalid',
        message: 'Provider 凭据引用不能为空。',
        category: 'validation',
        retryable: false,
        userAction: '请在设置页重新配置 Provider 凭据。'
      });
    }
    if (!trimmed.startsWith('secret:')) {
      throw new RocDomainError({
        code: 'provider_credential_ref_unsupported',
        message: 'Provider 凭据引用必须为 secret:<providerId>。',
        category: 'validation',
        retryable: false,
        userAction: '请在设置页为 Provider 录入 API Key 以生成加密凭据。'
      });
    }

    const referencedProviderId = trimmed.slice('secret:'.length).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(referencedProviderId)) {
      throw new RocDomainError({
        code: 'provider_credential_ref_invalid',
        message: 'Provider 凭据引用的 providerId 含有不允许的字符。',
        category: 'validation',
        retryable: false,
        userAction: '请使用 secret:<providerId> 形式的凭据引用。'
      });
    }
    if (referencedProviderId !== provider.id) {
      throw new RocDomainError({
        code: 'provider_credential_ref_mismatch',
        message: 'Provider 凭据引用的 providerId 与 Provider 不匹配。',
        category: 'validation',
        retryable: false,
        userAction: '请在设置页重新录入该 Provider 的 API Key。'
      });
    }

    const value = this.secretService.getProviderSecret(provider.id);
    if (value.trim().length === 0) {
      throw new RocDomainError({
        code: 'provider_credential_unavailable',
        message: 'Provider 凭据未存储。',
        category: 'validation',
        retryable: false,
        userAction: '请在设置页为该 Provider 录入 API Key 后再发起调用。'
      });
    }
    if (/[\r\n]/.test(value)) {
      throw new RocDomainError({
        code: 'provider_credential_ref_invalid',
        message: 'Provider 凭据中包含非法换行字符。',
        category: 'validation',
        retryable: false,
        userAction: '请重新录入不含换行的 Provider API Key。'
      });
    }
    return value;
  }
}

function createFetchWithoutAuthorization(): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    const overrideHeaders = new Headers(init?.headers);
    overrideHeaders.forEach((value, key) => {
      headers.set(key, value);
    });
    headers.delete('authorization');
    headers.delete('Authorization');
    headers.delete('api-key');
    headers.delete('x-api-key');
    const nextInit = {
      ...init,
      headers
    };
    if (input instanceof Request) {
      return await globalThis.fetch(new Request(input, nextInit));
    }
    return await globalThis.fetch(input, nextInit);
  };
}

async function* normalizeOpenAiReasoningChunks(
  chunks: AsyncIterable<ChatGenerationChunk>
): AsyncGenerator<ChatGenerationChunk> {
  for await (const chunk of chunks) {
    const reasoningText = readProviderReasoningDelta(chunk.message);
    if (reasoningText === null || typeof chunk.message.content !== 'string' || hasExplicitReasoningBlocks(chunk.message.content)) {
      yield chunk;
      continue;
    }

    yield new ChatGenerationChunk({
      message: new AIMessageChunk({
        id: chunk.message.id,
        content: [
          {
            type: 'reasoning',
            index: 1,
            reasoning: reasoningText
          }
        ]
      }),
      text: '',
      generationInfo: {}
    });

    yield new ChatGenerationChunk({
      message: new AIMessageChunk({
        id: chunk.message.id,
        content: chunk.message.content,
        name: chunk.message.name,
        additional_kwargs: stripProviderReasoningDelta(chunk.message.additional_kwargs),
        response_metadata: chunk.message.response_metadata
      }),
      text: chunk.text,
      generationInfo: chunk.generationInfo
    });
  }
}

function readProviderReasoningDelta(message: ChatGenerationChunk['message']): string | null {
  const additionalKwargs = message.additional_kwargs;
  if (additionalKwargs === null || additionalKwargs === undefined || typeof additionalKwargs !== 'object') {
    return null;
  }

  const reasoningContent = additionalKwargs.reasoning_content;
  if (typeof reasoningContent === 'string' && reasoningContent.length > 0) {
    return reasoningContent;
  }

  const camelCaseReasoningContent = additionalKwargs.reasoningContent;
  if (typeof camelCaseReasoningContent === 'string' && camelCaseReasoningContent.length > 0) {
    return camelCaseReasoningContent;
  }

  return null;
}

function stripProviderReasoningDelta(additionalKwargs: unknown): Record<string, unknown> {
  if (additionalKwargs === null || additionalKwargs === undefined || typeof additionalKwargs !== 'object') {
    return {};
  }

  const { reasoning_content: _reasoningContent, reasoningContent: _camelCaseReasoningContent, ...rest } =
    additionalKwargs as Record<string, unknown>;
  return rest;
}

function hasExplicitReasoningBlocks(content: unknown): boolean {
  if (!Array.isArray(content)) {
    return false;
  }

  return content.some((item) => {
    if (item === null || typeof item !== 'object') {
      return false;
    }
    const type = item.type;
    return type === 'reasoning' || type === 'reasoning_content' || type === 'thinking';
  });
}
