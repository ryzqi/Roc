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
