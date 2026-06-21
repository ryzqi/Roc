import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatAnthropic, type ChatAnthropicInput } from '@langchain/anthropic';
import { ChatOpenAI, type ChatOpenAIFields } from '@langchain/openai';
import { resolveNvidiaBaseUrl } from '../../shared/provider-defaults';
import { type ProviderConfig, type ProviderOptions, type ProviderType } from '../../shared/types';
import { toTypedProviderConfig } from '../../shared/types/provider-config';
import type { ConfigService } from './config-service';
import { RocDomainError } from './errors';
import {
  LlamaCppCompatibleChatOpenAI,
  NvidiaCompatibleChatOpenAI,
  ReasoningAwareChatOpenAI
} from './langchain-openai-compatible-models';
import { probeNvidiaTtfb } from './langchain-nvidia-probe';
import {
  applyOpenAiCompatibleDefaultOptions,
  buildLlamaCppSamplingModelKwargs,
  buildNvidiaModelKwargs,
  createFetchWithoutAuthorization,
  isLangChainProviderType,
  resolveAnthropicBetas,
  resolveAnthropicThinking,
  resolveLlamaCppSamplingProfile,
  resolveOpenAiCompatibleDefaultOptions,
  resolveStreamUsage,
  type ModelFactoryLogService
} from './langchain-provider-options';
import { providerRequestTimeoutMs } from './provider-request-retry';
import type { SecretService } from './secret-service';

export { resolveAnthropicBetas };

export type LangChainModelRuntime = {
  providerType: ProviderType;
  baseUrl: string | null;
  streaming: boolean;
  modelKwargs: Record<string, unknown>;
  contextBudgetTokens: number;
};

export type LangChainChatModelHandle = {
  provider: ProviderConfig;
  model: BaseChatModel;
  modelId: string;
  runtime: LangChainModelRuntime;
};

type CreateModelOptions = {
  streaming?: boolean;
};

type AnthropicClientOptions = NonNullable<ChatAnthropicInput['clientOptions']>;

const openAiNoAuthPlaceholderKey = 'roc-no-auth';
const llamaCppProviderRequestTimeoutMs = 600_000;

function warnIfAnthropicCacheControlConfigured(model: ChatAnthropic, logService: ModelFactoryLogService | null): void {
  const defaultOptions = (model as ChatAnthropic & {
    defaultOptions?: {
      cache_control?: unknown;
    };
  }).defaultOptions;
  if (defaultOptions?.cache_control !== undefined) {
    logService?.warn('Anthropic model retained cache_control defaults.', {
      service: 'langchain-model-factory',
      component: 'warnIfAnthropicCacheControlConfigured'
    });
  }
}

export class LangChainModelFactory {
  constructor(
    private readonly configService: ConfigService,
    private readonly secretService: SecretService,
    private readonly logService: ModelFactoryLogService | null = null
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

  resolveCheapModelHandle(activeHandle: LangChainChatModelHandle): LangChainChatModelHandle {
    return activeHandle;
  }

  private buildAnthropicClientOptions(provider: ProviderConfig, timeoutMs: number): AnthropicClientOptions {
    const providerTimeoutMs = provider.options?.timeoutMs;
    const clientOptions: AnthropicClientOptions = {
      maxRetries: 0,
      timeout: providerTimeoutMs === undefined ? timeoutMs : providerTimeoutMs
    };
    if (provider.options?.defaultHeaders !== undefined) {
      clientOptions.defaultHeaders = provider.options.defaultHeaders;
    }
    return clientOptions;
  }

  private applyAnthropicSamplingParams(config: ChatAnthropicInput, options: ProviderOptions): void {
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

  private applyAnthropicPhase1Features(config: ChatAnthropicInput, options: ProviderOptions): void {
    if (options.anthropicBetas !== undefined) {
      const betas = resolveAnthropicBetas(options.anthropicBetas);
      if (betas.length > 0) {
        config.betas = betas as NonNullable<ChatAnthropicInput['betas']>;
      }
    }
    if (options.invocationKwargs !== undefined) {
      config.invocationKwargs = options.invocationKwargs;
    }
  }

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
    const providerOptions = provider.options === undefined ? {} : provider.options;
    const config: ChatAnthropicInput = {
      model: modelId,
      apiKey,
      anthropicApiUrl: baseUrl,
      streaming: options.streaming,
      maxRetries: 0,
      streamUsage: resolveStreamUsage(provider, options.streaming),
      clientOptions: this.buildAnthropicClientOptions(provider, options.requestTimeoutMs)
    };
    this.applyAnthropicSamplingParams(config, providerOptions);
    const thinking = resolveAnthropicThinking(providerOptions);
    if (thinking !== undefined) {
      config.thinking = thinking;
    }
    this.applyAnthropicPhase1Features(config, providerOptions);
    const model = new ChatAnthropic(config);
    warnIfAnthropicCacheControlConfigured(model, this.logService);
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
    const typedProvider = isLangChainProviderType(provider.type) ? toTypedProviderConfig(provider) : null;
    const llamaCppSamplingProfile =
      provider.type === 'llama_cpp' ? resolveLlamaCppSamplingProfile(provider, modelId, this.logService) : null;
    const llamaCppParams = typedProvider?.type === 'llama_cpp' ? typedProvider.params : null;
    const temperature =
      provider.type === 'llama_cpp'
        ? llamaCppParams?.temperature ?? llamaCppSamplingProfile?.temperature
        : provider.options?.temperature;
    const maxTokens = provider.options?.maxTokens;
    const requestedStreaming = options.streaming ?? true;
    const streaming = provider.type === 'llama_cpp' ? true : requestedStreaming;
    const requestTimeoutMs = provider.type === 'llama_cpp' ? llamaCppProviderRequestTimeoutMs : providerRequestTimeoutMs;
    const contextBudgetTokens = llamaCppParams?.contextBudgetTokens ?? provider.options?.contextBudgetTokens ?? 8192;

    if (provider.type === 'anthropic_compatible') {
      return this.createAnthropicModel(provider, modelId, apiKey, {
        streaming,
        contextBudgetTokens,
        requestTimeoutMs
      });
    }

    if (
      provider.type !== 'openai_compatible' &&
      provider.type !== 'openrouter' &&
      provider.type !== 'nvidia' &&
      provider.type !== 'llama_cpp'
    ) {
      throw new RocDomainError({
        code: 'provider_type_unsupported',
        message: '当前 Provider 类型尚未支持 LangChain 聊天执行。',
        category: 'external',
        retryable: false,
        userAction: '请先使用 OpenAI-compatible、OpenRouter、Anthropic-compatible、NVIDIA 或 llama.cpp Provider。'
      });
    }

    const modelKwargs: Record<string, unknown> = {};
    if (typedProvider?.type === 'openai_compatible') {
      Object.assign(modelKwargs, typedProvider.params.modelKwargs);
    }
    if (typedProvider?.type === 'nvidia') {
      Object.assign(modelKwargs, buildNvidiaModelKwargs(modelId, typedProvider.params, streaming));
    }
    if (typedProvider?.type === 'llama_cpp') {
      modelKwargs.cache_prompt = true;
      Object.assign(modelKwargs, buildLlamaCppSamplingModelKwargs(typedProvider.params, llamaCppSamplingProfile));
    }

    const baseUrl = provider.type === 'nvidia' ? resolveNvidiaBaseUrl(provider) : provider.endpoint.trim();
    const apiKeyForChatModel =
      provider.type === 'llama_cpp' && apiKey.length === 0 ? openAiNoAuthPlaceholderKey : apiKey;
    const defaultHeaders =
      provider.type === 'openrouter'
        ? {
            'HTTP-Referer': 'https://github.com/roc-ai/roc',
            'X-OpenRouter-Title': 'Roc'
          }
        : provider.type === 'openai_compatible'
          ? provider.options?.defaultHeaders
          : undefined;
    const openAiRequestTimeoutMs =
      provider.type === 'openai_compatible' ? provider.options?.timeoutMs ?? requestTimeoutMs : requestTimeoutMs;
    const openAiParams = typedProvider?.type === 'openai_compatible' ? typedProvider.params : null;
    const openAiDefaultOptions = resolveOpenAiCompatibleDefaultOptions(openAiParams);
    const openAiReasoning = openAiParams?.reasoning;
    const openAiOrganization =
      provider.type === 'openai_compatible' ? openAiParams?.organization?.trim() ?? '' : '';
    const openAiUseResponsesApi = provider.type === 'openai_compatible' ? openAiParams?.useResponsesApi : undefined;
    const openAiServiceTier = provider.type === 'openai_compatible' ? openAiParams?.serviceTier : undefined;
    const openAiVerbosity = provider.type === 'openai_compatible' ? openAiParams?.verbosity : undefined;
    const openAiZdrEnabled = provider.type === 'openai_compatible' ? openAiParams?.zdrEnabled : undefined;
    const openAiTopP = provider.type === 'llama_cpp' ? llamaCppParams?.topP ?? llamaCppSamplingProfile?.topP : provider.options?.topP;
    const openAiPresencePenalty =
      provider.type === 'llama_cpp'
        ? llamaCppParams?.presencePenalty ?? llamaCppSamplingProfile?.presencePenalty
        : provider.options?.presencePenalty;
    const openAiStop = provider.type === 'openai_compatible' ? openAiParams?.stop : undefined;
    const openAiFrequencyPenalty = provider.type === 'openai_compatible' ? openAiParams?.frequencyPenalty : undefined;
    const openAiConfiguration =
      provider.type === 'llama_cpp' && apiKey.length === 0
        ? {
            baseURL: baseUrl,
            maxRetries: 0,
            fetch: createFetchWithoutAuthorization()
          }
        : {
            baseURL: baseUrl,
            maxRetries: 0,
            ...(openAiOrganization.length === 0 ? {} : { organization: openAiOrganization }),
            ...(defaultHeaders === undefined ? {} : { defaultHeaders })
          };
    const OpenAiChatModelClass =
      provider.type === 'llama_cpp'
        ? LlamaCppCompatibleChatOpenAI
        : ReasoningAwareChatOpenAI;
    const chatModelFields: ChatOpenAIFields = {
      model: modelId,
      apiKey: apiKeyForChatModel,
      streaming,
      streamUsage: resolveStreamUsage(provider, streaming),
      maxRetries: 0,
      temperature,
      topP: openAiTopP,
      presencePenalty: openAiPresencePenalty,
      frequencyPenalty: openAiFrequencyPenalty,
      stop: openAiStop,
      maxTokens,
      timeout: openAiRequestTimeoutMs,
      configuration: openAiConfiguration,
      ...(openAiUseResponsesApi === undefined ? {} : { useResponsesApi: openAiUseResponsesApi }),
      ...(openAiReasoning === undefined ? {} : { reasoning: openAiReasoning }),
      ...(openAiServiceTier === undefined ? {} : { service_tier: openAiServiceTier }),
      ...(openAiVerbosity === undefined ? {} : { verbosity: openAiVerbosity }),
      ...(openAiZdrEnabled === undefined ? {} : { zdrEnabled: openAiZdrEnabled }),
      modelKwargs
    };
    const chatModel =
      provider.type === 'nvidia'
        ? new NvidiaCompatibleChatOpenAI(chatModelFields, { modelId, providerOptions: provider.options })
        : streaming
          ? new OpenAiChatModelClass(chatModelFields)
          : new ChatOpenAI(chatModelFields);
    applyOpenAiCompatibleDefaultOptions(chatModel, openAiDefaultOptions);

    return {
      provider,
      modelId,
      runtime: {
        providerType: provider.type,
        baseUrl,
        streaming,
        modelKwargs,
        contextBudgetTokens
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

  /**
   * NVIDIA NIM 探活：发起一次最小 chat/completions 流式请求，收到非空文本 delta 才视为连通。
   * 不复用 ChatOpenAI / LangChain，避免 SDK 等待完整 LangChain 消息。30 秒客户端硬超时。
   */
  async probeNvidiaTtfb(
    provider: ProviderConfig,
    modelId: string,
    prompt: string,
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<{ latencyMs: number }> {
    return await probeNvidiaTtfb({
      provider,
      modelId,
      prompt,
      apiKey: this.resolveCredential(provider),
      logService: this.logService,
      options
    });
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
