import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import { convertChunksToEvents } from '@langchain/core/language_models/compat';
import type { ChatModelStreamEvent } from '@langchain/core/language_models/event';
import {
  AIMessage,
  AIMessageChunk,
  ChatMessage,
  ChatMessageChunk,
  FunctionMessage,
  FunctionMessageChunk,
  HumanMessage,
  HumanMessageChunk,
  SystemMessage,
  SystemMessageChunk,
  ToolMessage,
  ToolMessageChunk,
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
import type { ProviderModelOptions } from '../../shared/types';
import {
  nvidiaSupportsThinkingViaSystemPrompt,
  resolveNvidiaModelFamily
} from './nvidia-model-family';
import {
  isExplicitReasoningContentBlock,
  normalizeOpenAiStreamingChunks,
  readProviderReasoningFromMessage,
  stripProviderReasoningDelta
} from './openai-stream-normalization';
import {
  providerRequestTimeoutMs,
  ProviderStreamIdleError,
  ProviderStreamTerminatedError
} from './provider-request-retry';
import {
  sanitizeOpenAiCompatibleTools,
  sanitizeProviderToolJsonSchema,
  type JsonObject
} from './provider-tool-json-schema';

const EMPTY_TOOL_CONTENT_PLACEHOLDER = 'Task completed';

export class ReasoningAwareChatOpenAI extends ChatOpenAI {
  override async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    return await super._generate(
      stripRawReasoningContentBlocks(messages),
      sanitizeOpenAiCompatibleToolOptions(options),
      runManager
    );
  }

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
    const streamAbortController = new AbortController();
    const abortFromParent = () => streamAbortController.abort(options.signal?.reason);
    if (options.signal?.aborted === true) {
      abortFromParent();
    } else {
      options.signal?.addEventListener('abort', abortFromParent, { once: true });
    }
    const source = normalizeOpenAiStreamingChunks(
      super._streamResponseChunks(
        stripRawReasoningContentBlocks(messages),
        { ...sanitizeOpenAiCompatibleToolOptions(options), signal: streamAbortController.signal },
        runManager
      )
    );
    try {
      for await (const chunk of withProviderStreamIdleTimeout(
        source,
        streamAbortController.signal,
        resolveProviderStreamIdleTimeoutMs(this.fields?.timeout),
        () => streamAbortController.abort(new ProviderStreamIdleError())
      )) {
        yield chunk;
      }
    } catch (error) {
      if (!streamAbortController.signal.aborted && isRawProviderStreamTerminationError(error)) {
        throw new ProviderStreamTerminatedError();
      }
      throw error;
    } finally {
      options.signal?.removeEventListener('abort', abortFromParent);
      streamAbortController.abort();
    }
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

function resolveProviderStreamIdleTimeoutMs(timeoutMs: number | undefined): number {
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : providerRequestTimeoutMs;
}

function isRawProviderStreamTerminationError(error: unknown): error is Error {
  return error instanceof Error && /^(?:terminated|stream terminated)$/iu.test(error.message.trim());
}

async function* withProviderStreamIdleTimeout<T>(
  source: AsyncIterable<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  onIdle: () => void
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  let nextPromise = iterator.next();
  try {
    while (true) {
      const next = await raceWithTimeout(nextPromise, timeoutMs, signal, onIdle);
      if (next.done) {
        return;
      }
      yield next.value;
      nextPromise = iterator.next();
    }
  } finally {
    const cleanup = iterator.return?.();
    if (cleanup !== undefined) {
      void cleanup.catch(() => undefined);
    }
  }
}

async function raceWithTimeout<T>(
  promise: Promise<IteratorResult<T>>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onTimeout: () => void
): Promise<IteratorResult<T>> {
  if (signal?.aborted === true) {
    throw signal.reason ?? new Error('The operation was aborted.');
  }
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      onTimeout();
      reject(new ProviderStreamIdleError());
    }, timeoutMs);
    abortHandler = () => reject(signal?.reason ?? new Error('The operation was aborted.'));
    signal?.addEventListener('abort', abortHandler, { once: true });
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    if (abortHandler !== undefined) {
      signal?.removeEventListener('abort', abortHandler);
    }
  }
}

function stripRawReasoningContentBlocks(messages: BaseMessage[]): BaseMessage[] {
  return messages.map((message) => stripRawReasoningContentBlock(message));
}

function stripRawReasoningContentBlock(message: BaseMessage): BaseMessage {
  let content = stripReasoningBlocksFromContent(message.content);
  if (content === message.content) {
    return message;
  }
  if (Array.isArray(content) && content.length === 0 && (ToolMessage.isInstance(message) || isToolMessageChunk(message))) {
    content = EMPTY_TOOL_CONTENT_PLACEHOLDER;
  }

  const fields = {
    id: message.id,
    name: message.name,
    content,
    additional_kwargs: message.additional_kwargs,
    response_metadata: message.response_metadata
  };

  if (SystemMessageChunk.isInstance(message)) {
    return new SystemMessageChunk(fields);
  }
  if (HumanMessageChunk.isInstance(message)) {
    return new HumanMessageChunk(fields);
  }
  if (AIMessageChunk.isInstance(message)) {
    return new AIMessageChunk({
      ...fields,
      tool_call_chunks: message.tool_call_chunks,
      tool_calls: message.tool_calls,
      invalid_tool_calls: message.invalid_tool_calls,
      usage_metadata: message.usage_metadata
    });
  }
  if (isToolMessageChunk(message)) {
    return new ToolMessageChunk({
      ...fields,
      tool_call_id: message.tool_call_id,
      artifact: message.artifact,
      status: message.status
    });
  }
  if (ChatMessageChunk.isInstance(message)) {
    return new ChatMessageChunk({
      ...fields,
      role: message.role
    });
  }
  if (FunctionMessageChunk.isInstance(message)) {
    if (message.name === undefined) {
      return message;
    }
    return new FunctionMessageChunk({
      ...fields,
      name: message.name
    });
  }
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
  if (ChatMessage.isInstance(message)) {
    return new ChatMessage({
      ...fields,
      role: message.role
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

function stripReasoningBlocksFromContent(content: BaseMessage['content']): BaseMessage['content'] {
  if (!Array.isArray(content)) {
    return content;
  }

  let changed = false;
  const stripped = content.filter((block) => {
    if (isExplicitReasoningContentBlock(block)) {
      changed = true;
      return false;
    }
    return true;
  });
  return changed ? stripped : content;
}

function isToolMessageChunk(message: BaseMessage): message is ToolMessageChunk {
  return ToolMessageChunk.isInstance(message) && message.type === 'tool';
}

export class NvidiaCompatibleChatOpenAI extends ReasoningAwareChatOpenAI {
  private readonly nvidiaModelId: string;
  private readonly nvidiaProviderOptions: ProviderModelOptions;
  private readonly nvidiaThinkingViaSystemPrompt: 'on' | 'off' | null;

  constructor(fields: ChatOpenAIFields, extra: { modelId: string; providerOptions?: ProviderModelOptions }) {
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

  override async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    return await super._generate(messages, sanitizeLlamaCppToolOptions(options), runManager);
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

class NvidiaCompatibleChatOpenAICompletions extends ChatOpenAICompletions {
  private readonly nvidiaProviderOptions: ProviderModelOptions;

  constructor(fields?: ChatOpenAIFields, providerOptions?: ProviderModelOptions) {
    super(fields);
    this.nvidiaProviderOptions = providerOptions ?? {};
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
  providerOptions: ProviderModelOptions
): TOptions {
  const next = {
    ...options,
    tools: Array.isArray(options.tools) ? sanitizeOpenAiCompatibleTools(options.tools) : options.tools
  };
  if (typeof providerOptions?.parallelToolCalls === 'boolean') {
    (next as unknown as Record<string, unknown>).parallel_tool_calls = providerOptions.parallelToolCalls;
  } else {
    delete (next as unknown as Record<string, unknown>).parallel_tool_calls;
  }
  return next;
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
      parameters: appendLlamaCppDateTimeHint(sanitizeProviderToolJsonSchema(parameters))
    }
  };
}

function sanitizeOpenAiCompatibleToolOptions<TOptions extends ChatOpenAICallOptions>(options: TOptions): TOptions {
  if (!Array.isArray(options.tools)) {
    return options;
  }
  return {
    ...options,
    tools: sanitizeOpenAiCompatibleTools(options.tools)
  };
}

function appendLlamaCppDateTimeHint(schema: JsonObject): JsonObject {
  const next: JsonObject = { ...schema };
  if (isRecord(schema.properties)) {
    next.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [
        key,
        isRecord(value) ? appendLlamaCppDateTimeHint(value) : value
      ])
    );
  }
  if (isRecord(schema.items)) {
    next.items = appendLlamaCppDateTimeHint(schema.items);
  }
  if (schema.type === 'string' && hasDateTimeConstraint(schema)) {
    next.description = appendDescription(
      typeof schema.description === 'string' ? schema.description : undefined,
      'Use an ISO 8601 UTC timestamp such as 2026-05-24T10:30:00Z.'
    );
  }
  return next;
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

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeNvidiaTextOnlyMessage(message: BaseMessage): BaseMessage {
  let normalizedContent = readTextOnlyBlockContent(message.content);
  if (normalizedContent === null) {
    return message;
  }
  if (ToolMessage.isInstance(message) && normalizedContent.length === 0) {
    normalizedContent = EMPTY_TOOL_CONTENT_PLACEHOLDER;
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
    if (!isRecord(block)) {
      return null;
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
      continue;
    }
    if (block.type === 'reasoning') {
      continue;
    }
    return null;
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
