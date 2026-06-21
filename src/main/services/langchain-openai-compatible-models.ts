import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { convertChunksToEvents } from '@langchain/core/language_models/compat';
import type { ChatModelStreamEvent } from '@langchain/core/language_models/event';
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
import {
  ChatOpenAI,
  ChatOpenAICompletions,
  type ChatOpenAICallOptions,
  type ChatOpenAIFields
} from '@langchain/openai';
import type { ProviderConfig } from '../../shared/types';
import {
  nvidiaSupportsThinkingViaSystemPrompt,
  resolveNvidiaModelFamily
} from './nvidia-model-family';
import {
  normalizeOpenAiStreamingChunks,
  readProviderReasoningFromMessage,
  stripProviderReasoningDelta
} from './openai-stream-normalization';

type JsonObject = Record<string, unknown>;

export class ReasoningAwareChatOpenAI extends ChatOpenAI {
  async *_streamChatModelEvents(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun
  ): AsyncGenerator<ChatModelStreamEvent> {
    yield* convertChunksToEvents(
      this._streamResponseChunks(messages, options, runManager),
      {
        signal: options.signal
      }
    );
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun
  ): AsyncGenerator<ChatGenerationChunk> {
    yield* normalizeOpenAiStreamingChunks(super._streamResponseChunks(messages, options, runManager));
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

export class NvidiaCompatibleChatOpenAI extends ReasoningAwareChatOpenAI {
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

export class LlamaCppCompatibleChatOpenAI extends ReasoningAwareChatOpenAI {
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

export function applyOpenAiCompatibleDefaultOptions(
  model: BaseChatModel,
  defaults: Partial<ChatOpenAICallOptions> & { parallel_tool_calls?: boolean }
): void {
  if (Object.keys(defaults).length === 0) {
    return;
  }
  const target = model as BaseChatModel & {
    defaultOptions?: Record<string, unknown>;
  };
  target.defaultOptions = {
    ...(target.defaultOptions ?? {}),
    ...defaults
  };
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

class LlamaCppCompatibleChatOpenAICompletions extends ChatOpenAICompletions {
  override invocationParams(
    options?: this['ParsedCallOptions'],
    extra?: { streaming?: boolean }
  ): ReturnType<ChatOpenAICompletions['invocationParams']> {
    const sanitizedOptions = sanitizeLlamaCppToolOptions((options ?? {}) as ChatOpenAICallOptions) as this['ParsedCallOptions'];
    return super.invocationParams(sanitizedOptions, extra);
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
