import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import { fixedNvidiaBaseUrl } from '../../shared/provider-defaults';
import type { ProviderConfig, ProviderType } from '../../shared/types';
import type { ConfigService } from './config-service';
import { RocDomainError } from './errors';
import type { SecretService } from './secret-service';

const langChainRequestTimeoutMs = 30_000;

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
  streaming?: boolean;
};

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
      return {
        provider,
        modelId,
        runtime: {
          providerType: provider.type,
          baseUrl,
          streaming,
          modelKwargs: {}
        },
        model: new ChatAnthropic({
          model: modelId,
          apiKey,
          anthropicApiUrl: baseUrl,
          streaming,
          maxRetries: 0,
          temperature,
          maxTokens,
          clientOptions: {
            maxRetries: 0,
            timeout: langChainRequestTimeoutMs
          }
        })
      };
    }

    if (provider.type !== 'openai_compatible' && provider.type !== 'nvidia') {
      throw new RocDomainError({
        code: 'provider_type_unsupported',
        message: '当前 Provider 类型尚未支持 LangChain 聊天执行。',
        category: 'external',
        retryable: false,
        userAction: '请先使用 OpenAI-compatible、Anthropic-compatible 或 NVIDIA Provider。'
      });
    }

    const modelKwargs: Record<string, unknown> = {};
    if (provider.type === 'nvidia' && provider.options?.thinking === true) {
      modelKwargs.chat_template_kwargs = {
        thinking: true
      };
    }

    const baseUrl = provider.type === 'nvidia' ? fixedNvidiaBaseUrl : provider.endpoint.trim();
    return {
      provider,
      modelId,
      runtime: {
        providerType: provider.type,
        baseUrl,
        streaming,
        modelKwargs
      },
      model: new ChatOpenAI({
        model: modelId,
        apiKey,
        streaming,
        maxRetries: 0,
        temperature,
        maxTokens,
        timeout: langChainRequestTimeoutMs,
        configuration: {
          baseURL: baseUrl,
          maxRetries: 0
        },
        modelKwargs
      })
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
