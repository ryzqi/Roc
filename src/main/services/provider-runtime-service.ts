import type {
  EnabledCapabilities,
  ProviderConfig,
  ProviderTestResult
} from '../../shared/types';
import type { ConfigService } from './config-service';
import { RocDomainError } from './errors';
import { LangChainModelFactory } from './langchain-model-factory';
import type { MetricsService } from './metrics-service';
import {
  executeWithProviderRequestRetry,
  isRetryableProviderHttpStatus,
  providerRequestTimeoutMessage
} from './provider-request-retry';

type ProviderTransportRequest = {
  provider: ProviderConfig;
  modelId: string;
  input: string;
  capabilitySummary: string;
};

type ProviderTransportResponse = {
  content: string;
  finishReason: string;
  promptTokens?: number;
  completionTokens?: number;
};

type ProviderTransport = (request: ProviderTransportRequest) => ProviderTransportResponse | Promise<ProviderTransportResponse>;
const providerTestPrompt = 'Reply with OK only.';
const nvidiaProviderTestPrompt = 'What is 1+1? Reply with the number only.';

function providerTestPromptForProvider(provider: Pick<ProviderConfig, 'type'>): string {
  return provider.type === 'nvidia' ? nvidiaProviderTestPrompt : providerTestPrompt;
}

export class ProviderRuntimeService {
  private deterministicTransport: ProviderTransport | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly langChainModelFactory: LangChainModelFactory,
    private readonly metricsService: MetricsService
  ) {}

  setDeterministicResponse(response: ProviderTransportResponse): void {
    this.deterministicTransport = () => response;
  }

  setDeterministicFailure(error: RocDomainError): void {
    this.deterministicTransport = () => {
      throw error;
    };
  }

  async testProvider(request: { providerId: string; modelId: string }): Promise<ProviderTestResult> {
    const provider = this.resolveProviderById(request.providerId);
    const defaultModelState = this.configService.getDefaultModelState();
    const defaultModelReady =
      defaultModelState.status === 'ready' && defaultModelState.providerId === provider.id;
    const checked = ['id', 'type', 'enabled', 'models', 'credentials', 'transport'];

    if (!provider.enabled) {
      return {
        providerId: provider.id,
        status: 'invalid',
        defaultModelReady,
        checked,
        modelId: null,
        error: 'Provider 未启用。',
        latencyMs: null
      };
    }
    const targetModel = provider.models.find((model) => model.id === request.modelId);
    if (targetModel === undefined || !targetModel.enabled) {
      return {
        providerId: provider.id,
        status: 'invalid',
        defaultModelReady,
        checked,
        modelId: request.modelId,
        error: 'Provider 模型不存在或未启用。',
        latencyMs: null
      };
    }

    const startedAt = Date.now();
    if (provider.type === 'nvidia' && this.deterministicTransport === null) {
      try {
        const probe = await executeWithProviderRequestRetry(
          () =>
            this.langChainModelFactory.probeNvidiaTtfb(
              provider,
              targetModel.id,
              targetModel.options ?? {},
              providerTestPromptForProvider(provider)
            ),
          {
            labels: { providerId: provider.id, providerType: provider.type },
            metricsService: this.metricsService
          }
        );
        return {
          providerId: provider.id,
          status: 'ready',
          defaultModelReady,
          checked,
          modelId: targetModel.id,
          error: null,
          latencyMs: probe.latencyMs
        };
      } catch (error) {
        const safeError = this.toSafeProviderError(error);
        return {
          providerId: provider.id,
          status: 'invalid',
          defaultModelReady,
          checked,
          modelId: targetModel.id,
          error: safeError.message,
          latencyMs: Date.now() - startedAt
        };
      }
    }
    try {
      await executeWithProviderRequestRetry(
        async () => {
          const result = await this.executeTransportRequest({
            provider,
            modelId: targetModel.id,
            input: providerTestPromptForProvider(provider),
            capabilitySummary: this.createCapabilitySummary({
              mcpServers: [],
              skills: []
            })
          });
          this.requireResponseContent(result, provider);
          return result;
        },
        {
          labels: { providerId: provider.id, providerType: provider.type },
          metricsService: this.metricsService
        }
      );
      return {
        providerId: provider.id,
        status: 'ready',
        defaultModelReady,
        checked,
        modelId: targetModel.id,
        error: null,
        latencyMs: Date.now() - startedAt
      };
    } catch (error) {
      const safeError = this.toSafeProviderError(error);
      return {
        providerId: provider.id,
        status: 'invalid',
        defaultModelReady,
        checked,
        modelId: targetModel.id,
        error: safeError.message,
        latencyMs: Date.now() - startedAt
      };
    }
  }

  private resolveProviderById(providerId: string): ProviderConfig {
    const id = providerId.trim();
    if (id.length === 0) {
      throw new RocDomainError({
        code: 'provider_id_empty',
        message: 'Provider ID 不能为空。',
        category: 'validation',
        retryable: false,
        userAction: '请选择要测试的 provider。'
      });
    }

    const provider = this.configService.getProviders().providers.find((item) => item.id === id);
    if (provider === undefined) {
      throw new RocDomainError({
        code: 'provider_not_found',
        message: `找不到 Provider ${id}。`,
        category: 'not_found',
        retryable: false,
        userAction: '请刷新设置页后重试。'
      });
    }
    return provider;
  }

  private async executeTransportRequest(
    request: ProviderTransportRequest
  ): Promise<ProviderTransportResponse> {
    if (
      request.provider.type !== 'openai_compatible' &&
      request.provider.type !== 'openrouter' &&
      request.provider.type !== 'anthropic_compatible' &&
      request.provider.type !== 'nvidia' &&
      request.provider.type !== 'llama_cpp'
    ) {
      throw new RocDomainError({
        code: 'provider_type_unsupported',
        message: '当前 Provider 类型尚未支持测试或聊天执行。',
        category: 'external',
        retryable: false,
        userAction: '请先使用 OpenAI-compatible、OpenRouter、Anthropic-compatible、NVIDIA 或 llama.cpp Provider。'
      });
    }
    if (this.deterministicTransport !== null) {
      return await this.deterministicTransport(request);
    }
    return await this.executeLangChainRequest(request);
  }

  private requireResponseContent(response: ProviderTransportResponse, provider: ProviderConfig): string {
    const content = response.content.trim();
    if (content.length === 0) {
      // NVIDIA NIM 在部分模型（kimi-k2 等）上偶尔会返回空 content + finish_reason=stop，
      // 表示模型已正常停止但文本通道未输出。对探活而言这等同"连通成功"。
      if (provider.type === 'nvidia' && response.finishReason === 'stop') {
        return '';
      }
      throw new RocDomainError({
        code: 'provider_empty_response',
        message: 'Provider 返回了空回复。',
        category: 'external',
        retryable: true,
        userAction: '请稍后重试，或检查 Provider 模型配置。'
      });
    }
    return content;
  }

  private async executeLangChainRequest(request: ProviderTransportRequest): Promise<ProviderTransportResponse> {
    try {
      const runtime = await this.langChainModelFactory.createModelForProvider(request.provider, request.modelId, {
        streaming: false
      });
      const message = await runtime.model.invoke(
        this.langChainModelFactory.buildPromptMessages(request.input, request.capabilitySummary)
      );
      const content = this.readMessageText(message.content);
      const finishReason = this.readFinishReason(message.response_metadata);
      if (content.trim().length === 0 && finishReason === null) {
        throw this.createMalformedResponseErrorForProvider(request.provider);
      }
      const usageMetadata = this.isRecord(message.usage_metadata) ? message.usage_metadata : null;

      return {
        content,
        finishReason: finishReason ?? 'stop',
        promptTokens: this.readOptionalToken(usageMetadata?.input_tokens),
        completionTokens: this.readOptionalToken(usageMetadata?.output_tokens)
      };
    } catch (error) {
      throw this.toLangChainProviderError(error);
    }
  }

  private readMessageText(content: unknown): string {
    if (typeof content === 'string') {
      return content;
    }
    if (!Array.isArray(content)) {
      return '';
    }
    return content
      .map((block) => {
        if (typeof block === 'string') {
          return block;
        }
        if (this.isRecord(block) && typeof block.text === 'string') {
          return block.text;
        }
        return '';
      })
      .join('');
  }

  private readFinishReason(metadata: unknown): string | null {
    if (!this.isRecord(metadata)) {
      return null;
    }
    if (typeof metadata.finish_reason === 'string' && metadata.finish_reason.trim().length > 0) {
      return metadata.finish_reason;
    }
    if (typeof metadata.stop_reason === 'string' && metadata.stop_reason.trim().length > 0) {
      return metadata.stop_reason;
    }
    return null;
  }

  private createCapabilitySummary(capabilities: EnabledCapabilities): string {
    return [
      `mcp=${capabilities.mcpServers.join(',')}`,
      `skills=${capabilities.skills.join(',')}`,
      'tools_not_invoked=true',
      'untrusted_context_policy=external_content_reference_only'
    ].join(';');
  }

  private toSafeProviderError(error: unknown): RocDomainError {
    if (error instanceof RocDomainError) {
      return new RocDomainError({
        code: error.code,
        message: this.redact(error.message),
        category: error.category,
        retryable: error.retryable,
        userAction: error.userAction
      });
    }

    if (error instanceof Error) {
      return new RocDomainError({
        code: 'provider_execution_failed',
        message: this.redact(error.message),
        category: 'external',
        retryable: true,
        userAction: '请检查 Provider 网络、凭据和模型配置后重试。'
      });
    }

    return new RocDomainError({
      code: 'provider_execution_failed',
      message: 'Provider 执行失败。',
      category: 'external',
      retryable: true,
      userAction: '请检查 Provider 网络、凭据和模型配置后重试。'
    });
  }

  private toLangChainProviderError(error: unknown): RocDomainError {
    if (error instanceof RocDomainError) {
      return error;
    }
    if (this.isRecord(error)) {
      const status = this.readOptionalHttpStatus(error.status);
      if (status !== null) {
        return new RocDomainError({
          code: 'provider_http_error',
          message: this.createHttpErrorMessage(status, this.extractLangChainErrorDetail(error)),
          category: 'external',
          retryable: isRetryableProviderHttpStatus(status),
          userAction: '请检查 Provider endpoint、凭据、模型名称和服务状态后重试。'
        });
      }
    }
    if (error instanceof Error) {
      if (this.isLangChainTimeoutError(error)) {
        return new RocDomainError({
          code: 'provider_request_timeout',
          message: providerRequestTimeoutMessage,
          category: 'external',
          retryable: true,
          userAction: '请稍后重试，或检查 Provider endpoint 是否可访问。'
        });
      }
      if (this.isLangChainNetworkError(error)) {
        return new RocDomainError({
          code: 'provider_network_error',
          message: `Provider 网络请求失败：${this.redact(error.message)}`,
          category: 'external',
          retryable: true,
          userAction: '请检查 Provider 网络、endpoint 和本机代理设置后重试。'
        });
      }
      return new RocDomainError({
        code: 'provider_execution_failed',
        message: this.redact(error.message),
        category: 'external',
        retryable: true,
        userAction: '请检查 Provider 网络、凭据和模型配置后重试。'
      });
    }
    return new RocDomainError({
      code: 'provider_execution_failed',
      message: 'Provider 执行失败。',
      category: 'external',
      retryable: true,
      userAction: '请检查 Provider 网络、凭据和模型配置后重试。'
    });
  }

  private redact(value: string): string {
    return value
      .replace(/Authorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED]')
      .replace(/Authorization\s*:\s*[^,\n;]+/gi, '[REDACTED]')
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED]')
      .replace(/sk-[A-Za-z0-9._-]+/gi, '[REDACTED]')
      .replace(/(api[_-]?key|token|password|credential)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[REDACTED]');
  }

  private createHttpErrorMessage(status: number, responseText: string): string {
    const trimmed = responseText.trim();
    if (trimmed.length === 0) {
      return `Provider 请求失败：HTTP ${status}`;
    }
    return `Provider 请求失败：HTTP ${status} ${this.redact(trimmed).slice(0, 300)}`;
  }

  private readOptionalToken(value: unknown): number | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
      return value;
    }
    return undefined;
  }

  private readOptionalHttpStatus(value: unknown): number | null {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) {
      return value;
    }
    return null;
  }

  private extractLangChainErrorDetail(error: Record<string, unknown>): string {
    const nestedError = error.error;
    if (this.isRecord(nestedError)) {
      const nestedMessage = this.extractNestedErrorMessage(nestedError);
      if (nestedMessage !== null) {
        return nestedMessage;
      }
    }
    if (typeof error.message === 'string') {
      return error.message.replace(/\s+Troubleshooting URL:[\s\S]*$/u, '').trim();
    }
    return '';
  }

  private extractNestedErrorMessage(value: Record<string, unknown>): string | null {
    if (typeof value.message === 'string' && value.message.trim().length > 0) {
      return value.message.trim();
    }
    if (this.isRecord(value.error)) {
      return this.extractNestedErrorMessage(value.error);
    }
    return null;
  }

  private isLangChainTimeoutError(error: Error): boolean {
    return /timeout|timed out/i.test(error.message);
  }

  private isLangChainNetworkError(error: Error): boolean {
    return /connection error/i.test(error.message) || this.isRecord(error.cause) || /fetch failed/i.test(error.message);
  }

  private createMalformedResponseError(): RocDomainError {
    return new RocDomainError({
      code: 'provider_response_malformed',
      message: 'Provider 响应不符合 OpenAI-compatible chat completions 格式。',
      category: 'external',
      retryable: true,
      userAction: '请稍后重试，或检查 Provider endpoint 是否兼容 OpenAI chat completions。'
    });
  }

  private createAnthropicMalformedResponseError(): RocDomainError {
    return new RocDomainError({
      code: 'provider_response_malformed',
      message: 'Provider 响应不符合 Anthropic Messages 格式。',
      category: 'external',
      retryable: true,
      userAction: '请稍后重试，或检查 Provider endpoint 是否兼容 Anthropic Messages。'
    });
  }

  private createMalformedResponseErrorForProvider(provider: ProviderConfig): RocDomainError {
    return provider.type === 'anthropic_compatible'
      ? this.createAnthropicMalformedResponseError()
      : this.createMalformedResponseError();
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object') {
      return false;
    }
    if (value === null) {
      return false;
    }
    if (Array.isArray(value)) {
      return false;
    }
    return true;
  }
}
