import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { convertChunksToEvents } from '@langchain/core/language_models/compat';
import type { ChatModelStreamEvent } from '@langchain/core/language_models/event';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import {
  AIMessage,
  AIMessageChunk,
  FunctionMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage
} from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import type { Runnable } from '@langchain/core/runnables';
import { ChatAnthropic } from '@langchain/anthropic';
import {
  ChatOpenAI,
  ChatOpenAICompletions,
  type ChatOpenAICallOptions,
  type ChatOpenAIFields
} from '@langchain/openai';
import { resolveNvidiaBaseUrl } from '../../shared/provider-defaults';
import type { ProviderConfig, ProviderType } from '../../shared/types';
import type { ConfigService } from './config-service';
import { RocDomainError } from './errors';
import {
  nvidiaSupportsThinkingViaSystemPrompt,
  nvidiaThinkingParameterName,
  resolveNvidiaModelFamily
} from './nvidia-model-family';
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
  streaming?: boolean;
};

type JsonObject = Record<string, unknown>;

const openAiNoAuthPlaceholderKey = 'roc-no-auth';
const llamaCppProviderRequestTimeoutMs = 600_000;

class ReasoningAwareChatOpenAI extends ChatOpenAI {
  async *_streamChatModelEvents(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun
  ): AsyncGenerator<ChatModelStreamEvent> {
    yield* convertChunksToEvents(
      normalizeOpenAiReasoningChunks(this._streamResponseChunks(messages, options, runManager)),
      {
        signal: options.signal
      }
    );
  }

  protected cloneWithFields(): ReasoningAwareChatOpenAI {
    return new ReasoningAwareChatOpenAI(this.fields);
  }

  override withConfig(config: Partial<ChatOpenAICallOptions>): Runnable<BaseLanguageModelInput, AIMessageChunk, ChatOpenAICallOptions> {
    const newModel = this.cloneWithFields();
    newModel.defaultOptions = {
      ...this.defaultOptions,
      ...config
    };
    return newModel;
  }
}

class NvidiaCompatibleChatOpenAI extends ReasoningAwareChatOpenAI {
  private readonly nvidiaModelId: string;
  private readonly nvidiaProviderOptions: NonNullable<ProviderConfig['options']>;
  private readonly nvidiaThinkingViaSystemPrompt: 'on' | 'off' | null;

  constructor(fields: ChatOpenAIFields, extra: { modelId: string; providerOptions?: ProviderConfig['options'] }) {
    super({
      ...fields,
      completions: new NvidiaCompatibleChatOpenAICompletions(fields, extra.providerOptions)
    });
    this.nvidiaModelId = extra.modelId;
    this.nvidiaProviderOptions = extra.providerOptions ?? {};
    const family = resolveNvidiaModelFamily(extra.modelId);
    if (typeof this.nvidiaProviderOptions.thinking === 'boolean' && nvidiaSupportsThinkingViaSystemPrompt(family)) {
      this.nvidiaThinkingViaSystemPrompt = this.nvidiaProviderOptions.thinking ? 'on' : 'off';
    } else {
      this.nvidiaThinkingViaSystemPrompt = null;
    }
  }

  override async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    const transformed = normalizeNvidiaTextOnlyMessages(this.withThinkingSystemPrompt(messages));
    const result = await super._generate(transformed, sanitizeNvidiaToolOptions(options, this.nvidiaProviderOptions), runManager);
    return rebuildResultWithReasoningContent(result);
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun
  ): AsyncGenerator<ChatGenerationChunk> {
    const transformed = normalizeNvidiaTextOnlyMessages(this.withThinkingSystemPrompt(messages));
    yield* super._streamResponseChunks(transformed, sanitizeNvidiaToolOptions(options, this.nvidiaProviderOptions), runManager);
  }

  protected override cloneWithFields(): ReasoningAwareChatOpenAI {
    return new NvidiaCompatibleChatOpenAI(this.fields ?? {}, {
      modelId: this.nvidiaModelId,
      providerOptions: this.nvidiaProviderOptions
    });
  }

  private withThinkingSystemPrompt(messages: BaseMessage[]): BaseMessage[] {
    if (this.nvidiaThinkingViaSystemPrompt === null) {
      return messages;
    }
    return [
      new SystemMessage(`detailed thinking ${this.nvidiaThinkingViaSystemPrompt}`),
      ...messages
    ];
  }
}

class NvidiaCompatibleChatOpenAICompletions extends ChatOpenAICompletions {
  private readonly nvidiaProviderOptions: ProviderConfig['options'];

  constructor(fields?: ChatOpenAIFields, providerOptions?: ProviderConfig['options']) {
    super(fields);
    this.nvidiaProviderOptions = providerOptions;
  }

  override invocationParams(
    options?: this['ParsedCallOptions'],
    extra?: { streaming?: boolean }
  ): ReturnType<ChatOpenAICompletions['invocationParams']> {
    const params = super.invocationParams(options, extra);
    if (typeof this.nvidiaProviderOptions?.parallelToolCalls !== 'boolean') {
      delete (params as Record<string, unknown>).parallel_tool_calls;
    }
    return params;
  }
}

class LlamaCppCompatibleChatOpenAI extends ReasoningAwareChatOpenAI {
  constructor(fields?: ChatOpenAIFields) {
    super({
      ...fields,
      completions: new LlamaCppCompatibleChatOpenAICompletions(fields)
    });
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun
  ): AsyncGenerator<ChatGenerationChunk> {
    yield* super._streamResponseChunks(messages, sanitizeLlamaCppToolOptions(options), runManager);
  }

  protected override cloneWithFields(): ReasoningAwareChatOpenAI {
    return new LlamaCppCompatibleChatOpenAI(this.fields);
  }
}

class LlamaCppCompatibleChatOpenAICompletions extends ChatOpenAICompletions {
  override invocationParams(
    options?: this['ParsedCallOptions'],
    extra?: { streaming?: boolean }
  ): ReturnType<ChatOpenAICompletions['invocationParams']> {
    const sanitizedOptions = sanitizeLlamaCppToolOptions((options ?? {}) as ChatOpenAICallOptions) as this['ParsedCallOptions'];
    return super.invocationParams(sanitizedOptions, extra);
  }
}

function warnIfAnthropicCacheControlConfigured(model: ChatAnthropic): void {
  const defaultOptions = (model as ChatAnthropic & {
    defaultOptions?: {
      cache_control?: unknown;
    };
  }).defaultOptions;
  if (defaultOptions?.cache_control !== undefined) {
    console.warn(
      '[LangChainModelFactory] Anthropic model retained defaultOptions.cache_control; Deep Agents middleware should own prompt caching.'
    );
  }
}

function normalizeNvidiaTextOnlyMessages(messages: BaseMessage[]): BaseMessage[] {
  return messages.map((message) => normalizeNvidiaTextOnlyMessage(message));
}

function sanitizeNvidiaToolOptions<TOptions extends ChatOpenAICallOptions>(
  options: TOptions,
  providerOptions: ProviderConfig['options']
): TOptions {
  const next = {
    ...options,
    tools: Array.isArray(options.tools) ? options.tools.map((tool) => sanitizeNvidiaTool(tool)) : options.tools
  };
  if (typeof providerOptions?.parallelToolCalls === 'boolean') {
    (next as unknown as Record<string, unknown>).parallel_tool_calls = providerOptions.parallelToolCalls;
  } else {
    delete (next as unknown as Record<string, unknown>).parallel_tool_calls;
  }
  return next;
}

function sanitizeNvidiaTool<TTool>(tool: TTool): TTool {
  if (!isRecord(tool) || tool.type !== 'function' || !isRecord(tool.function)) {
    return tool;
  }
  const parameters = tool.function.parameters;
  if (!isRecord(parameters)) {
    return tool;
  }

  return {
    ...tool,
    function: {
      ...tool.function,
      parameters: sanitizeNvidiaJsonSchema(parameters)
    }
  };
}

function sanitizeNvidiaJsonSchema(schema: JsonObject): JsonObject {
  const sanitized: JsonObject = {};
  const type = sanitizeSchemaType(schema.type) ?? sanitizeSchemaTypeFromCompositions(schema);
  if (type !== undefined) {
    sanitized.type = type;
  }
  if (typeof schema.description === 'string' && schema.description.length > 0) {
    sanitized.description = schema.description;
  }
  if (Array.isArray(schema.enum) && schema.enum.every((item) => isJsonScalar(item))) {
    sanitized.enum = [...schema.enum];
  }
  if (Array.isArray(schema.required) && schema.required.every((item) => typeof item === 'string')) {
    sanitized.required = [...schema.required];
  }
  if (isRecord(schema.properties)) {
    sanitized.properties = Object.fromEntries(
      Object.entries(schema.properties)
        .filter((entry): entry is [string, JsonObject] => isRecord(entry[1]))
        .map(([key, value]) => [key, sanitizeNvidiaJsonSchema(value)])
    );
  }
  if (isRecord(schema.items)) {
    sanitized.items = sanitizeNvidiaJsonSchema(schema.items);
  }
  return sanitized;
}

function sanitizeLlamaCppToolOptions<TOptions extends ChatOpenAICallOptions>(options: TOptions): TOptions {
  return {
    ...options,
    stream_options: undefined,
    parallel_tool_calls: false,
    tools: Array.isArray(options.tools) ? options.tools.map((tool) => sanitizeLlamaCppTool(tool)) : options.tools
  };
}

function sanitizeLlamaCppTool<TTool>(tool: TTool): TTool {
  if (!isRecord(tool) || tool.type !== 'function' || !isRecord(tool.function)) {
    return tool;
  }
  const parameters = tool.function.parameters;
  if (!isRecord(parameters)) {
    return tool;
  }

  return {
    ...tool,
    function: {
      ...tool.function,
      parameters: sanitizeLlamaCppJsonSchema(parameters)
    }
  };
}

function sanitizeLlamaCppJsonSchema(schema: JsonObject): JsonObject {
  const resolved = resolveLlamaCppSchemaComposition(schema);
  const sanitized: JsonObject = {};
  const type = sanitizeSchemaType(resolved.type) ?? sanitizeSchemaTypeFromCompositions(resolved);
  if (type !== undefined) {
    sanitized.type = type;
  }
  if (typeof resolved.description === 'string' && resolved.description.length > 0) {
    sanitized.description = resolved.description;
  }
  if (Array.isArray(resolved.enum) && resolved.enum.every((item) => isJsonScalar(item))) {
    sanitized.enum = [...resolved.enum];
  }
  if (Array.isArray(resolved.required) && resolved.required.every((item) => typeof item === 'string')) {
    sanitized.required = [...resolved.required];
  }
  if (isRecord(resolved.properties)) {
    sanitized.properties = Object.fromEntries(
      Object.entries(resolved.properties)
        .filter((entry): entry is [string, JsonObject] => isRecord(entry[1]))
        .map(([key, value]) => [key, sanitizeLlamaCppJsonSchema(value)])
    );
  }
  if (isRecord(resolved.items)) {
    sanitized.items = sanitizeLlamaCppJsonSchema(resolved.items);
  }
  if (sanitized.type === 'string' && hasDateTimeConstraint(resolved)) {
    sanitized.description = appendDescription(
      typeof sanitized.description === 'string' ? sanitized.description : undefined,
      'Use an ISO 8601 UTC timestamp such as 2026-05-24T10:30:00Z.'
    );
  }
  return sanitized;
}

function resolveLlamaCppSchemaComposition(schema: JsonObject): JsonObject {
  for (const key of ['anyOf', 'oneOf'] as const) {
    const variants = schema[key];
    if (!Array.isArray(variants)) {
      continue;
    }
    const nonNullVariant = variants.find((item) => isRecord(item) && sanitizeSchemaType(item.type) !== 'null');
    if (isRecord(nonNullVariant)) {
      return nonNullVariant;
    }
  }
  return schema;
}

function hasDateTimeConstraint(schema: JsonObject): boolean {
  if (schema.format === 'date-time' || schema.format === 'datetime') {
    return true;
  }
  return typeof schema.pattern === 'string' && /\\d|[0-9]|T.*Z/.test(schema.pattern);
}

function appendDescription(current: string | undefined, addition: string): string {
  if (current === undefined || current.trim().length === 0) {
    return addition;
  }
  if (current.includes(addition)) {
    return current;
  }
  return `${current} ${addition}`;
}

function sanitizeSchemaType(type: unknown): string | undefined {
  if (typeof type === 'string') {
    return type;
  }
  if (Array.isArray(type)) {
    const firstType = type.find((item) => typeof item === 'string' && item !== 'null');
    return typeof firstType === 'string' ? firstType : undefined;
  }
  return undefined;
}

function sanitizeSchemaTypeFromCompositions(schema: JsonObject): string | undefined {
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const variants = schema[key];
    if (!Array.isArray(variants)) {
      continue;
    }
    for (const variant of variants) {
      if (!isRecord(variant)) {
        continue;
      }
      const type = sanitizeSchemaType(variant.type);
      if (type !== undefined && type !== 'null') {
        return type;
      }
    }
  }
  return undefined;
}

function isJsonScalar(value: unknown): boolean {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeNvidiaTextOnlyMessage(message: BaseMessage): BaseMessage {
  const normalizedContent = readTextOnlyBlockContent(message.content);
  if (normalizedContent === null) {
    return message;
  }

  const responseMetadata = stripOutputVersion(message.response_metadata);
  const fields = {
    id: message.id,
    name: message.name,
    content: normalizedContent,
    additional_kwargs: message.additional_kwargs,
    response_metadata: responseMetadata
  };

  if (SystemMessage.isInstance(message)) {
    return new SystemMessage(fields);
  }
  if (HumanMessage.isInstance(message)) {
    return new HumanMessage(fields);
  }
  if (AIMessage.isInstance(message)) {
    return new AIMessage({
      ...fields,
      tool_calls: message.tool_calls,
      invalid_tool_calls: message.invalid_tool_calls,
      usage_metadata: message.usage_metadata
    });
  }
  if (ToolMessage.isInstance(message)) {
    return new ToolMessage({
      ...fields,
      tool_call_id: message.tool_call_id,
      artifact: message.artifact,
      status: message.status,
      metadata: message.metadata
    });
  }
  if (FunctionMessage.isInstance(message)) {
    if (message.name === undefined) {
      return message;
    }
    return new FunctionMessage({
      ...fields,
      name: message.name
    });
  }
  return message;
}

function readTextOnlyBlockContent(content: BaseMessage['content']): string | null {
  if (!Array.isArray(content)) {
    return null;
  }
  const texts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      texts.push(block);
      continue;
    }
    if (block === null || typeof block !== 'object' || block.type !== 'text' || typeof block.text !== 'string') {
      return null;
    }
    texts.push(block.text);
  }
  return texts.join('\n\n');
}

function stripOutputVersion(responseMetadata: BaseMessage['response_metadata']): BaseMessage['response_metadata'] {
  const { output_version: _outputVersion, ...rest } = responseMetadata as Record<string, unknown>;
  return rest;
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

  resolveCheapModelHandle(activeHandle: LangChainChatModelHandle): LangChainChatModelHandle {
    return activeHandle;
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
    const requestedStreaming = options.streaming ?? true;
    const streaming = provider.type === 'llama_cpp' ? true : requestedStreaming;
    const requestTimeoutMs = provider.type === 'llama_cpp' ? llamaCppProviderRequestTimeoutMs : providerRequestTimeoutMs;

    if (provider.type === 'anthropic_compatible') {
      const baseUrl = this.normalizeAnthropicApiUrl(provider.endpoint);
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
      warnIfAnthropicCacheControlConfigured(model);
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
    if (provider.type === 'nvidia') {
      Object.assign(modelKwargs, buildNvidiaModelKwargs(modelId, provider.options ?? {}, streaming));
    }
    if (provider.type === 'llama_cpp') {
      modelKwargs.cache_prompt = true;
    }

    const baseUrl = provider.type === 'nvidia' ? resolveNvidiaBaseUrl(provider) : provider.endpoint.trim();
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
    const OpenAiChatModelClass = provider.type === 'llama_cpp' ? LlamaCppCompatibleChatOpenAI : ReasoningAwareChatOpenAI;
    const chatModelFields: ChatOpenAIFields = {
      model: modelId,
      apiKey: apiKeyForChatModel,
      streaming,
      streamUsage: resolveStreamUsage(provider, streaming),
      maxRetries: 0,
      temperature,
      maxTokens,
      timeout: requestTimeoutMs,
      configuration: openAiConfiguration,
      modelKwargs
    };
    const chatModel =
      provider.type === 'nvidia'
        ? new NvidiaCompatibleChatOpenAI(chatModelFields, { modelId, providerOptions: provider.options })
        : streaming
          ? new OpenAiChatModelClass(chatModelFields)
          : new ChatOpenAI(chatModelFields);

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
    if (provider.type !== 'nvidia') {
      throw new RocDomainError({
        code: 'provider_type_unsupported',
        message: 'NVIDIA TTFB 探活仅适用于 NVIDIA Provider。',
        category: 'validation',
        retryable: false,
        userAction: '请使用 NVIDIA Provider 调用本方法。'
      });
    }
    const apiKey = this.resolveCredential(provider);
    const baseUrl = resolveNvidiaBaseUrl(provider).replace(/\/+$/, '');
    const url = `${baseUrl}/chat/completions`;
    const startedAt = Date.now();
    const internalAbort = new AbortController();
    const timeoutMs = options.timeoutMs ?? 30_000;
    const hardTimeout = setTimeout(() => internalAbort.abort(), timeoutMs);
    const linkedSignal =
      options.signal === undefined
        ? internalAbort.signal
        : anySignal([options.signal, internalAbort.signal]);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream'
        },
        body: JSON.stringify({
          model: modelId,
          stream: true,
          max_tokens: 4,
          temperature: 0,
          messages: [{ role: 'user', content: prompt }]
        }),
        signal: linkedSignal
      });
      if (!response.ok) {
        const text = (await response.text()).slice(0, 300);
        throw new RocDomainError({
          code: 'provider_http_error',
          message: `Provider 请求失败：HTTP ${response.status}${text.length > 0 ? ` ${text}` : ''}`,
          category: 'external',
          retryable: response.status >= 500 || response.status === 429,
          userAction: '请检查 Provider endpoint、凭据、模型名称和服务状态后重试。'
        });
      }
      const body = response.body;
      if (body === null) {
        throw new RocDomainError({
          code: 'provider_response_malformed',
          message: 'Provider 流式响应缺少响应体。',
          category: 'external',
          retryable: true,
          userAction: '请稍后重试。'
        });
      }
      const reader = body.getReader();
      try {
        const decoder = new TextDecoder();
        let bufferedText = '';
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done === true) {
            throw new RocDomainError({
              code: 'provider_empty_response',
              message: 'Provider 返回了空回复。',
              category: 'external',
              retryable: true,
              userAction: '请稍后重试，或检查 Provider 模型配置。'
            });
          }
          bufferedText = `${bufferedText}${decoder.decode(chunk.value, { stream: true })}`;
          const parsed = readNvidiaProbeContent(bufferedText);
          bufferedText = parsed.remaining;
          if (parsed.hasContent) {
            return { latencyMs: Date.now() - startedAt };
          }
        }
      } finally {
        // 收到非空文本即可，无需继续读取——主动 cancel 让上游断开。
        await reader.cancel().catch(() => {});
      }
    } catch (error) {
      if (isAbortLikeError(error) && internalAbort.signal.aborted && options.signal?.aborted !== true) {
        throw new RocDomainError({
          code: 'provider_request_timeout',
          message: `NVIDIA endpoint 未在 ${Math.round(timeoutMs / 1000)} 秒内返回首字节。`,
          category: 'external',
          retryable: true,
          userAction: '请稍后重试，或确认 NVIDIA 公共 endpoint 当前负载是否过高。'
        });
      }
      throw error;
    } finally {
      clearTimeout(hardTimeout);
    }
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

function readNvidiaProbeContent(raw: string): { hasContent: boolean; remaining: string } {
  const normalized = raw.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const rawEndsWithLineBreak = normalized.endsWith('\n');
  const completeLines = rawEndsWithLineBreak ? lines : lines.slice(0, -1);
  for (const line of completeLines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) {
      continue;
    }
    const payload = trimmed.slice('data:'.length).trim();
    if (payload.length === 0 || payload === '[DONE]') {
      continue;
    }
    try {
      if (readNvidiaProbePayloadContent(JSON.parse(payload) as unknown).trim().length > 0) {
        return {
          hasContent: true,
          remaining: rawEndsWithLineBreak ? '' : lines.at(-1)!
        };
      }
    } catch {
      throw new RocDomainError({
        code: 'provider_response_malformed',
        message: 'Provider 流式响应不符合 SSE chat completions 格式。',
        category: 'external',
        retryable: true,
        userAction: '请稍后重试，或检查 Provider endpoint 是否兼容 SSE。'
      });
    }
  }
  return {
    hasContent: false,
    remaining: rawEndsWithLineBreak ? '' : lines.at(-1)!
  };
}

function readNvidiaProbePayloadContent(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    return '';
  }
  return payload.choices
    .map((choice) => {
      if (!isRecord(choice) || !isRecord(choice.delta) || typeof choice.delta.content !== 'string') {
        return '';
      }
      return choice.delta.content;
    })
    .join('');
}

function buildNvidiaModelKwargs(
  modelId: string,
  options: NonNullable<ProviderConfig['options']>,
  streaming: boolean
): Record<string, unknown> {
  const kwargs: Record<string, unknown> = {};
  const family = resolveNvidiaModelFamily(modelId);

  if (typeof options.thinking === 'boolean') {
    const paramName = nvidiaThinkingParameterName(family);
    if (paramName !== null) {
      kwargs.chat_template_kwargs = { [paramName]: options.thinking };
    }
  }
  if (typeof options.includeReasoning === 'boolean' && !streaming) {
    kwargs.include_reasoning = options.includeReasoning;
  }
  if (typeof options.topP === 'number') {
    kwargs.top_p = options.topP;
  }
  if (typeof options.topK === 'number') {
    kwargs.top_k = options.topK;
  }
  if (typeof options.minP === 'number') {
    kwargs.min_p = options.minP;
  }
  if (typeof options.frequencyPenalty === 'number') {
    kwargs.frequency_penalty = options.frequencyPenalty;
  }
  if (typeof options.presencePenalty === 'number') {
    kwargs.presence_penalty = options.presencePenalty;
  }
  if (typeof options.repetitionPenalty === 'number') {
    kwargs.repetition_penalty = options.repetitionPenalty;
  }
  if (typeof options.seed === 'number') {
    kwargs.seed = options.seed;
  }
  if (Array.isArray(options.stop) && options.stop.length > 0) {
    kwargs.stop = [...options.stop];
  }
  if (options.toolChoice !== undefined) {
    kwargs.tool_choice = options.toolChoice;
  }

  const nvext: Record<string, unknown> = {};
  if (options.guidedJson !== undefined) {
    nvext.guided_json = options.guidedJson;
  }
  if (typeof options.guidedRegex === 'string') {
    nvext.guided_regex = options.guidedRegex;
  }
  if (Array.isArray(options.guidedChoice) && options.guidedChoice.length > 0) {
    nvext.guided_choice = [...options.guidedChoice];
  }
  if (typeof options.guidedGrammar === 'string') {
    nvext.guided_grammar = options.guidedGrammar;
  }
  if (Object.keys(nvext).length > 0) {
    kwargs.nvext = nvext;
  }

  return kwargs;
}

function resolveStreamUsage(provider: ProviderConfig, streaming: boolean): boolean | undefined {
  if (!streaming) {
    return undefined;
  }
  if (provider.type === 'llama_cpp') {
    return false;
  }
  if (provider.type === 'nvidia') {
    return provider.options?.streamUsage ?? true;
  }
  return undefined;
}

function rebuildResultWithReasoningContent(result: ChatResult): ChatResult {
  return {
    ...result,
    generations: result.generations.map((generation) => {
      const message = generation.message;
      const reasoningText = readProviderReasoningFromMessage(message);
      if (reasoningText === null || typeof message.content !== 'string' || !AIMessage.isInstance(message)) {
        return generation;
      }
      const rebuiltMessage = new AIMessage({
        id: message.id,
        name: message.name,
        contentBlocks: [
          {
            type: 'reasoning',
            reasoning: reasoningText
          },
          {
            type: 'text',
            text: message.content
          }
        ],
        additional_kwargs: stripProviderReasoningDelta(message.additional_kwargs),
        response_metadata: message.response_metadata,
        tool_calls: message.tool_calls,
        invalid_tool_calls: message.invalid_tool_calls,
        usage_metadata: message.usage_metadata
      });
      return {
        ...generation,
        message: rebuiltMessage,
        text: message.content
      };
    })
  };
}

function isAbortLikeError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') {
    return false;
  }
  const named = error as { name?: unknown; code?: unknown };
  return named.name === 'AbortError' || named.code === 'ABORT_ERR' || named.code === 20;
}

function anySignal(signals: readonly AbortSignal[]): AbortSignal {
  if (typeof (AbortSignal as unknown as { any?: (signals: readonly AbortSignal[]) => AbortSignal }).any === 'function') {
    return (AbortSignal as unknown as { any: (signals: readonly AbortSignal[]) => AbortSignal }).any(signals);
  }
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener(
      'abort',
      () => controller.abort(signal.reason),
      { once: true }
    );
  }
  return controller.signal;
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
  return readProviderReasoningFromMessage(message);
}

function readProviderReasoningFromMessage(message: Pick<BaseMessage, 'additional_kwargs' | 'response_metadata'>): string | null {
  const additionalKwargs = message.additional_kwargs;
  const reasoningFromAdditionalKwargs = readProviderReasoningFromRecord(additionalKwargs);
  if (reasoningFromAdditionalKwargs !== null) {
    return reasoningFromAdditionalKwargs;
  }
  return readProviderReasoningFromRecord(message.response_metadata);
}

function readProviderReasoningFromRecord(value: unknown): string | null {
  if (value === null || value === undefined || typeof value !== 'object') {
    return null;
  }

  const reasoningContent = (value as Record<string, unknown>).reasoning_content;
  if (typeof reasoningContent === 'string' && reasoningContent.length > 0) {
    return reasoningContent;
  }

  const camelCaseReasoningContent = (value as Record<string, unknown>).reasoningContent;
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
