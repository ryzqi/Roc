import { useCallback, useEffect, useRef, useState } from 'react';

import type { PersistedTaskEvent, TaskMessageHistoryPage } from '../../shared/types';
import type { RocClient } from '../shared/roc-client';

const historyPageLimit = 100;

export type PersistedThreadHistory = {
  threadId: string | null;
  events: PersistedTaskEvent[];
  prependRevision: number;
  hasMoreBefore: boolean;
  loadingInitial: boolean;
  loadingOlder: boolean;
  error: string | null;
  loadOlder(): Promise<void>;
};

type HistoryState = Omit<PersistedThreadHistory, 'loadOlder'>;

export function usePersistedThreadHistory(input: {
  client: RocClient;
  threadId: string | null;
  latestPersistedThreadEventId: string | null;
}): PersistedThreadHistory {
  const generationRef = useRef(0);
  const latestSignalRef = useRef<string | null>(input.latestPersistedThreadEventId);
  const stateRef = useRef<HistoryState>(emptyHistoryState(input.threadId));
  const [state, setState] = useState<HistoryState>(() => stateRef.current);

  const replaceState = useCallback((next: HistoryState): void => {
    stateRef.current = next;
    setState(next);
  }, []);

  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    const initialSignal = input.latestPersistedThreadEventId;
    latestSignalRef.current = initialSignal;
    const threadId = input.threadId;
    if (threadId === null) {
      replaceState(emptyHistoryState(null));
      return;
    }
    replaceState({ ...emptyHistoryState(threadId), loadingInitial: true });
    void requestPage(input.client, { threadId, limit: historyPageLimit, cursor: null })
      .then((page) => {
        if (generationRef.current !== generation) {
          return;
        }
        validatePersistedPage(page, threadId);
        replaceState({
          threadId,
          events: page.items,
          prependRevision: 0,
          hasMoreBefore: page.hasMoreBefore,
          loadingInitial: false,
          loadingOlder: false,
          error: null
        });
        if (latestSignalRef.current !== initialSignal) {
          void loadAfterPages(input.client, threadId, generation, generationRef, stateRef, replaceState).catch(
            (error: unknown) => {
              if (generationRef.current === generation) {
                replaceState({ ...stateRef.current, error: errorMessage(error) });
              }
            }
          );
        }
      })
      .catch((error: unknown) => {
        if (generationRef.current !== generation) {
          return;
        }
        replaceState({
          ...stateRef.current,
          loadingInitial: false,
          error: errorMessage(error)
        });
      });
  }, [input.client, input.threadId, replaceState]);

  useEffect(() => {
    if (latestSignalRef.current === input.latestPersistedThreadEventId) {
      return;
    }
    latestSignalRef.current = input.latestPersistedThreadEventId;
    const threadId = input.threadId;
    if (threadId === null || stateRef.current.threadId !== threadId || stateRef.current.loadingInitial) {
      return;
    }
    const generation = generationRef.current;
    void loadAfterPages(input.client, threadId, generation, generationRef, stateRef, replaceState).catch(
      (error: unknown) => {
        if (generationRef.current !== generation) {
          return;
        }
        replaceState({ ...stateRef.current, error: errorMessage(error) });
      }
    );
  }, [input.client, input.latestPersistedThreadEventId, input.threadId, replaceState]);

  const loadOlder = useCallback(async (): Promise<void> => {
    const current = stateRef.current;
    if (
      current.threadId === null ||
      current.loadingInitial ||
      current.loadingOlder ||
      !current.hasMoreBefore
    ) {
      return;
    }
    const oldest = current.events[0];
    if (oldest === undefined) {
      throw new Error('task_history_oldest_sequence_missing');
    }
    const generation = generationRef.current;
    replaceState({ ...current, loadingOlder: true, error: null });
    try {
      const page = await requestPage(input.client, {
        threadId: current.threadId,
        limit: historyPageLimit,
        cursor: { direction: 'before', sequence: oldest.sequence }
      });
      if (generationRef.current !== generation) {
        return;
      }
      validatePersistedPage(page, current.threadId);
      const newest = page.items.at(-1);
      if (newest !== undefined && newest.sequence >= oldest.sequence) {
        throw new Error('task_history_before_cursor_not_decreased');
      }
      const events = mergePersistedEvents(stateRef.current.events, page.items);
      replaceState({
        ...stateRef.current,
        events,
        prependRevision: stateRef.current.prependRevision + 1,
        hasMoreBefore: page.hasMoreBefore,
        loadingOlder: false,
        error: null
      });
    } catch (error) {
      if (generationRef.current !== generation) {
        return;
      }
      replaceState({ ...stateRef.current, loadingOlder: false, error: errorMessage(error) });
    }
  }, [input.client, replaceState]);

  return { ...state, loadOlder };
}

async function loadAfterPages(
  client: RocClient,
  threadId: string,
  generation: number,
  generationRef: React.MutableRefObject<number>,
  stateRef: React.MutableRefObject<HistoryState>,
  replaceState: (state: HistoryState) => void
): Promise<void> {
  let newest = stateRef.current.events.at(-1);
  if (newest === undefined) {
    return;
  }
  let hasMoreAfter = true;
  while (hasMoreAfter) {
    const page = await requestPage(client, {
      threadId,
      limit: historyPageLimit,
      cursor: { direction: 'after', sequence: newest.sequence }
    });
    if (generationRef.current !== generation) {
      return;
    }
    validatePersistedPage(page, threadId);
    const pageNewest = page.items.at(-1);
    if (pageNewest !== undefined && pageNewest.sequence <= newest.sequence) {
      throw new Error('task_history_after_cursor_not_advanced');
    }
    const events = mergePersistedEvents(stateRef.current.events, page.items);
    replaceState({ ...stateRef.current, events, error: null });
    hasMoreAfter = page.hasMoreAfter;
    if (!hasMoreAfter) {
      return;
    }
    if (pageNewest === undefined) {
      throw new Error('task_history_after_page_empty_with_more');
    }
    newest = pageNewest;
  }
}

async function requestPage(
  client: RocClient,
  request: Parameters<RocClient['api']['tasks']['getThreadMessages']>[0]
): Promise<TaskMessageHistoryPage> {
  const result = await client.api.tasks.getThreadMessages(request);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.data;
}

export function validatePersistedPage(page: TaskMessageHistoryPage, threadId: string): void {
  let previousSequence = 0;
  const ids = new Set<string>();
  for (const event of page.items) {
    if (event.threadId !== threadId) {
      throw new Error('task_history_thread_mismatch');
    }
    if (!Number.isInteger(event.sequence) || event.sequence <= previousSequence) {
      throw new Error('task_history_sequence_non_monotonic');
    }
    if (ids.has(event.id)) {
      throw new Error('task_history_event_id_duplicate');
    }
    ids.add(event.id);
    previousSequence = event.sequence;
  }
  const first = page.items[0];
  const last = page.items.at(-1);
  const expectedOldest = first === undefined ? null : first.sequence;
  const expectedNewest = last === undefined ? null : last.sequence;
  if (page.oldestSequence !== expectedOldest || page.newestSequence !== expectedNewest) {
    throw new Error('task_history_page_metadata_mismatch');
  }
}

export function mergePersistedEvents(
  current: readonly PersistedTaskEvent[],
  incoming: readonly PersistedTaskEvent[]
): PersistedTaskEvent[] {
  const byId = new Map(current.map((event) => [event.id, event]));
  const bySequence = new Map(current.map((event) => [event.sequence, event]));
  for (const event of incoming) {
    const sameId = byId.get(event.id);
    if (sameId !== undefined && sameId.sequence !== event.sequence) {
      throw new Error('task_history_event_id_sequence_conflict');
    }
    const sameSequence = bySequence.get(event.sequence);
    if (sameSequence !== undefined && sameSequence.id !== event.id) {
      throw new Error('task_history_sequence_id_conflict');
    }
    byId.set(event.id, event);
    bySequence.set(event.sequence, event);
  }
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
}

function emptyHistoryState(threadId: string | null): HistoryState {
  return {
    threadId,
    events: [],
    prependRevision: 0,
    hasMoreBefore: false,
    loadingInitial: false,
    loadingOlder: false,
    error: null
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
