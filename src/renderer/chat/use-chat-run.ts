import { startTransition, useEffect, useRef, useState } from 'react';
import {
  applyChatRunEvent,
  createEmptyChatRunState,
  type ChatRunState
} from '../chat-run-state';
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

function isSequencedChatRunEvent(event: ChatRunEvent | SequencedChatRunEvent): event is SequencedChatRunEvent {
  if (typeof event !== 'object' || event === null) {
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
};

export function useChatRun(client: RocClient): ChatRunController {
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
      if (isSequencedChatRunEvent(rawEvent)) {
        if (!shouldApplySequencedRunEvent(seenSequenceByRunIdRef.current, rawEvent)) {
          return;
        }
      }
      const event = normalizeSequencedChatRunEvent(rawEvent);
      pendingEventsRef.current = appendCoalescedChatRunEvent(pendingEventsRef.current, event);

      if (event.type === 'run_started') {
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

  const reset = (): void => {
    clearPendingChatRunEvents(pendingEventsRef, rafHandleRef);
    seenSequenceByRunIdRef.current.clear();
    setState(createEmptyChatRunState());
    setErrorMessage(null);
  };

  const setError = (message: string | null): void => {
    setErrorMessage(message);
  };

  return {
    state,
    reset,
    setError,
    errorMessage
  };
}
