// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PersistedTaskEvent, TaskMessageHistoryPage } from '../../src/shared/types';
import type { RocClient } from '../../src/renderer/shared/roc-client';
import {
  mergePersistedEvents,
  usePersistedThreadHistory,
  validatePersistedPage,
  type PersistedThreadHistory
} from '../../src/renderer/chat/use-persisted-thread-history';
import { createShellClient, flushPromises } from './app-shell-test-helpers';

describe('usePersistedThreadHistory', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('loads the latest page and prepends an older page', async () => {
    const client = createShellClient();
    vi.mocked(client.api.tasks.getThreadMessages)
      .mockResolvedValueOnce({ ok: true, data: page(151, 250, true, false) })
      .mockResolvedValueOnce({ ok: true, data: page(51, 150, true, true) });
    let current: PersistedThreadHistory | null = null;

    await renderHistory(client, 'thread-a', null, (value) => { current = value; });

    expect(client.api.tasks.getThreadMessages).toHaveBeenNthCalledWith(1, {
      threadId: 'thread-a',
      limit: 100,
      cursor: null
    });
    expect(requireHistory(current).events).toHaveLength(100);

    await act(async () => requireHistory(current).loadOlder());

    expect(client.api.tasks.getThreadMessages).toHaveBeenNthCalledWith(2, {
      threadId: 'thread-a',
      limit: 100,
      cursor: { direction: 'before', sequence: 151 }
    });
    expect(requireHistory(current).events.map((event) => event.sequence)).toEqual(
      Array.from({ length: 200 }, (_value, index) => index + 51)
    );
    expect(requireHistory(current).prependRevision).toBe(1);
  });

  it('ignores an old thread response after the thread changes', async () => {
    const client = createShellClient();
    const threadA = deferred<ReturnType<RocClient['api']['tasks']['getThreadMessages']>>();
    vi.mocked(client.api.tasks.getThreadMessages)
      .mockReturnValueOnce(threadA.promise)
      .mockResolvedValueOnce({ ok: true, data: page(1, 2, false, false, 'thread-b') });
    let current: PersistedThreadHistory | null = null;

    await renderHistory(client, 'thread-a', null, (value) => { current = value; });
    await renderHistory(client, 'thread-b', null, (value) => { current = value; });
    threadA.resolve({ ok: true, data: page(151, 250, true, false, 'thread-a') });
    await act(flushPromises);

    expect(requireHistory(current).threadId).toBe('thread-b');
    expect(requireHistory(current).events.map((event) => event.threadId)).toEqual(['thread-b', 'thread-b']);
  });

  it('follows all after pages for one persisted signal', async () => {
    const client = createShellClient();
    vi.mocked(client.api.tasks.getThreadMessages)
      .mockResolvedValueOnce({ ok: true, data: page(1, 100, false, false) })
      .mockResolvedValueOnce({ ok: true, data: page(101, 200, true, true) })
      .mockResolvedValueOnce({ ok: true, data: page(201, 300, true, true) })
      .mockResolvedValueOnce({ ok: true, data: page(301, 350, true, false) });
    let current: PersistedThreadHistory | null = null;

    await renderHistory(client, 'thread-a', null, (value) => { current = value; });
    await renderHistory(client, 'thread-a', 'event-350', (value) => { current = value; });

    expect(client.api.tasks.getThreadMessages).toHaveBeenNthCalledWith(2, {
      threadId: 'thread-a',
      limit: 100,
      cursor: { direction: 'after', sequence: 100 }
    });
    expect(requireHistory(current).events).toHaveLength(350);
    expect(requireHistory(current).events.at(-1)?.sequence).toBe(350);
  });

  it('surfaces sequence and id conflicts without clearing valid events', async () => {
    const client = createShellClient();
    const initial = page(1, 2, false, false);
    const conflict = page(3, 3, true, false);
    conflict.items[0] = { ...conflict.items[0]!, id: 'event-2' };
    vi.mocked(client.api.tasks.getThreadMessages)
      .mockResolvedValueOnce({ ok: true, data: initial })
      .mockResolvedValueOnce({ ok: true, data: conflict });
    let current: PersistedThreadHistory | null = null;

    await renderHistory(client, 'thread-a', null, (value) => { current = value; });
    await renderHistory(client, 'thread-a', 'event-3', (value) => { current = value; });

    expect(requireHistory(current).error).toBe('task_history_event_id_sequence_conflict');
    expect(requireHistory(current).events.map((event) => event.sequence)).toEqual([1, 2]);
  });

  it('rejects missing, non-monotonic, and conflicting sequence contracts', () => {
    const missing = page(1, 1, false, false);
    Reflect.deleteProperty(missing.items[0]!, 'sequence');
    expect(() => validatePersistedPage(missing, 'thread-a')).toThrow('task_history_sequence_non_monotonic');

    const nonMonotonic = page(1, 2, false, false);
    nonMonotonic.items.reverse();
    expect(() => validatePersistedPage(nonMonotonic, 'thread-a')).toThrow('task_history_sequence_non_monotonic');

    expect(() =>
      mergePersistedEvents(page(1, 1, false, false).items, [
        { ...page(2, 2, false, false).items[0]!, sequence: 1 }
      ])
    ).toThrow('task_history_sequence_id_conflict');
  });

  async function renderHistory(
    client: RocClient,
    threadId: string | null,
    signal: string | null,
    onChange: (history: PersistedThreadHistory) => void
  ): Promise<void> {
    await act(async () => {
      root.render(
        <HistoryHarness
          client={client}
          threadId={threadId}
          latestPersistedThreadEventId={signal}
          onChange={onChange}
        />
      );
      await flushPromises();
    });
  }
});

function HistoryHarness(input: {
  client: RocClient;
  threadId: string | null;
  latestPersistedThreadEventId: string | null;
  onChange(history: PersistedThreadHistory): void;
}): null {
  const history = usePersistedThreadHistory(input);
  useEffect(() => input.onChange(history), [history, input]);
  return null;
}

function page(
  start: number,
  end: number,
  hasMoreBefore: boolean,
  hasMoreAfter: boolean,
  threadId = 'thread-a'
): TaskMessageHistoryPage {
  const items: PersistedTaskEvent[] = [];
  for (let sequence = start; sequence <= end; sequence += 1) {
    items.push({
      id: `event-${sequence}`,
      threadId,
      runId: 'run-a',
      type: 'message',
      payload: {
        role: 'assistant',
        content: `message-${sequence}`,
        providerId: 'test-provider',
        modelId: 'test-model'
      },
      createdAt: '2026-07-10T00:00:00.000Z',
      sequence
    });
  }
  return {
    items,
    oldestSequence: items[0]?.sequence ?? null,
    newestSequence: items.at(-1)?.sequence ?? null,
    hasMoreBefore,
    hasMoreAfter
  };
}

function requireHistory(value: PersistedThreadHistory | null): PersistedThreadHistory {
  if (value === null) {
    throw new Error('history_not_rendered');
  }
  return value;
}

function deferred<T extends Promise<unknown>>(): {
  promise: T;
  resolve(value: Awaited<T>): void;
} {
  let resolvePromise: ((value: Awaited<T>) => void) | null = null;
  const promise = new Promise<Awaited<T>>((resolve) => {
    resolvePromise = resolve;
  }) as T;
  return {
    promise,
    resolve(value) {
      if (resolvePromise === null) {
        throw new Error('deferred_not_initialized');
      }
      resolvePromise(value);
    }
  };
}
