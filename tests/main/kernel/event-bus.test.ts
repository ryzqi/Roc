import { describe, expect, it } from 'vitest';

import { EventBus } from '../../../src/main/kernel/event-bus';
import type { RocEventEnvelope } from '../../../src/main/kernel/types';

type LoggedEvent = {
  message: string;
  metadata?: Record<string, unknown>;
};

function createLogger(): { logger: { error(message: string, metadata?: Record<string, unknown>): void }; events: LoggedEvent[] } {
  const events: LoggedEvent[] = [];
  return {
    logger: {
      error: (message, metadata) => {
        events.push({ message, metadata });
      }
    },
    events
  };
}

function event(type: string, payload: Record<string, unknown> = {}): RocEventEnvelope<Record<string, unknown>> {
  return {
    type,
    source: '@roc/plugin-test',
    payload,
    createdAt: '2026-06-04T00:00:00.000Z'
  };
}

function delay(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('EventBus', () => {
  it('exposes publish and subscribe as the only public methods', () => {
    expect(Object.getOwnPropertyNames(EventBus.prototype).filter((name) => name !== 'constructor').sort()).toEqual([
      'publish',
      'subscribe'
    ]);
  });

  it('delivers matching event types only', async () => {
    const { logger } = createLogger();
    const bus = new EventBus(logger);
    const received: RocEventEnvelope[] = [];

    bus.subscribe('task.created', (message) => {
      received.push(message);
    });

    await bus.publish(event('task.updated'));
    await bus.publish(event('task.created', { id: 'task_1' }));

    expect(received).toHaveLength(1);
    expect(received[0]?.payload).toEqual({ id: 'task_1' });
  });

  it('stops delivery after unsubscribe', async () => {
    const { logger } = createLogger();
    const bus = new EventBus(logger);
    const received: RocEventEnvelope[] = [];
    const unsubscribe = bus.subscribe('task.created', (message) => {
      received.push(message);
    });

    await bus.publish(event('task.created', { id: 'task_1' }));
    unsubscribe();
    await bus.publish(event('task.created', { id: 'task_2' }));

    expect(received.map((message) => message.payload)).toEqual([{ id: 'task_1' }]);
  });

  it('awaits async handlers in subscription order', async () => {
    const { logger } = createLogger();
    const bus = new EventBus(logger);
    const calls: string[] = [];

    bus.subscribe('task.created', async () => {
      calls.push('first:start');
      await delay();
      calls.push('first:end');
    });
    bus.subscribe('task.created', () => {
      calls.push('second');
    });

    await bus.publish(event('task.created'));

    expect(calls).toEqual(['first:start', 'first:end', 'second']);
  });

  it('logs handler failures, keeps later handlers running, then rejects once', async () => {
    const { logger, events } = createLogger();
    const bus = new EventBus(logger);
    const calls: string[] = [];

    bus.subscribe('task.created', () => {
      calls.push('first');
      throw new Error('first failed');
    });
    bus.subscribe('task.created', async () => {
      calls.push('second:start');
      await delay();
      calls.push('second:end');
    });
    bus.subscribe('task.created', async () => {
      calls.push('third');
      throw new Error('third failed');
    });

    await expect(bus.publish(event('task.created'))).rejects.toThrow(/event_publish_failed/u);

    expect(calls).toEqual(['first', 'second:start', 'second:end', 'third']);
    expect(events).toEqual([
      expect.objectContaining({
        message: 'event_handler_failed',
        metadata: expect.objectContaining({ eventType: 'task.created', source: '@roc/plugin-test' })
      }),
      expect.objectContaining({
        message: 'event_handler_failed',
        metadata: expect.objectContaining({ eventType: 'task.created', source: '@roc/plugin-test' })
      })
    ]);
  });
});
