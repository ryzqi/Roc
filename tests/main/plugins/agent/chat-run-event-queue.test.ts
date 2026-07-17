import { describe, expect, it } from 'vitest';

import { createChatRunEventQueue } from '../../../../src/main/plugins/agent/chat-run-event-queue';

describe('ChatRunEventQueue', () => {
  it('coalesces adjacent text deltas and records high-water evidence', async () => {
    const queue = createChatRunEventQueue({ maxEvents: 2 });
    queue.push(textEvent('first'));
    queue.push(textEvent(' second'));

    expect(queue.stats()).toEqual({ highWaterMark: 1, queuedEventCount: 1, maxEvents: 2 });
    queue.close();

    await expect(collect(queue)).resolves.toEqual([textEvent('first second')]);
  });

  it('fails the stream with a structured overflow instead of growing unboundedly', async () => {
    const queue = createChatRunEventQueue({ maxEvents: 2 });
    queue.push(textEvent('one', 'text-one'));
    queue.push(textEvent('two', 'text-two'));

    expect(queue.push(textEvent('three', 'text-three'))).toBe(false);
    expect(queue.stats()).toEqual({ highWaterMark: 2, queuedEventCount: 2, maxEvents: 2 });

    await expect(collect(queue)).rejects.toThrow('chat_run_event_queue_overflow');
  });

  it('counts only unconsumed events when applying the bounded capacity', async () => {
    const queue = createChatRunEventQueue({ maxEvents: 2 });
    queue.push(textEvent('one', 'text-one'));
    queue.push(textEvent('two', 'text-two'));
    const iterator = queue[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({ done: false, value: textEvent('one', 'text-one') });

    expect(queue.push(textEvent('three', 'text-three'))).toBe(true);
    queue.close();

    await expect(collect({ [Symbol.asyncIterator]: () => iterator })).resolves.toEqual([
      textEvent('two', 'text-two'),
      textEvent('three', 'text-three')
    ]);
  });

  it('coalesces reasoning deltas only up to the configured character bound', async () => {
    const queue = createChatRunEventQueue({ maxCoalescedChars: 10, maxEvents: 2 });
    queue.push(reasoningEvent('123456'));
    queue.push(reasoningEvent('7890'));
    queue.push(reasoningEvent('x'));
    queue.close();

    await expect(collect(queue)).resolves.toEqual([reasoningEvent('1234567890'), reasoningEvent('x')]);
  });

  it('coalesces 10k text deltas even when a consumer is already waiting', async () => {
    const queue = createChatRunEventQueue({ coalesceDelayMs: 60_000, maxEvents: 2_000 });
    const consumer = collect(queue);

    for (let index = 0; index < 10_000; index += 1) {
      expect(queue.push(textEvent('x'))).toBe(true);
      await Promise.resolve();
    }
    queue.close();

    const events = await consumer;
    expect(events).toHaveLength(2);
    expect(
      events
        .map((event) => (isTextEvent(event) ? event.block.text : ''))
        .join('')
    ).toBe('x'.repeat(10_000));
  });
});

function textEvent(text: string, blockId = 'text-1') {
  return {
    type: 'assistant_block' as const,
    runId: 'run_1',
    block: {
      kind: 'text' as const,
      blockId,
      phase: 'delta' as const,
      text
    }
  };
}

function reasoningEvent(text: string) {
  return {
    type: 'assistant_block' as const,
    runId: 'run_1',
    block: {
      kind: 'reasoning' as const,
      blockId: 'reasoning-1',
      phase: 'delta' as const,
      text
    }
  };
}

function isTextEvent(event: unknown): event is ReturnType<typeof textEvent> {
  return (
    typeof event === 'object' &&
    event !== null &&
    Reflect.get(event, 'type') === 'assistant_block' &&
    Reflect.get(Reflect.get(event, 'block') as object, 'kind') === 'text'
  );
}

async function collect(queue: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of queue) {
    events.push(event);
  }
  return events;
}
