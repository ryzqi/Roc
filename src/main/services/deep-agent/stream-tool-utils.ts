import * as recordUtils from './record-utils';
import { redact } from './redact';

export function readToolCallId(call: unknown): string | null {
  const callId = recordUtils.readNonEmptyString(recordUtils.readRecordValue(call, 'callId'));
  if (callId !== null) {
    return callId;
  }
  const id = recordUtils.readNonEmptyString(recordUtils.readRecordValue(call, 'id'));
  if (id !== null) {
    return id;
  }
  return null;
}

export function readToolChunkId(chunk: { data: Record<string, unknown> }, index: number): string {
  const id = recordUtils.readNonEmptyString(recordUtils.readRecordValue(chunk.data, 'id'));
  if (id !== null) {
    return id;
  }
  return `chunk-${index}`;
}

export function buildToolCallChunkData(block: Record<string, unknown>): Record<string, unknown> {
  const entries: Array<[string, unknown]> = [];
  for (const key of ['id', 'args', 'input', 'index']) {
    const value = recordUtils.readRecordValue(block, key);
    if (value !== undefined) {
      entries.push([key, redactUnknown(value)]);
    }
  }
  return Object.fromEntries(entries);
}

export function readContentBlocks(value: unknown): unknown[] {
  if (!recordUtils.isRecord(value)) {
    return [];
  }
  const contentBlocks = recordUtils.readRecordValue(value, 'contentBlocks');
  if (Array.isArray(contentBlocks)) {
    return contentBlocks;
  }
  const content = recordUtils.readRecordValue(value, 'content');
  return Array.isArray(content) ? content : [];
}

export function redactUnknown(value: unknown): unknown {
  if (typeof value === 'string') {
    return redact(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item));
  }
  if (recordUtils.isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactUnknown(entry)])
    );
  }
  return value;
}
