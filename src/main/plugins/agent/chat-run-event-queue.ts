import type { ChatRunEvent } from '../../../shared/types';

const defaultMaxEvents = 1_000;
const defaultCoalesceDelayMs = 16;
export const chatRunEventQueueMaxCoalescedChars = 8_192;

export function createChatRunEventQueue(input: { coalesceDelayMs?: number; maxCoalescedChars?: number; maxEvents?: number } = {}): AsyncIterable<ChatRunEvent> & {
  close: () => void;
  fail: (error: unknown) => void;
  push: (event: ChatRunEvent) => boolean;
  stats: () => { highWaterMark: number; queuedEventCount: number; maxEvents: number };
} {
  const maxEvents = input.maxEvents === undefined ? defaultMaxEvents : input.maxEvents;
  if (!Number.isInteger(maxEvents) || maxEvents <= 0) {
    throw new Error('chat_run_event_queue_max_events_invalid');
  }
  const maxCoalescedChars = input.maxCoalescedChars === undefined ? chatRunEventQueueMaxCoalescedChars : input.maxCoalescedChars;
  if (!Number.isInteger(maxCoalescedChars) || maxCoalescedChars <= 0) {
    throw new Error('chat_run_event_queue_max_coalesced_chars_invalid');
  }
  const coalesceDelayMs = input.coalesceDelayMs === undefined ? defaultCoalesceDelayMs : input.coalesceDelayMs;
  if (!Number.isInteger(coalesceDelayMs) || coalesceDelayMs <= 0) {
    throw new Error('chat_run_event_queue_coalesce_delay_invalid');
  }
  const events: ChatRunEvent[] = [];
  let nextEventIndex = 0;
  let highWaterMark = 0;
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
      if (closed || failure !== null) {
        return false;
      }
      if (nextEventIndex > 0) {
        events.splice(0, nextEventIndex);
        nextEventIndex = 0;
      }
      const last = events.at(-1);
      const coalesced = last === undefined ? null : coalesceTextDelta(last, event, maxCoalescedChars);
      if (coalesced !== null) {
        events[events.length - 1] = coalesced;
        return true;
      }
      if (events.length === maxEvents) {
        queue.fail(new Error('chat_run_event_queue_overflow'));
        return false;
      }
      events.push(event);
      highWaterMark = Math.max(highWaterMark, events.length);
      if (waiting !== null) {
        if (isCoalescibleTextDelta(event)) {
          scheduleDelayedDelivery();
        } else {
          clearDelayedDelivery();
          resolveWaitingEvent();
        }
      }
      return true;
    },
    close: (): void => {
      if (closed || failure !== null) {
        return;
      }
      closed = true;
      clearDelayedDelivery();
      if (waiting !== null) {
        resolveWaitingEvent();
      }
    },
    fail: (error: unknown): void => {
      if (closed || failure !== null) {
        return;
      }
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
      queuedEventCount: events.length - nextEventIndex,
      maxEvents
    }),
    [Symbol.asyncIterator](): AsyncIterator<ChatRunEvent> {
      return {
        next: async (): Promise<IteratorResult<ChatRunEvent>> => {
          if (nextEventIndex < events.length) {
            return takeNextEvent();
          }
          if (failure !== null) {
            throw failure;
          }
          if (closed) {
            return {
              done: true,
              value: undefined
            };
          }
          return await new Promise<IteratorResult<ChatRunEvent>>((resolve, reject) => {
            waiting = {
              resolve,
              reject
            };
          });
        }
      };
    }
  };

  function scheduleDelayedDelivery(): void {
    if (deliveryTimer !== null) {
      return;
    }
    deliveryTimer = setTimeout(() => {
      deliveryTimer = null;
      resolveWaitingEvent();
    }, coalesceDelayMs);
  }

  function clearDelayedDelivery(): void {
    if (deliveryTimer === null) {
      return;
    }
    clearTimeout(deliveryTimer);
    deliveryTimer = null;
  }

  function resolveWaitingEvent(): void {
    if (waiting === null) {
      return;
    }
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
    if (event === undefined) {
      throw new Error('chat_run_event_queue_empty');
    }
    nextEventIndex += 1;
    if (nextEventIndex === events.length) {
      events.length = 0;
      nextEventIndex = 0;
    }
    return {
      done: false,
      value: event
    };
  }

  return queue;
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

