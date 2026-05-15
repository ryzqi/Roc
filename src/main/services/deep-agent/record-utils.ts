import type { ChatTodoItem } from '../../../shared/types';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function readRecordValue(value: unknown, key: string): unknown {
  if (!isRecord(value)) {
    return undefined;
  }
  return value[key];
}

export function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  return value.length === 0 ? null : value;
}

const NON_ASSISTANT_MESSAGE_TYPES = new Set([
  'tool',
  'tool_result',
  'tool_use',
  'server_tool_call',
  'server_tool_call_chunk',
  'server_tool_call_result',
  'mcp_call',
  'mcp_result',
  'mcp_tool_call',
  'mcp_tool_result',
  'skill_loaded',
  'skill_load',
  'skill_content'
]);

const NON_ASSISTANT_CONTENT_BLOCK_TYPES = new Set([
  'tool_call',
  'tool_call_chunk',
  'invalid_tool_call',
  'tool_result',
  'tool_use',
  'server_tool_call',
  'server_tool_call_chunk',
  'server_tool_call_result',
  'mcp_call',
  'mcp_result',
  'mcp_tool_call',
  'mcp_tool_result',
  'skill_loaded',
  'skill_load',
  'skill_content'
]);

export function isNonAssistantTextMessage(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  if (hasNonAssistantMessageType(value)) {
    return true;
  }

  const additionalKwargs = readRecordValue(value, 'additional_kwargs');
  if (hasToolCalls(value) || hasToolCalls(additionalKwargs)) {
    return true;
  }

  return readContentBlocks(value).some((block) => isNonAssistantContentBlock(block));
}

function hasNonAssistantMessageType(value: Record<string, unknown>): boolean {
  const role = readLowercaseString(readRecordValue(value, 'role'));
  if (role !== null && NON_ASSISTANT_MESSAGE_TYPES.has(role)) {
    return true;
  }

  const type = readLowercaseString(readRecordValue(value, 'type'));
  return type !== null && NON_ASSISTANT_MESSAGE_TYPES.has(type);
}

function hasToolCalls(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const toolCalls = readRecordValue(value, 'tool_calls');
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    return true;
  }

  const toolCallChunks = readRecordValue(value, 'tool_call_chunks');
  if (Array.isArray(toolCallChunks) && toolCallChunks.length > 0) {
    return true;
  }

  return readNonEmptyString(readRecordValue(value, 'tool_call_id')) !== null;
}

function readContentBlocks(value: unknown): unknown[] {
  if (!isRecord(value)) {
    return [];
  }

  const blocks: unknown[] = [];
  appendArrayValues(blocks, readRecordValue(value, 'contentBlocks'));
  appendArrayValues(blocks, readRecordValue(value, 'content_blocks'));
  appendArrayValues(blocks, readRecordValue(value, 'content'));

  const additionalKwargs = readRecordValue(value, 'additional_kwargs');
  if (isRecord(additionalKwargs)) {
    appendArrayValues(blocks, readRecordValue(additionalKwargs, 'contentBlocks'));
    appendArrayValues(blocks, readRecordValue(additionalKwargs, 'content_blocks'));
    appendArrayValues(blocks, readRecordValue(additionalKwargs, 'content'));
  }

  return blocks;
}

function appendArrayValues(target: unknown[], value: unknown): void {
  if (!Array.isArray(value)) {
    return;
  }
  target.push(...value);
}

function isNonAssistantContentBlock(block: unknown): boolean {
  if (!isRecord(block)) {
    return false;
  }

  const type = readLowercaseString(readRecordValue(block, 'type'));
  if (type !== null && NON_ASSISTANT_CONTENT_BLOCK_TYPES.has(type)) {
    return true;
  }

  if (hasToolCalls(block)) {
    return true;
  }

  if (hasSkillInstructionPath(block)) {
    return true;
  }

  if (hasHostedSearchResultText(block)) {
    return true;
  }

  const nestedContent = readRecordValue(block, 'content');
  return Array.isArray(nestedContent) && nestedContent.some((item) => isNonAssistantContentBlock(item));
}

function hasHostedSearchResultText(value: Record<string, unknown>): boolean {
  const type = readLowercaseString(readRecordValue(value, 'type'));
  if (type !== 'text') {
    return false;
  }

  const text = readNonEmptyString(readRecordValue(value, 'text'));
  if (text === null) {
    return false;
  }

  return isHostedSearchResultText(text);
}

function isHostedSearchResultText(text: string): boolean {
  return (
    text.startsWith('Title: ') &&
    text.includes('\nURL: ') &&
    text.includes('\nPublished: ') &&
    text.includes('\nHighlights:')
  );
}

function hasSkillInstructionPath(value: Record<string, unknown>): boolean {
  const path = readNonEmptyString(readRecordValue(value, 'path'));
  if (path !== null && isSkillInstructionPath(path)) {
    return true;
  }

  const filePath = readNonEmptyString(readRecordValue(value, 'filePath'));
  if (filePath !== null && isSkillInstructionPath(filePath)) {
    return true;
  }

  const snakeCaseFilePath = readNonEmptyString(readRecordValue(value, 'file_path'));
  if (snakeCaseFilePath !== null && isSkillInstructionPath(snakeCaseFilePath)) {
    return true;
  }

  const metadata = readRecordValue(value, 'metadata');
  if (!isRecord(metadata)) {
    return false;
  }

  const metadataPath = readNonEmptyString(readRecordValue(metadata, 'path'));
  if (metadataPath !== null && isSkillInstructionPath(metadataPath)) {
    return true;
  }

  const metadataFilePath = readNonEmptyString(readRecordValue(metadata, 'filePath'));
  if (metadataFilePath !== null && isSkillInstructionPath(metadataFilePath)) {
    return true;
  }

  const metadataSnakeCaseFilePath = readNonEmptyString(readRecordValue(metadata, 'file_path'));
  return metadataSnakeCaseFilePath !== null && isSkillInstructionPath(metadataSnakeCaseFilePath);
}

function isSkillInstructionPath(path: string): boolean {
  return path.replaceAll('\\', '/').toLowerCase().endsWith('/skill.md');
}

function readLowercaseString(value: unknown): string | null {
  const text = readNonEmptyString(value);
  return text === null ? null : text.toLowerCase();
}

export function readReasoningBlockText(block: unknown): string[] {
  if (!isRecord(block)) {
    return [];
  }

  const type = readNonEmptyString(readRecordValue(block, 'type'));
  if (type !== 'reasoning' && type !== 'reasoning_content' && type !== 'thinking') {
    return [];
  }

  const values: string[] = [];
  const text = readNonEmptyString(readRecordValue(block, 'text'));
  if (text !== null) {
    values.push(text);
  }

  const reasoning = readNonEmptyString(readRecordValue(block, 'reasoning'));
  if (reasoning !== null) {
    values.push(reasoning);
  }

  const thinking = readNonEmptyString(readRecordValue(block, 'thinking'));
  if (thinking !== null) {
    values.push(thinking);
  }

  const reasoningContent = readNonEmptyString(readRecordValue(block, 'reasoning_content'));
  if (reasoningContent !== null) {
    values.push(reasoningContent);
  }

  const summary = readRecordValue(block, 'summary');
  if (Array.isArray(summary)) {
    for (const item of summary) {
      const summaryText = readNonEmptyString(readRecordValue(item, 'text'));
      if (summaryText !== null) {
        values.push(summaryText);
      }
    }
  }

  return values;
}

export function readReasoningTextValues(value: unknown): string[] {
  if (!isRecord(value)) {
    return [];
  }

  const standardContentBlocks = readReasoningBlockValues(readRecordValue(value, 'contentBlocks'));
  if (standardContentBlocks.length > 0) {
    return standardContentBlocks;
  }

  const snakeCaseContentBlocks = readReasoningBlockValues(readRecordValue(value, 'content_blocks'));
  if (snakeCaseContentBlocks.length > 0) {
    return snakeCaseContentBlocks;
  }

  const additionalKwargs = readRecordValue(value, 'additional_kwargs');
  const additionalReasoningValues = readOpenAiReasoningSummaryValues(readRecordValue(additionalKwargs, 'reasoning'));
  if (additionalReasoningValues.length > 0) {
    return additionalReasoningValues;
  }

  const additionalReasoningContent = readNonEmptyString(readRecordValue(additionalKwargs, 'reasoning_content'));
  if (additionalReasoningContent !== null) {
    return [additionalReasoningContent];
  }

  const additionalCamelCaseReasoningContent = readNonEmptyString(readRecordValue(additionalKwargs, 'reasoningContent'));
  if (additionalCamelCaseReasoningContent !== null) {
    return [additionalCamelCaseReasoningContent];
  }

  const directReasoningContent = readNonEmptyString(readRecordValue(value, 'reasoning_content'));
  if (directReasoningContent !== null) {
    return [directReasoningContent];
  }

  const directCamelCaseReasoningContent = readNonEmptyString(readRecordValue(value, 'reasoningContent'));
  if (directCamelCaseReasoningContent !== null) {
    return [directCamelCaseReasoningContent];
  }

  const directReasoning = readNonEmptyString(readRecordValue(value, 'reasoning'));
  if (directReasoning !== null) {
    return [directReasoning];
  }

  return readReasoningBlockValues(readRecordValue(value, 'content'));
}

export async function readReasoningFromMessageOutput(output: unknown): Promise<string | null> {
  const resolved = await Promise.resolve(output);
  const values = readReasoningTextValues(resolved);
  return values.length === 0 ? null : values.join('');
}

function readReasoningBlockValues(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((block) => readReasoningBlockText(block));
}

function readOpenAiReasoningSummaryValues(value: unknown): string[] {
  if (!isRecord(value)) {
    return [];
  }

  const summary = readRecordValue(value, 'summary');
  if (!Array.isArray(summary)) {
    return [];
  }

  return summary
    .map((item) => readNonEmptyString(readRecordValue(item, 'text')))
    .filter((item): item is string => item !== null);
}

export function readAsyncIterable(value: unknown): AsyncIterable<unknown> | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'object') {
    return null;
  }
  const iterator = (value as AsyncIterable<unknown>)[Symbol.asyncIterator];
  if (typeof iterator !== 'function') {
    return null;
  }
  return value as AsyncIterable<unknown>;
}

export function readTodos(candidate: unknown): ChatTodoItem[] | null {
  if (!isRecord(candidate) || !Array.isArray(candidate.todos)) {
    return null;
  }
  const todos = candidate.todos
    .map((item) => {
      if (!isRecord(item)) {
        return null;
      }
      const content = readNonEmptyString(item.content);
      const status = item.status;
      if (
        content === null ||
        (status !== 'pending' && status !== 'in_progress' && status !== 'completed')
      ) {
        return null;
      }
      return {
        content,
        status
      };
    })
    .filter((item): item is ChatTodoItem => item !== null);
  return todos.length === 0 ? null : todos;
}
