import type { EnabledCapabilities, ProviderConfig, ProviderExecutionResult } from '../../shared/types';
import type { ConfigService } from './config-service';
import { RocDomainError } from './errors';

export type ProviderRuntimeRequest = {
  input: string;
  enabledCapabilities: EnabledCapabilities;
};

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

type OpenAiCompatibleRequestBody = {
  model: string;
  stream: false;
  messages: Array<{
    role: 'system' | 'user';
    content: string;
  }>;
};

const providerRequestTimeoutMs = 30_000;

export class ProviderRuntimeService {
  private deterministicTransport: ProviderTransport | null = null;

  constructor(private readonly configService: ConfigService) {}

  setDeterministicResponse(response: ProviderTransportResponse): void {
    this.deterministicTransport = () => response;
  }

  setDeterministicFailure(error: RocDomainError): void {
    this.deterministicTransport = () => {
      throw error;
    };
  }

  async executeChat(request: ProviderRuntimeRequest): Promise<ProviderExecutionResult> {
    const input = request.input.trim();
    if (input.length === 0) {
      throw new RocDomainError({
        code: 'provider_input_empty',
        message: 'Provider 输入不能为空。',
        category: 'validation',
        retryable: false,
        userAction: '请输入要发送给模型的内容。'
      });
    }

    const resolved = this.resolveDefaultProvider();
    if (resolved.provider.type !== 'openai_compatible') {
      throw new RocDomainError({
        code: 'provider_type_unsupported',
        message: '当前 Provider 类型尚未支持聊天执行。',
        category: 'external',
        retryable: false,
        userAction: '请先使用 OpenAI-compatible Provider，或等待后续 Provider 映射支持。'
      });
    }

    const startedAt = Date.now();
    const capabilitySummary = this.createCapabilitySummary(request.enabledCapabilities);
    let response: ProviderTransportResponse;
    try {
      if (this.deterministicTransport === null) {
        response = await this.executeOpenAiCompatible({
          provider: resolved.provider,
          modelId: resolved.modelId,
          input,
          capabilitySummary
        });
      } else {
        response = await this.deterministicTransport({
          provider: resolved.provider,
          modelId: resolved.modelId,
          input,
          capabilitySummary
        });
      }
    } catch (error) {
      throw this.toSafeProviderError(error);
    }

    const content = response.content.trim();
    if (content.length === 0) {
      throw new RocDomainError({
        code: 'provider_empty_response',
        message: 'Provider 返回了空回复。',
        category: 'external',
        retryable: true,
        userAction: '请稍后重试，或检查 Provider 模型配置。'
      });
    }

    const promptTokens = response.promptTokens === undefined ? null : response.promptTokens;
    const completionTokens = response.completionTokens === undefined ? null : response.completionTokens;

    return {
      providerId: resolved.provider.id,
      modelId: resolved.modelId,
      assistantMessage: content,
      createdAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      finishReason: response.finishReason,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens === null || completionTokens === null ? null : promptTokens + completionTokens,
        promptCharacters: input.length + capabilitySummary.length,
        completionCharacters: content.length
      },
      summary: `${resolved.provider.id}:${resolved.modelId}:${response.finishReason}`
    };
  }

  private resolveDefaultProvider(): { provider: ProviderConfig; modelId: string } {
    const defaultModelState = this.configService.getDefaultModelState();
    if (defaultModelState.status !== 'ready' || defaultModelState.modelId === null || defaultModelState.providerId === null) {
      throw this.configService.createDefaultModelError(defaultModelState);
    }

    const provider = this.configService.getProviders().providers.find((item) => item.id === defaultModelState.providerId);
    if (provider === undefined) {
      throw new RocDomainError({
        code: 'provider_not_found',
        message: '默认模型所属 Provider 不存在。',
        category: 'not_found',
        retryable: false,
        userAction: '请在设置页重新选择默认模型。'
      });
    }

    return {
      provider,
      modelId: defaultModelState.modelId
    };
  }

  private async executeOpenAiCompatible(request: ProviderTransportRequest): Promise<ProviderTransportResponse> {
    const apiKey = this.resolveCredential(request.provider.credentialRef);
    const url = this.buildChatCompletionsUrl(request.provider.endpoint);
    const body: OpenAiCompatibleRequestBody = {
      model: request.modelId,
      stream: false,
      messages: [
        {
          role: 'system',
          content: `Roc capability boundary: ${request.capabilitySummary}`
        },
        {
          role: 'user',
          content: request.input
        }
      ]
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, providerRequestTimeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const responseText = await response.text();
      if (!response.ok) {
        throw new RocDomainError({
          code: 'provider_http_error',
          message: this.createHttpErrorMessage(response.status, responseText),
          category: 'external',
          retryable: this.isRetryableHttpStatus(response.status),
          userAction: '请检查 Provider endpoint、凭据、模型名称和服务状态后重试。'
        });
      }
      return this.parseOpenAiCompatibleResponse(responseText);
    } catch (error) {
      if (error instanceof RocDomainError) {
        throw error;
      }
      if (this.isAbortError(error)) {
        throw new RocDomainError({
          code: 'provider_request_timeout',
          message: 'Provider 请求超时。',
          category: 'external',
          retryable: true,
          userAction: '请稍后重试，或检查 Provider endpoint 是否可访问。'
        });
      }
      throw new RocDomainError({
        code: 'provider_network_error',
        message: error instanceof Error ? `Provider 网络请求失败：${this.redact(error.message)}` : 'Provider 网络请求失败。',
        category: 'external',
        retryable: true,
        userAction: '请检查 Provider 网络、endpoint 和本机代理设置后重试。'
      });
    } finally {
      clearTimeout(timeout);
    }
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

  private redact(value: string): string {
    return value
      .replace(/Authorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED]')
      .replace(/Authorization\s*:\s*[^,\n;]+/gi, '[REDACTED]')
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED]')
      .replace(/sk-[A-Za-z0-9._-]+/gi, '[REDACTED]')
      .replace(/(api[_-]?key|token|password|credential)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[REDACTED]');
  }

  private resolveCredential(credentialRef: string | null): string {
    if (credentialRef === null) {
      throw new RocDomainError({
        code: 'provider_credential_missing',
        message: 'Provider 缺少凭据引用。',
        category: 'validation',
        retryable: false,
        userAction: '请在设置页为 Provider 配置凭据后再重试。'
      });
    }

    const trimmed = credentialRef.trim();
    if (trimmed.length === 0) {
      throw new RocDomainError({
        code: 'provider_credential_ref_invalid',
        message: 'Provider 凭据引用不能为空。',
        category: 'validation',
        retryable: false,
        userAction: '请在设置页重新配置 Provider 凭据引用。'
      });
    }
    if (!trimmed.startsWith('env:')) {
      throw new RocDomainError({
        code: 'provider_credential_ref_unsupported',
        message: '当前 live Provider 只支持 env:VAR_NAME 凭据引用。',
        category: 'validation',
        retryable: false,
        userAction: '请把 Provider 凭据引用配置为 env:VAR_NAME，或等待后续安全凭据存储支持。'
      });
    }

    const envName = trimmed.slice('env:'.length).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
      throw new RocDomainError({
        code: 'provider_credential_ref_invalid',
        message: 'Provider 环境变量凭据引用格式无效。',
        category: 'validation',
        retryable: false,
        userAction: '请使用 env:VAR_NAME 格式配置 Provider 凭据引用。'
      });
    }

    const value = process.env[envName];
    if (value === undefined || value.trim().length === 0) {
      throw new RocDomainError({
        code: 'provider_credential_unavailable',
        message: `Provider 凭据环境变量 ${envName} 不存在或为空。`,
        category: 'validation',
        retryable: false,
        userAction: '请在启动 Roc 前设置对应环境变量，或重新配置 Provider 凭据引用。'
      });
    }
    if (/[\r\n]/.test(value)) {
      throw new RocDomainError({
        code: 'provider_credential_ref_invalid',
        message: `Provider 凭据环境变量 ${envName} 包含非法换行字符。`,
        category: 'validation',
        retryable: false,
        userAction: '请重新设置不含换行的 Provider 凭据环境变量。'
      });
    }
    return value;
  }

  private buildChatCompletionsUrl(endpoint: string): string {
    const trimmed = endpoint.trim();
    if (trimmed.length === 0) {
      throw new RocDomainError({
        code: 'provider_endpoint_invalid',
        message: 'Provider endpoint 不能为空。',
        category: 'validation',
        retryable: false,
        userAction: '请在设置页配置 Provider endpoint。'
      });
    }

    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new RocDomainError({
        code: 'provider_endpoint_invalid',
        message: 'Provider endpoint 不是有效 URL。',
        category: 'validation',
        retryable: false,
        userAction: '请在设置页配置有效的 Provider endpoint。'
      });
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new RocDomainError({
        code: 'provider_endpoint_invalid',
        message: 'Provider endpoint 必须使用 http 或 https。',
        category: 'validation',
        retryable: false,
        userAction: '请在设置页配置 http 或 https Provider endpoint。'
      });
    }
    if (url.pathname.endsWith('/chat/completions')) {
      return url.toString();
    }
    if (url.pathname.endsWith('/')) {
      url.pathname = `${url.pathname}chat/completions`;
      return url.toString();
    }
    url.pathname = `${url.pathname}/chat/completions`;
    return url.toString();
  }

  private parseOpenAiCompatibleResponse(responseText: string): ProviderTransportResponse {
    let parsed: unknown;
    try {
      parsed = JSON.parse(responseText) as unknown;
    } catch {
      throw new RocDomainError({
        code: 'provider_response_malformed',
        message: 'Provider 返回了无法解析的 JSON。',
        category: 'external',
        retryable: true,
        userAction: '请稍后重试，或检查 Provider 是否兼容 OpenAI chat completions 响应格式。'
      });
    }

    if (!this.isRecord(parsed)) {
      throw this.createMalformedResponseError();
    }
    const choices = parsed.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw this.createMalformedResponseError();
    }
    const firstChoice = choices[0] as unknown;
    if (!this.isRecord(firstChoice)) {
      throw this.createMalformedResponseError();
    }
    const message = firstChoice.message;
    if (!this.isRecord(message)) {
      throw this.createMalformedResponseError();
    }
    const content = message.content;
    if (typeof content !== 'string') {
      throw this.createMalformedResponseError();
    }

    let finishReason = 'unknown';
    if (typeof firstChoice.finish_reason === 'string' && firstChoice.finish_reason.trim().length > 0) {
      finishReason = firstChoice.finish_reason;
    }

    const usage = parsed.usage;
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    if (this.isRecord(usage)) {
      promptTokens = this.readOptionalToken(usage.prompt_tokens);
      completionTokens = this.readOptionalToken(usage.completion_tokens);
    }

    return {
      content,
      finishReason,
      promptTokens,
      completionTokens
    };
  }

  private createHttpErrorMessage(status: number, responseText: string): string {
    const trimmed = responseText.trim();
    if (trimmed.length === 0) {
      return `Provider 请求失败：HTTP ${status}`;
    }
    return `Provider 请求失败：HTTP ${status} ${this.redact(trimmed).slice(0, 300)}`;
  }

  private isRetryableHttpStatus(status: number): boolean {
    if (status === 408) {
      return true;
    }
    if (status === 425) {
      return true;
    }
    if (status === 429) {
      return true;
    }
    if (status >= 500) {
      return true;
    }
    return false;
  }

  private isAbortError(error: unknown): boolean {
    if (error instanceof Error && error.name === 'AbortError') {
      return true;
    }
    return false;
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

  private createMalformedResponseError(): RocDomainError {
    return new RocDomainError({
      code: 'provider_response_malformed',
      message: 'Provider 响应不符合 OpenAI-compatible chat completions 格式。',
      category: 'external',
      retryable: true,
      userAction: '请稍后重试，或检查 Provider endpoint 是否兼容 OpenAI chat completions。'
    });
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
