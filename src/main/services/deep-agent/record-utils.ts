export type MessageContentSummary = {
  hasReasoning: boolean;
  hasVisibleText: boolean;
  visibleText: string;
};

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
  'mcp_tool_result'
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
  'mcp_tool_result'
]);

export type StreamedAssistantTextClassification = 'assistant' | 'non_assistant' | 'pending';

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

  if (hasSkillInstructionPath(value) || hasSkillInstructionPath(additionalKwargs)) {
    return true;
  }

  const output = readRecordValue(value, 'output');
  if (isNonAssistantOutput(output)) {
    return true;
  }

  return readContentBlocks(value).some((block) => isNonAssistantContentBlock(block));
}

export function isSummarizationMessage(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return hasSummarizationSource(value) || hasSummarizationSource(readRecordValue(value, 'metadata'));
}

export function classifyStreamedAssistantText(text: string): StreamedAssistantTextClassification {
  if (text.length === 0) {
    return 'assistant';
  }

  if (isHostedSearchResultText(text)) {
    return 'non_assistant';
  }

  if (isPotentialHostedSearchResultTextPrefix(text)) {
    return 'pending';
  }

  return 'assistant';
}

export function readMessageContentSummary(value: unknown): MessageContentSummary {
  const visibleText = readVisibleTextValues(value).join('');
  return {
    hasReasoning: readReasoningTextValues(value).join('').trim().length > 0,
    hasVisibleText: visibleText.trim().length > 0,
    visibleText
  };
}

function readVisibleTextValues(value: unknown): string[] {
  return readPreferredContentBlocks(value).flatMap((block) => readVisibleTextBlock(block));
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
  return Array.isArray(toolCalls) && toolCalls.length > 0;
}

function isNonAssistantOutput(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  if (hasNonAssistantMessageType(value) || hasToolCalls(value) || hasSkillInstructionPath(value)) {
    return true;
  }

  return readContentBlocks(value).some((block) => isNonAssistantContentBlock(block));
}

function readContentBlocks(value: unknown): unknown[] {
  if (!isRecord(value)) {
    return [];
  }

  const blocks: unknown[] = [];
  appendArrayValues(blocks, readRecordValue(value, 'contentBlocks'));
  appendArrayValues(blocks, readRecordValue(value, 'content'));
  return blocks;
}

function appendArrayValues(target: unknown[], value: unknown): void {
  if (!Array.isArray(value)) {
    return;
  }
  target.push(...value);
}

function readPreferredContentBlocks(value: unknown): unknown[] {
  if (!isRecord(value)) {
    return [];
  }

  const contentBlocks = readRecordValue(value, 'contentBlocks');
  if (Array.isArray(contentBlocks)) {
    return contentBlocks;
  }

  const content = readRecordValue(value, 'content');
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  if (Array.isArray(content)) {
    return content;
  }
  return [];
}

function readVisibleTextBlock(block: unknown): string[] {
  if (typeof block === 'string') {
    return [block];
  }
  if (!isRecord(block)) {
    return [];
  }
  const type = readLowercaseString(readRecordValue(block, 'type'));
  if (type !== null && type !== 'text') {
    return [];
  }
  const text = readRecordValue(block, 'text');
  return typeof text === 'string' ? [text] : [];
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
  return false;
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

function hasSummarizationSource(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return readNonEmptyString(readRecordValue(value, 'lcSource')) === 'summarization';
}

function isHostedSearchResultText(text: string): boolean {
  return (
    text.startsWith('Title: ') &&
    text.includes('\nURL: ') &&
    text.includes('\nPublished: ') &&
    text.includes('\nAuthor: ') &&
    text.includes('\nHighlights:')
  );
}

function isPotentialHostedSearchResultTextPrefix(text: string): boolean {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('Title: ')) {
    return false;
  }

  const expectedLinePrefixes = ['URL: ', 'Published: ', 'Author: ', 'Highlights:'];
  if (!normalized.includes('\n')) {
    return true;
  }

  const hasTrailingNewline = normalized.endsWith('\n');
  const lines = normalized.split('\n');
  const remainingLines = hasTrailingNewline ? lines.slice(1, -1) : lines.slice(1);

  let expectedIndex = 0;
  for (let index = 0; index < remainingLines.length; index += 1) {
    const line = remainingLines[index] ?? '';
    const expectedPrefix = expectedLinePrefixes[expectedIndex];
    if (expectedPrefix === undefined) {
      return false;
    }

    const isLastVisibleLine = index === remainingLines.length - 1;
    const isPartialLine = isLastVisibleLine && !hasTrailingNewline;
    if (isPartialLine) {
      return expectedPrefix.startsWith(line) || line.startsWith(expectedPrefix);
    }

    if (!line.startsWith(expectedPrefix)) {
      return false;
    }
    expectedIndex += 1;
  }

  return expectedIndex < expectedLinePrefixes.length;
}

function hasSkillInstructionPath(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const path = readNonEmptyString(readRecordValue(value, 'path'));
  return path !== null && isSkillInstructionPath(path);
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
  if (type !== 'reasoning') {
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

  const additionalKwargs = readRecordValue(value, 'additional_kwargs');

  // Check additional_kwargs.reasoning_content (NVIDIA, llama.cpp, OpenAI-compatible)
  const additionalReasoningContent = readNonEmptyString(readRecordValue(additionalKwargs, 'reasoning_content'));
  if (additionalReasoningContent !== null) {
    return [additionalReasoningContent];
  }

  // Check additional_kwargs.reasoningContent (camelCase variant)
  const additionalReasoningContentCamelCase = readNonEmptyString(readRecordValue(additionalKwargs, 'reasoningContent'));
  if (additionalReasoningContentCamelCase !== null) {
    return [additionalReasoningContentCamelCase];
  }

  // Check additional_kwargs.reasoning.summary (OpenAI reasoning format)
  const additionalReasoningValues = readOpenAiReasoningSummaryValues(readRecordValue(additionalKwargs, 'reasoning'));
  if (additionalReasoningValues.length > 0) {
    return additionalReasoningValues;
  }

  // Check response_metadata.reasoning_content
  const responseMetadata = readRecordValue(value, 'response_metadata');
  const metadataReasoningContent = readNonEmptyString(readRecordValue(responseMetadata, 'reasoning_content'));
  if (metadataReasoningContent !== null) {
    return [metadataReasoningContent];
  }

  // Check direct reasoning_content field
  const directReasoningContent = readNonEmptyString(readRecordValue(value, 'reasoning_content'));
  if (directReasoningContent !== null) {
    return [directReasoningContent];
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
