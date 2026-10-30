import { startTransition, useCallback, useEffect, useRef, useState } from 'react';
import {
  applyChatRunEvent,
  createEmptyChatRunState,
  type ChatRunState
} from './run-state';
import type { ChatRunEventsReplayPage, ChatRunEvent, SequencedChatRunEvent } from '../../shared/types';
import { getRunEventsReplay } from './session-store';
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

export function areReplayEventsContiguous(events: readonly SequencedChatRunEvent[], afterSequence: number): boolean {
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) return false;
  let expectedSequence = afterSequence + 1;
  for (const event of events) {
    if (event.sequence < expectedSequence) continue;
    if (event.sequence !== expectedSequence) return false;
    expectedSequence += 1;
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
const maxLiveReplayTailEvents = 10_000;
const maxLiveReplayTailBytes = 8 * 1024 * 1024;

type LiveReplayTail = {
  events: SequencedChatRunEvent[];
  bytes: number;
  droppedThroughSequence: number;
};

function rememberLiveReplayEvent(tails: Map<string, LiveReplayTail>, event: SequencedChatRunEvent): void {
  const eventBytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
  const tail = tails.get(event.runId) ?? { events: [], bytes: 0, droppedThroughSequence: 0 };
  tail.events.push(event);
  tail.bytes += eventBytes;
  while (tail.events.length > maxLiveReplayTailEvents || tail.bytes > maxLiveReplayTailBytes) {
    const dropped = tail.events.shift();
    if (dropped === undefined) break;
    tail.bytes -= new TextEncoder().encode(JSON.stringify(dropped)).byteLength;
    tail.droppedThroughSequence = Math.max(tail.droppedThroughSequence, dropped.sequence);
  }
  tails.delete(event.runId);
  tails.set(event.runId, tail);
  while (tails.size > maxSeenRunSequences) {
    const oldestRunId = tails.keys().next().value;
    if (oldestRunId === undefined || oldestRunId === event.runId) break;
    tails.delete(oldestRunId);
  }
}

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
  applyReplay: (page: ChatRunEventsReplayPage | readonly SequencedChatRunEvent[], afterSequence?: number) => void;
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
      const isAccepted = current.threadId === null
        ? current.acceptUnboundEvents || acceptedRunIds.current.has(event.runId)
        : event.threadId === current.threadId;
      if (isAccepted) {
        acceptedRunIds.current.add(event.runId);
      } else {
        return false;
      }
    }
    return acceptedRunIds.current.has(event.runId);
  };
  const acceptsRef = useRef(accepts);
  acceptsRef.current = accepts;
  const [state, setState] = useState<ChatRunState>(() => createEmptyChatRunState());
  const stateRef = useRef(state);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const pendingEventsRef = useRef<ChatRunEvent[]>([]);
  const rafHandleRef = useRef<number | null>(null);
  const hiddenRef = useRef(false);
  const seenSequenceByRunIdRef = useRef<Map<string, number>>(new Map());
  const liveReplayTailByRunIdRef = useRef<Map<string, LiveReplayTail>>(new Map());
  const replayingRunIdsRef = useRef(new Set<string>());
  const recoverableSequenceGapRunIdsRef = useRef(new Set<string>());
  const applyReplayRef = useRef<ChatRunController['applyReplay'] | null>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    function flush(): void {
      rafHandleRef.current = null;
      const buffered = coalesceChatRunEvents(pendingEventsRef.current);
      if (buffered.length === 0) {
        return;
      }
      pendingEventsRef.current = [];
      const next = applyChatRunEventBatch(stateRef.current, buffered);
      stateRef.current = next;
      startTransition(() => {
        setState(next);
      });
    }

    function scheduleFlush(): void {
      if (hiddenRef.current || rafHandleRef.current !== null) {
        return;
      }
      rafHandleRef.current = requestAnimationFrame(flush);
    }

    function recoverMissingEvents(runId: string, afterSequence: number): void {
      if (replayingRunIdsRef.current.has(runId)) return;
      replayingRunIdsRef.current.add(runId);
      const generation = generationRef.current;
      void getRunEventsReplay(client, { runId, afterSequence })
        .then((result) => {
          if (generation !== generationRef.current) return;
          if (!result.ok) {
            setErrorMessage(result.error.message);
            return;
          }
          applyReplayRef.current?.(result.data, afterSequence);
        })
        .catch((caught: unknown) => {
          if (generation === generationRef.current) {
            setErrorMessage(caught instanceof Error ? caught.message : String(caught));
          }
        })
        .finally(() => {
          if (generation === generationRef.current) replayingRunIdsRef.current.delete(runId);
        });
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
      const event = normalizeSequencedChatRunEvent(rawEvent);
      if (!acceptsRef.current(event)) return;
      if (isSequencedChatRunEvent(rawEvent)) {
        const previousSequence = seenSequenceByRunIdRef.current.get(rawEvent.runId);
        if (previousSequence !== undefined && rawEvent.sequence <= previousSequence) return;
        rememberLiveReplayEvent(liveReplayTailByRunIdRef.current, rawEvent);
        let replayAfterSequence: number | null = null;
        if (previousSequence === undefined && rawEvent.sequence > 1) {
          const current = stateRef.current;
          const base = current.runId === rawEvent.runId ? current : createEmptyChatRunState();
          stateRef.current = { ...base, runId: rawEvent.runId, historyComplete: false };
          startTransition(() => setState(stateRef.current));
          replayAfterSequence = 0;
        } else if (previousSequence !== undefined && rawEvent.sequence > previousSequence + 1) {
          const current = stateRef.current;
          if (current.runId === rawEvent.runId && current.historyComplete) {
            stateRef.current = { ...current, historyComplete: false };
            recoverableSequenceGapRunIdsRef.current.add(rawEvent.runId);
            startTransition(() => setState(stateRef.current));
          }
          replayAfterSequence = previousSequence;
        }
        if (replayAfterSequence !== null) {
          recoverMissingEvents(rawEvent.runId, replayAfterSequence);
          return;
        }
        if (!shouldApplySequencedRunEvent(seenSequenceByRunIdRef.current, rawEvent)) return;
      }
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
      generationRef.current += 1;
      replayingRunIdsRef.current.clear();
    };
  }, [client]);

  const reset = useCallback((): void => {
    generationRef.current += 1;
    replayingRunIdsRef.current.clear();
    recoverableSequenceGapRunIdsRef.current.clear();
    acceptedRunIds.current.clear();
    clearPendingChatRunEvents(pendingEventsRef, rafHandleRef);
    seenSequenceByRunIdRef.current.clear();
    liveReplayTailByRunIdRef.current.clear();
    stateRef.current = createEmptyChatRunState();
    setState(stateRef.current);
    setErrorMessage(null);
  }, []);

  const setError = useCallback((message: string | null): void => {
    setErrorMessage(message);
  }, []);

  const applyReplay = useCallback((
    replay: ChatRunEventsReplayPage | readonly SequencedChatRunEvent[],
    afterSequence?: number
  ): void => {
    const page = Array.isArray(replay) ? null : replay as ChatRunEventsReplayPage;
    const replayEvents = page === null ? replay as readonly SequencedChatRunEvent[] : page.events;
    const pending = coalesceChatRunEvents(pendingEventsRef.current);
    clearPendingChatRunEvents(pendingEventsRef, rafHandleRef);
    let baseState = stateRef.current;
    let rebased = false;
    let stateChanged = false;
    const accepted: ChatRunEvent[] = [];

    if (page) {
      const replayAfterSequence = afterSequence ?? 0;
      const isSnapshotGap = page.kind === 'replay_gap';
      const shouldRebase = page.kind === 'replay_gap' && (
        baseState.runId !== page.runId ||
        !baseState.historyComplete ||
        page.snapshot.throughSequence > (seenSequenceByRunIdRef.current.get(page.runId) ?? 0)
      );
      const tail = liveReplayTailByRunIdRef.current.get(page.runId);
      const serverThrough = page.events.at(-1)?.sequence ?? (isSnapshotGap ? page.snapshot.throughSequence : replayAfterSequence);
      if (tail !== undefined && tail.droppedThroughSequence > serverThrough && (shouldRebase || !baseState.historyComplete)) {
        const incomplete = { ...baseState, historyComplete: false };
        stateRef.current = incomplete;
        startTransition(() => setState(incomplete));
        setErrorMessage('Run history changed during recovery. Reopen the session to load the latest activity.');
        return;
      }

      let eventFloor = replayAfterSequence;
      if (shouldRebase && page.kind === 'replay_gap') {
        baseState = page.snapshot.state;
        eventFloor = page.snapshot.throughSequence;
        rebased = true;
        stateChanged = true;
        seenSequenceByRunIdRef.current.delete(page.runId);
        seenSequenceByRunIdRef.current.set(page.runId, page.snapshot.throughSequence);
        recoverableSequenceGapRunIdsRef.current.delete(page.runId);
        setErrorMessage(baseState.errorMessage);
      } else if (isSnapshotGap && page.kind === 'replay_gap') {
        eventFloor = page.snapshot.throughSequence;
      }

      const candidates = new Map<number, SequencedChatRunEvent>();
      for (const event of page.events) {
        if (event.sequence > eventFloor) candidates.set(event.sequence, event);
      }
      for (const event of tail?.events ?? []) {
        if (event.sequence > eventFloor) candidates.set(event.sequence, event);
      }
      const orderedEvents = [...candidates.values()].sort((left, right) => left.sequence - right.sequence);
      const replayIsContiguous = areReplayEventsContiguous(orderedEvents, replayAfterSequence);
      const canRestoreCompleteHistory = page.kind === 'events' && orderedEvents.length > 0 && replayIsContiguous &&
        ((replayAfterSequence === 0 && orderedEvents[0]?.sequence === 1) ||
          recoverableSequenceGapRunIdsRef.current.has(page.runId));
      if (canRestoreCompleteHistory) {
        baseState = { ...baseState, historyComplete: true };
        stateChanged = true;
        recoverableSequenceGapRunIdsRef.current.delete(page.runId);
      }
      if (!rebased) accepted.push(...pending);
      for (const event of orderedEvents) {
        if (!acceptsRef.current(event.event)) continue;
        if (shouldApplySequencedRunEvent(seenSequenceByRunIdRef.current, event)) accepted.push(event.event);
      }
    } else {
      accepted.push(...pending);
      for (const event of replayEvents) {
        if (!acceptsRef.current(event.event)) continue;
        if (shouldApplySequencedRunEvent(seenSequenceByRunIdRef.current, event)) accepted.push(event.event);
      }
    }

    if (accepted.length === 0 && !stateChanged) return;
    let latestErrorTransition: ChatRunEvent | undefined;
    for (let index = accepted.length - 1; index >= 0; index -= 1) {
      const event = accepted[index];
      if (event !== undefined && (event.type === 'run_failed' || event.type === 'run_started' || event.type === 'run_continued' || event.type === 'run_resumed')) {
        latestErrorTransition = event;
        break;
      }
    }
    if (latestErrorTransition?.type === 'run_failed') {
      setErrorMessage(latestErrorTransition.message);
    } else if (latestErrorTransition !== undefined) {
      setErrorMessage(null);
    }
    const next = applyChatRunEventBatch(baseState, accepted);
    stateRef.current = next;
    startTransition(() => setState(next));
  }, []);

  applyReplayRef.current = applyReplay;

  return {
    state,
    reset,
    setError,
    errorMessage,
    applyReplay
  };
}
