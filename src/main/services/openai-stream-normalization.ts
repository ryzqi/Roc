import type { BaseMessage } from '@langchain/core/messages';
import { AIMessageChunk } from '@langchain/core/messages';
import { ChatGenerationChunk } from '@langchain/core/outputs';

type JsonObject = Record<string, unknown>;
type OpenAiToolCallChunk = NonNullable<AIMessageChunk['tool_call_chunks']>[number];
type OpenAiToolCallChunkIndexState = {
  activeIndex: number | null;
  idsByIndex: Map<number, string>;
  indexById: Map<string, number>;
  namesByIndex: Map<number, string>;
  nextIndex: number;
};

export async function* normalizeOpenAiStreamingChunks(
  chunks: AsyncIterable<ChatGenerationChunk>
): AsyncGenerator<ChatGenerationChunk> {
  const toolCallChunkIndexState = createOpenAiToolCallChunkIndexState();
  for await (const chunk of chunks) {
    const normalizedChunk = normalizeOpenAiToolCallChunks(chunk, toolCallChunkIndexState);
    const reasoningText = readProviderReasoningFromMessage(normalizedChunk.message);
    if (
      reasoningText === null ||
      typeof normalizedChunk.message.content !== 'string' ||
      hasExplicitReasoningBlocks(normalizedChunk.message.content)
    ) {
      yield normalizedChunk;
      continue;
    }

    yield new ChatGenerationChunk({
      message: new AIMessageChunk({
        id: normalizedChunk.message.id,
        content: [
          {
            type: 'reasoning',
            index: readNextAvailableReasoningBlockIndex(normalizedChunk.message),
            reasoning: reasoningText
          }
        ]
      }),
      text: '',
      generationInfo: {}
    });

    yield rebuildOpenAiChunkWithoutProviderReasoning(normalizedChunk);
  }
}

export function readProviderReasoningFromMessage(
  message: Pick<BaseMessage, 'additional_kwargs' | 'response_metadata'>
): string | null {
  const reasoningFromAdditionalKwargs = readProviderReasoningFromRecord(message.additional_kwargs);
  if (reasoningFromAdditionalKwargs !== null) {
    return reasoningFromAdditionalKwargs;
  }
  return readProviderReasoningFromRecord(message.response_metadata);
}

export function stripProviderReasoningDelta(additionalKwargs: unknown): Record<string, unknown> {
  if (additionalKwargs === null || additionalKwargs === undefined || typeof additionalKwargs !== 'object') {
    return {};
  }

  const { reasoning_content: _reasoningContent, reasoningContent: _camelCaseReasoningContent, ...rest } =
    additionalKwargs as Record<string, unknown>;
  return rest;
}

export function isExplicitReasoningContentBlock(item: unknown): boolean {
  if (!isRecord(item)) {
    return false;
  }
  const type = item.type;
  return type === 'reasoning' || type === 'reasoning_content' || type === 'thinking';
}

function createOpenAiToolCallChunkIndexState(): OpenAiToolCallChunkIndexState {
  return {
    activeIndex: null,
    idsByIndex: new Map(),
    indexById: new Map(),
    namesByIndex: new Map(),
    nextIndex: 0
  };
}

function normalizeOpenAiToolCallChunks(
  chunk: ChatGenerationChunk,
  state: OpenAiToolCallChunkIndexState
): ChatGenerationChunk {
  const message = chunk.message;
  if (!AIMessageChunk.isInstance(message)) {
    return chunk;
  }
  const currentToolCallChunks = message.tool_call_chunks;
  if (currentToolCallChunks === undefined || currentToolCallChunks.length === 0) {
    return chunk;
  }

  let changed = false;
  const toolCallChunks = currentToolCallChunks.map((toolCallChunk) => {
    const normalized = normalizeOpenAiToolCallChunk(toolCallChunk, state);
    if (normalized !== toolCallChunk) {
      changed = true;
    }
    return normalized;
  });
  if (!changed) {
    return chunk;
  }

  return new ChatGenerationChunk({
    message: new AIMessageChunk({
      id: message.id,
      content: message.content,
      name: message.name,
      additional_kwargs: message.additional_kwargs,
      response_metadata: message.response_metadata,
      tool_call_chunks: toolCallChunks,
      usage_metadata: message.usage_metadata
    }),
    text: chunk.text,
    generationInfo: chunk.generationInfo
  });
}

function normalizeOpenAiToolCallChunk(
  toolCallChunk: OpenAiToolCallChunk,
  state: OpenAiToolCallChunkIndexState
): OpenAiToolCallChunk {
  const explicitIndex = readToolCallChunkIndex(toolCallChunk.index);
  const id = readToolCallChunkText(toolCallChunk.id);
  const name = readToolCallChunkText(toolCallChunk.name);
  let index = explicitIndex;
  if (index === null && id !== null) {
    const trackedIndex = state.indexById.get(id);
    if (trackedIndex !== undefined) {
      index = trackedIndex;
    }
  }
  if (index === null && (id !== null || name !== null)) {
    index = claimNextToolCallChunkIndex(state);
  }
  if (index === null) {
    index = state.activeIndex;
  }
  if (index === null) {
    return toolCallChunk;
  }

  state.activeIndex = index;
  advanceNextToolCallChunkIndex(state, index);
  if (id !== null) {
    state.indexById.set(id, index);
    state.idsByIndex.set(index, id);
  }
  if (name !== null) {
    state.namesByIndex.set(index, name);
  }

  const trackedId = state.idsByIndex.get(index);
  const trackedName = state.namesByIndex.get(index);
  const nextId = id === null && trackedId !== undefined ? trackedId : toolCallChunk.id;
  const nextName = name === null && trackedName !== undefined ? trackedName : toolCallChunk.name;
  const indexChanged = explicitIndex !== index;
  const idChanged = nextId !== toolCallChunk.id;
  const nameChanged = nextName !== toolCallChunk.name;
  if (!indexChanged && !idChanged && !nameChanged) {
    return toolCallChunk;
  }

  return {
    ...toolCallChunk,
    index,
    ...(idChanged ? { id: nextId } : {}),
    ...(nameChanged ? { name: nextName } : {})
  };
}

function claimNextToolCallChunkIndex(state: OpenAiToolCallChunkIndexState): number {
  const index = state.nextIndex;
  state.nextIndex += 1;
  return index;
}

function advanceNextToolCallChunkIndex(state: OpenAiToolCallChunkIndexState, index: number): void {
  if (index >= state.nextIndex) {
    state.nextIndex = index + 1;
  }
}

function rebuildOpenAiChunkWithoutProviderReasoning(chunk: ChatGenerationChunk): ChatGenerationChunk {
  const message = chunk.message;
  const aiFields = AIMessageChunk.isInstance(message)
    ? {
        tool_call_chunks: message.tool_call_chunks,
        tool_calls: message.tool_calls,
        invalid_tool_calls: message.invalid_tool_calls,
        usage_metadata: message.usage_metadata
      }
    : {};

  return new ChatGenerationChunk({
    message: new AIMessageChunk({
      id: message.id,
      content: message.content,
      name: message.name,
      additional_kwargs: stripProviderReasoningDelta(message.additional_kwargs),
      response_metadata: message.response_metadata,
      ...aiFields
    }),
    text: chunk.text,
    generationInfo: chunk.generationInfo
  });
}

function readNextAvailableReasoningBlockIndex(message: ChatGenerationChunk['message']): number {
  const usedIndexes = new Set<number>();
  if (typeof message.content === 'string' && message.content.length > 0) {
    usedIndexes.add(0);
  } else if (Array.isArray(message.content)) {
    message.content.forEach((block) => {
      const index = readContentBlockIndex(block);
      if (index !== null) {
        usedIndexes.add(index);
      }
    });
  }
  if (AIMessageChunk.isInstance(message)) {
    (message.tool_call_chunks ?? []).forEach((toolCallChunk) => {
      const index = readToolCallChunkIndex(toolCallChunk.index);
      if (index !== null) {
        usedIndexes.add(index);
      }
    });
  }

  let nextIndex = 0;
  while (usedIndexes.has(nextIndex)) {
    nextIndex += 1;
  }
  return nextIndex;
}

function readContentBlockIndex(block: unknown): number | null {
  if (!isRecord(block)) {
    return null;
  }
  const index = block.index;
  return typeof index === 'number' && Number.isInteger(index) && index >= 0 ? index : null;
}

function readToolCallChunkIndex(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function readToolCallChunkText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
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

function hasExplicitReasoningBlocks(content: unknown): boolean {
  if (!Array.isArray(content)) {
    return false;
  }

  return content.some((item) => isExplicitReasoningContentBlock(item));
}

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
