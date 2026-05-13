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

export async function readReasoningFromMessageOutput(output: unknown): Promise<string | null> {
  const resolved = await Promise.resolve(output);
  if (!isRecord(resolved)) {
    return null;
  }

  const additionalReasoning = readNonEmptyString(readRecordValue(readRecordValue(resolved, 'additional_kwargs'), 'reasoning_content'));
  if (additionalReasoning !== null) {
    return additionalReasoning;
  }

  const contentBlocks = readRecordValue(resolved, 'contentBlocks');
  if (!Array.isArray(contentBlocks)) {
    return null;
  }

  const values = contentBlocks.flatMap((block) => readReasoningBlockText(block));
  return values.length === 0 ? null : values.join('');
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
