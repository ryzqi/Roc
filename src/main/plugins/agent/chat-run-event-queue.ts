import { Buffer } from 'node:buffer';

import type { ChatRunEvent } from '../../../shared/types';

const defaultMaxEvents = 1_000;
const defaultMaxBytes = 8 * 1024 * 1024;
const defaultMaxEventBytes = 1 * 1024 * 1024;
const defaultCoalesceDelayMs = 16;
export const chatRunEventQueueMaxCoalescedChars = 8_192;

export function createChatRunEventQueue(input: {
  coalesceDelayMs?: number;
  maxCoalescedChars?: number;
  maxEvents?: number;
  maxBytes?: number;
  maxEventBytes?: number;
} = {}): AsyncIterable<ChatRunEvent> & {
  close: () => void;
  fail: (error: unknown) => void;
  push: (event: ChatRunEvent) => boolean;
  stats: () => {
    highWaterMark: number;
    highWaterBytes: number;
    queuedEventCount: number;
    queuedBytes: number;
    maxEvents: number;
    maxBytes: number;
  };
} {
  const maxEvents = input.maxEvents ?? defaultMaxEvents;
  const maxBytes = input.maxBytes ?? defaultMaxBytes;
  const maxEventBytes = input.maxEventBytes ?? defaultMaxEventBytes;
  const maxCoalescedChars = input.maxCoalescedChars ?? chatRunEventQueueMaxCoalescedChars;
  const coalesceDelayMs = input.coalesceDelayMs ?? defaultCoalesceDelayMs;
  if (!Number.isInteger(maxEvents) || maxEvents <= 0) throw new Error('chat_run_event_queue_max_events_invalid');
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new Error('chat_run_event_queue_max_bytes_invalid');
  if (!Number.isInteger(maxEventBytes) || maxEventBytes <= 0 || maxEventBytes > maxBytes) {
    throw new Error('chat_run_event_queue_max_event_bytes_invalid');
  }
  if (!Number.isInteger(maxCoalescedChars) || maxCoalescedChars <= 0) {
    throw new Error('chat_run_event_queue_max_coalesced_chars_invalid');
  }
  if (!Number.isInteger(coalesceDelayMs) || coalesceDelayMs <= 0) {
    throw new Error('chat_run_event_queue_coalesce_delay_invalid');
  }

  const events: ChatRunEvent[] = [];
  const eventBytes: number[] = [];
  let nextEventIndex = 0;
  let queuedBytes = 0;
  let highWaterMark = 0;
  let highWaterBytes = 0;
  let closed = false;
  let failure: unknown = null;
  let deliveryTimer: ReturnType<typeof setTimeout> | null = null;
  let waiting:
    | {
        resolve: (result: IteratorResult<ChatRunEvent>) => void;
        reject: (error: unknown) => void;
      }
    | null = null;

  const queue = {
    push: (event: ChatRunEvent): boolean => {
      if (closed || failure !== null) return false;
      const serialized = serializeEvent(event);
      if (serialized === null) {
        queue.fail(new Error('chat_run_event_queue_event_not_serializable'));
        return false;
      }
      const bytes = Buffer.byteLength(serialized, 'utf8');
      if (bytes > maxEventBytes) {
        queue.fail(new Error('chat_run_event_queue_event_too_large'));
        return false;
      }
      if (nextEventIndex > 0) {
        events.splice(0, nextEventIndex);
        eventBytes.splice(0, nextEventIndex);
        nextEventIndex = 0;
      }
      if (event.type === 'run_usage') {
        const queuedUsageIndex = findQueuedUsageIndex(events, nextEventIndex, event.runId);
        if (queuedUsageIndex >= nextEventIndex) removeQueuedEvent(queuedUsageIndex);
      }
      const lastIndex = events.length - 1;
      const last = lastIndex < nextEventIndex ? undefined : events[lastIndex];
      const coalesced = last === undefined ? null : coalesceTextDelta(last, event, maxCoalescedChars);
      if (coalesced !== null) {
        const coalescedBytes = serializedBytes(coalesced);
        if (coalescedBytes === null || coalescedBytes > maxEventBytes) {
          queue.fail(new Error('chat_run_event_queue_event_too_large'));
          return false;
        }
        const previousBytes = eventBytes[lastIndex] ?? 0;
        if (queuedBytes - previousBytes + coalescedBytes > maxBytes) {
          queue.fail(new Error('chat_run_event_queue_byte_overflow'));
          return false;
        }
        events[lastIndex] = coalesced;
        eventBytes[lastIndex] = coalescedBytes;
        queuedBytes += coalescedBytes - previousBytes;
        highWaterBytes = Math.max(highWaterBytes, queuedBytes);
        return true;
      }
      if (events.length - nextEventIndex >= maxEvents) {
        queue.fail(new Error('chat_run_event_queue_overflow'));
        return false;
      }
      if (queuedBytes + bytes > maxBytes) {
        queue.fail(new Error('chat_run_event_queue_byte_overflow'));
        return false;
      }
      events.push(event);
      eventBytes.push(bytes);
      queuedBytes += bytes;
      highWaterMark = Math.max(highWaterMark, events.length - nextEventIndex);
      highWaterBytes = Math.max(highWaterBytes, queuedBytes);
      if (waiting !== null) {
        if (isCoalescibleTextDelta(event)) scheduleDelayedDelivery();
        else {
          clearDelayedDelivery();
          resolveWaitingEvent();
        }
      }
      return true;
    },
    close: (): void => {
      if (closed || failure !== null) return;
      closed = true;
      clearDelayedDelivery();
      if (waiting !== null) resolveWaitingEvent();
    },
    fail: (error: unknown): void => {
      if (closed || failure !== null) return;
      failure = error;
      clearDelayedDelivery();
      if (waiting !== null) {
        const current = waiting;
        waiting = null;
        current.reject(error);
      }
    },
    stats: () => ({
      highWaterMark,
      highWaterBytes,
      queuedEventCount: events.length - nextEventIndex,
      queuedBytes,
      maxEvents,
      maxBytes
    }),
    [Symbol.asyncIterator](): AsyncIterator<ChatRunEvent> {
      return {
        next: async (): Promise<IteratorResult<ChatRunEvent>> => {
          if (nextEventIndex < events.length) return takeNextEvent();
          if (failure !== null) throw failure;
          if (closed) return { done: true, value: undefined };
          return new Promise<IteratorResult<ChatRunEvent>>((resolve, reject) => {
            waiting = { resolve, reject };
          });
        }
      };
    }
  };

  function removeQueuedEvent(index: number): void {
    const removedBytes = eventBytes[index] ?? 0;
    events.splice(index, 1);
    eventBytes.splice(index, 1);
    queuedBytes -= removedBytes;
  }

  function scheduleDelayedDelivery(): void {
    if (deliveryTimer !== null) return;
    deliveryTimer = setTimeout(() => {
      deliveryTimer = null;
      resolveWaitingEvent();
    }, coalesceDelayMs);
  }

  function clearDelayedDelivery(): void {
    if (deliveryTimer === null) return;
    clearTimeout(deliveryTimer);
    deliveryTimer = null;
  }

  function resolveWaitingEvent(): void {
    if (waiting === null) return;
    const current = waiting;
    waiting = null;
    if (nextEventIndex < events.length) {
      current.resolve(takeNextEvent());
      return;
    }
    if (failure !== null) {
      current.reject(failure);
      return;
    }
    if (closed) {
      current.resolve({ done: true, value: undefined });
      return;
    }
    waiting = current;
  }

  function takeNextEvent(): IteratorResult<ChatRunEvent> {
    const event = events[nextEventIndex];
    if (event === undefined) throw new Error('chat_run_event_queue_empty');
    queuedBytes -= eventBytes[nextEventIndex] ?? 0;
    nextEventIndex += 1;
    if (nextEventIndex === events.length) {
      events.length = 0;
      eventBytes.length = 0;
      nextEventIndex = 0;
    }
    return { done: false, value: event };
  }

  return queue;
}

function serializeEvent(event: ChatRunEvent): string | null {
  try {
    return JSON.stringify(event) ?? null;
  } catch {
    return null;
  }
}

function serializedBytes(event: ChatRunEvent): number | null {
  const serialized = serializeEvent(event);
  return serialized === null ? null : Buffer.byteLength(serialized, 'utf8');
}

function findQueuedUsageIndex(events: readonly ChatRunEvent[], from: number, runId: string): number {
  for (let index = events.length - 1; index >= from; index -= 1) {
    const event = events[index];
    if (event?.type === 'run_usage' && event.runId === runId) return index;
  }
  return -1;
}

function isCoalescibleTextDelta(event: ChatRunEvent): boolean {
  return event.type === 'assistant_block' && (event.block.kind === 'text' || event.block.kind === 'reasoning') && event.block.phase === 'delta';
}

function coalesceTextDelta(left: ChatRunEvent, right: ChatRunEvent, maxCoalescedChars: number): ChatRunEvent | null {
  if (
    left.type === 'assistant_block' &&
    right.type === 'assistant_block' &&
    left.runId === right.runId &&
    (left.block.kind === 'text' || left.block.kind === 'reasoning') &&
    left.block.kind === right.block.kind &&
    left.block.blockId === right.block.blockId &&
    left.block.phase === 'delta' &&
    right.block.phase === 'delta' &&
    typeof left.block.text === 'string' &&
    typeof right.block.text === 'string' &&
    left.block.text.length + right.block.text.length <= maxCoalescedChars
  ) {
    return {
      ...left,
      block: {
        ...left.block,
        text: left.block.text + right.block.text
      }
    };
  }
  return null;
}
