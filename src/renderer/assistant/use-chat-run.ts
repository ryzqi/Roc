import { startTransition, useCallback, useEffect, useRef, useState } from 'react';
import {
  applyChatRunEvent,
  createEmptyChatRunState,
  type ChatRunState
} from './run-state';
import type { ChatRunEvent, SequencedChatRunEvent } from '../../shared/types';
import type { RocClient } from '../shared/roc-client';

export function applyChatRunEventBatch(state: ChatRunState, events: ChatRunEvent[]): ChatRunState {
  if (events.length === 0) {
    return state;
  }
  return coalesceChatRunEvents(events).reduce(applyChatRunEvent, state);
}

export function coalesceChatRunEvents(events: readonly ChatRunEvent[]): ChatRunEvent[] {
  const result: ChatRunEvent[] = [];
  for (const event of events) {
    const previous = result[result.length - 1];
    if (previous !== undefined && canMergeChatRunEvents(previous, event)) {
      result[result.length - 1] = mergeChatRunEvents(previous, event);
      continue;
    }
    result.push(event);
  }
  return result;
}

export function isTerminalChatRunEvent(event: ChatRunEvent): boolean {
  return event.type === 'run_started' || event.type === 'run_completed' || event.type === 'run_cancelled' || event.type === 'run_failed';
}

export function normalizeSequencedChatRunEvent(event: ChatRunEvent | SequencedChatRunEvent): ChatRunEvent {
  if (isSequencedChatRunEvent(event)) {
    return event.event;
  }
  return event;
}

// 每个运行只留一个序号。聊天会话不重置时，旧运行号不能无限留在 renderer。
export const maxSeenRunSequences = 64;

export function shouldApplySequencedRunEvent(
  seen: Map<string, number>,
  event: SequencedChatRunEvent,
  maxEntries = maxSeenRunSequences
): boolean {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new Error('chat_run_sequence_limit_invalid');
  }
  const previous = seen.get(event.runId);
  if (previous !== undefined && event.sequence <= previous) {
    return false;
  }
  if (seen.has(event.runId)) {
    seen.delete(event.runId);
  }
  seen.set(event.runId, event.sequence);
  while (seen.size > maxEntries) {
    const oldest = seen.keys().next().value;
    if (oldest === undefined || oldest === event.runId) {
      break;
    }
    seen.delete(oldest);
  }
  return true;
}

/**
 * True only for the **wrapper** shape `{ runId, sequence, event }`, never for a plain event.
 *
 * The original guard was `'sequence' in event && 'event' in event`, which is also true for a
 * *live* `subagent_event` — that event carries its own `sequence` and an `event` field (the
 * subagent's payload). Every live subagent event was therefore unwrapped into
 * `<subagent payload>`, whose `type` is undefined, and then dropped by the reducer: subagent
 * cards only ever appeared from history/replay. Checking for the absence of `type` is what
 * distinguishes the wrapper from every real event.
 */
export function isSequencedChatRunEvent(event: ChatRunEvent | SequencedChatRunEvent): event is SequencedChatRunEvent {
  if (typeof event !== 'object' || event === null) {
    return false;
  }
  if ('type' in event) {
    return false;
  }
  return 'sequence' in event && 'event' in event;
}

function canMergeChatRunEvents(left: ChatRunEvent, right: ChatRunEvent): boolean {
  if (left.type !== 'assistant_block' || right.type !== 'assistant_block') {
    return false;
  }
  if (left.runId !== right.runId || left.block.kind !== right.block.kind) {
    return false;
  }
  if (left.block.kind !== 'text' && left.block.kind !== 'reasoning') {
    return false;
  }
  if (right.block.kind !== 'text' && right.block.kind !== 'reasoning') {
    return false;
  }
  return left.block.blockId === right.block.blockId;
}

function mergeChatRunEvents(left: ChatRunEvent, right: ChatRunEvent): ChatRunEvent {
  if (left.type !== 'assistant_block' || right.type !== 'assistant_block') {
    return right;
  }
  if (left.block.kind === 'text' && right.block.kind === 'text') {
    return {
      ...right,
      block: {
        ...right.block,
        text: `${left.block.text}${right.block.text}`
      }
    };
  }
  if (left.block.kind === 'reasoning' && right.block.kind === 'reasoning') {
    return {
      ...right,
      block: {
        ...right.block,
        text: `${left.block.text}${right.block.text}`
      }
    };
  }
  return right;
}

type PendingChatRunEventsRef = {
  current: ChatRunEvent[];
};

// 窗口隐藏时 requestAnimationFrame 不会刷新。只 push 会让整段运行的增量事件留在 renderer。
export const maxPendingChatRunEvents = 64;

export function appendCoalescedChatRunEvent(pending: readonly ChatRunEvent[], event: ChatRunEvent): ChatRunEvent[] {
  const last = pending.at(-1);
  if (last === undefined) {
    return [event];
  }
  const mergedTail = coalesceChatRunEvents([last, event]);
  const merged = mergedTail[0];
  if (mergedTail.length === 1 && merged !== undefined) {
    return [...pending.slice(0, -1), merged];
  }
  return [...pending, event];
}

type RafHandleRef = {
  current: number | null;
};

export function clearPendingChatRunEvents(
  pendingEventsRef: PendingChatRunEventsRef,
  rafHandleRef: RafHandleRef,
  cancelFrame: (handle: number) => void = cancelAnimationFrame
): void {
  if (rafHandleRef.current !== null) {
    cancelFrame(rafHandleRef.current);
    rafHandleRef.current = null;
  }
  pendingEventsRef.current = [];
}

export type ChatRunController = {
  state: ChatRunState;
  reset: () => void;
  setError: (message: string | null) => void;
  errorMessage: string | null;
  /**
   * Applies a **replayed** batch of sequenced events (P4 addition).
   *
   * The legacy hook could only consume the live `chat.onRunEvent` stream. Gate 5 requires
   * the opposite direction: a run that started while the panel was closed (or before a
   * project switch) must be restorable, and `chat.getRunEvents` is the only source for
   * those events. It goes through the same sequence de-duplication as live events, so a
   * replay that overlaps what the live stream already delivered cannot double-apply.
   */
  applyReplay: (events: readonly SequencedChatRunEvent[]) => void;
};

export function useChatRun(client: RocClient, scope: {
  threadId: string | null;
  acceptUnboundEvents: boolean;
}): ChatRunController {
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const acceptedRunIds = useRef(new Set<string>());
  const accepts = (event: ChatRunEvent): boolean => {
    if ('threadId' in event) {
      const current = scopeRef.current;
      if (current.threadId !== null ? event.threadId !== current.threadId
        : !current.acceptUnboundEvents && !acceptedRunIds.current.has(event.runId)) return false;
      acceptedRunIds.current.add(event.runId);
    }
    return acceptedRunIds.current.has(event.runId);
  };
  const acceptsRef = useRef(accepts);
  acceptsRef.current = accepts;
  const [state, setState] = useState<ChatRunState>(() => createEmptyChatRunState());
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const pendingEventsRef = useRef<ChatRunEvent[]>([]);
  const rafHandleRef = useRef<number | null>(null);
  const hiddenRef = useRef(false);
  const seenSequenceByRunIdRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    function flush(): void {
      rafHandleRef.current = null;
      const buffered = coalesceChatRunEvents(pendingEventsRef.current);
      if (buffered.length === 0) {
        return;
      }
      pendingEventsRef.current = [];
      startTransition(() => {
        setState((current) => applyChatRunEventBatch(current, buffered));
      });
    }

    function scheduleFlush(): void {
      if (hiddenRef.current || rafHandleRef.current !== null) {
        return;
      }
      rafHandleRef.current = requestAnimationFrame(flush);
    }

    const unsubscribeHidden = client.api.window.onHidden((snapshot) => {
      hiddenRef.current = snapshot.hidden;
      if (snapshot.hidden) {
        if (rafHandleRef.current !== null) {
          cancelAnimationFrame(rafHandleRef.current);
          rafHandleRef.current = null;
        }
        return;
      }
      flush();
    });

    const unsubscribe = client.api.chat.onRunEvent((rawEvent) => {
      if (!acceptsRef.current(normalizeSequencedChatRunEvent(rawEvent))) return;
      if (isSequencedChatRunEvent(rawEvent)) {
        if (!shouldApplySequencedRunEvent(seenSequenceByRunIdRef.current, rawEvent)) {
          return;
        }
      }
      const event = normalizeSequencedChatRunEvent(rawEvent);
      pendingEventsRef.current = appendCoalescedChatRunEvent(pendingEventsRef.current, event);

      if (event.type === 'run_started' || event.type === 'run_continued' || event.type === 'run_resumed') {
        setErrorMessage(null);
      } else if (event.type === 'run_failed') {
        setErrorMessage(event.message);
      }

      if (isTerminalChatRunEvent(event) || pendingEventsRef.current.length >= maxPendingChatRunEvents) {
        if (rafHandleRef.current !== null) {
          cancelAnimationFrame(rafHandleRef.current);
          rafHandleRef.current = null;
        }
        flush();
        return;
      }

      scheduleFlush();
    });

    return () => {
      unsubscribeHidden();
      unsubscribe();
      clearPendingChatRunEvents(pendingEventsRef, rafHandleRef);
    };
  }, [client]);

  const reset = useCallback((): void => {
    acceptedRunIds.current.clear();
    clearPendingChatRunEvents(pendingEventsRef, rafHandleRef);
    seenSequenceByRunIdRef.current.clear();
    setState(createEmptyChatRunState());
    setErrorMessage(null);
  }, []);

  const setError = useCallback((message: string | null): void => {
    setErrorMessage(message);
  }, []);

  const applyReplay = useCallback((events: readonly SequencedChatRunEvent[]): void => {
    // Live events may already be deduplicated but still wait for an animation frame.
    // Apply them before the replay tail so a buffered run_started cannot erase that tail.
    const accepted = coalesceChatRunEvents(pendingEventsRef.current);
    clearPendingChatRunEvents(pendingEventsRef, rafHandleRef);
    for (const event of events) {
      if (!acceptsRef.current(event.event)) continue;
      if (shouldApplySequencedRunEvent(seenSequenceByRunIdRef.current, event)) {
        accepted.push(normalizeSequencedChatRunEvent(event));
      }
    }
    if (accepted.length === 0) {
      return;
    }
    const latestErrorTransition = [...accepted].reverse().find((event) =>
      event.type === 'run_failed' || event.type === 'run_started' || event.type === 'run_continued' || event.type === 'run_resumed'
    );
    if (latestErrorTransition?.type === 'run_failed') {
      setErrorMessage(latestErrorTransition.message);
    } else if (latestErrorTransition !== undefined) {
      setErrorMessage(null);
    }
    startTransition(() => {
      setState((current) => applyChatRunEventBatch(current, accepted));
    });
  }, []);

  return {
    state,
    reset,
    setError,
    errorMessage,
    applyReplay
  };
}
