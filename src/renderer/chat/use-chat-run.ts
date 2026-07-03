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
  return event.type === 'run_started' || event.type === 'run_completed' || event.type === 'run_failed';
}

export function normalizeSequencedChatRunEvent(event: ChatRunEvent | SequencedChatRunEvent): ChatRunEvent {
  if (isSequencedChatRunEvent(event)) {
    return event.event;
  }
  return event;
}

export function shouldApplySequencedRunEvent(seen: Map<string, number>, event: SequencedChatRunEvent): boolean {
  const previous = seen.get(event.runId);
  if (previous !== undefined && event.sequence <= previous) {
    return false;
  }
  seen.set(event.runId, event.sequence);
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

    const unsubscribe = client.api.chat.onRunEvent((rawEvent) => {
      if (isSequencedChatRunEvent(rawEvent)) {
        if (!shouldApplySequencedRunEvent(seenSequenceByRunIdRef.current, rawEvent)) {
          return;
        }
      }
      const event = normalizeSequencedChatRunEvent(rawEvent);
      pendingEventsRef.current.push(event);

      if (event.type === 'run_started') {
        setErrorMessage(null);
      } else if (event.type === 'run_failed') {
        setErrorMessage(event.message);
      }

      if (isTerminalChatRunEvent(event)) {
        if (rafHandleRef.current !== null) {
          cancelAnimationFrame(rafHandleRef.current);
          rafHandleRef.current = null;
        }
        flush();
        return;
      }

      if (rafHandleRef.current === null) {
        rafHandleRef.current = requestAnimationFrame(flush);
      }
    });

    return () => {
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
