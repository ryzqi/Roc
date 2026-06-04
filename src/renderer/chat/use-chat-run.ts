import { useEffect, useRef, useState } from 'react';
import {
  applyChatRunEvent,
  createEmptyChatRunState,
  type ChatRunState
} from '../chat-run-state';
import type { ChatRunEvent } from '../../shared/types';
import type { RocClient } from '../shared/roc-client';

export function applyChatRunEventBatch(state: ChatRunState, events: ChatRunEvent[]): ChatRunState {
  if (events.length === 0) {
    return state;
  }
  return events.reduce(applyChatRunEvent, state);
}

export function isTerminalChatRunEvent(event: ChatRunEvent): boolean {
  return event.type === 'run_started' || event.type === 'run_completed' || event.type === 'run_failed';
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

  useEffect(() => {
    function flush(): void {
      rafHandleRef.current = null;
      const buffered = pendingEventsRef.current;
      if (buffered.length === 0) {
        return;
      }
      pendingEventsRef.current = [];
      setState((current) => applyChatRunEventBatch(current, buffered));
    }

    const unsubscribe = client.api.chat.onRunEvent((event) => {
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
