import { useEffect, useRef, useState, type RefObject } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronDown } from 'lucide-react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import type { ChatResumeDecision } from '../../shared/types';
import { popoverTransition, popoverVariants } from '../shared/motion';
import type { ChatTranscriptMessage } from './transcript';
import { ChatMessageRow } from './blocks/message-row';

/**
 * Transcript panel (T4.3), ported from `chat/chat-transcript-panel.tsx`.
 *
 * `react-virtuoso` is kept because gate 6 requires 500 messages to stay smooth, and
 * the two subtle pieces of that are kept verbatim:
 *
 *   1. **`firstItemIndex` bookkeeping** (`useTranscriptFirstItemIndex` + the two key-diff
 *      helpers). Virtuoso needs a *stable* index space, but this transcript both prepends
 *      history and trims its tail. Adding the two revisions is what keeps scroll position
 *      from jumping when either happens — the arithmetic is the whole feature.
 *   2. **Initial window** (`buildTranscriptVirtuosoWindow`): a reopened thread starts at
 *      the last item instead of animating from the top.
 *
 * Changed back: the 「滚动到最新」 button is again `motion`'s `AnimatePresence` + a fade with a
 * 4px rise. P1 replaced it with a conditional element plus a CSS transition because motion's
 * layout projection cost ~385 KB of eager JS against a 900 KB self-imposed ceiling; the real
 * budget in `check-renderer-chunks.mjs` is 1.7 MB and the app builds at 918 KB, so that trade
 * was for a constraint that no longer binds. It was also a behavioural compromise: fading out
 * with CSS means keeping the button mounted, which leaves an invisible 28px hit target over
 * the transcript. `AnimatePresence` removes it from the DOM once the exit finishes.
 */

export type ChatTranscriptPanelProps = {
  threadId: string | null;
  messages: ChatTranscriptMessage[];
  prependRevision: number;
  trimRevision: number;
  windowEpoch: number;
  tailTrimmed: boolean;
  hasMoreBefore: boolean;
  loadingOlder: boolean;
  loadOlder(): Promise<void>;
  onJumpToLatest(): Promise<void>;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  onApprovalDecision?: (approvalId: string, decisions: ChatResumeDecision[]) => void;
  onResumeCheckpoint?: (runId: string) => Promise<boolean>;
};

export function buildStreamingAutoFollowScrollOptions(scrollHeight: number): ScrollToOptions {
  return { top: scrollHeight };
}

export type TranscriptVirtuosoWindow = {
  firstItemIndex: number;
  initialTopMostItemIndex?: number;
};

export function buildTranscriptVirtuosoWindow(input: {
  firstItemIndex: number;
  messageCount: number;
}): TranscriptVirtuosoWindow {
  if (input.messageCount === 0) {
    return { firstItemIndex: input.firstItemIndex };
  }
  return {
    firstItemIndex: input.firstItemIndex,
    initialTopMostItemIndex: input.firstItemIndex + input.messageCount - 1
  };
}

export function ChatTranscriptPanel({
  threadId,
  messages,
  prependRevision,
  trimRevision,
  windowEpoch,
  tailTrimmed,
  hasMoreBefore,
  loadingOlder,
  loadOlder,
  onJumpToLatest,
  scrollContainerRef,
  onApprovalDecision,
  onResumeCheckpoint
}: ChatTranscriptPanelProps): React.JSX.Element {
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [scrollParent, setScrollParent] = useState<HTMLDivElement | null>(null);
  const virtualIndex = useTranscriptFirstItemIndex({
    threadId,
    messageCount: messages.length,
    messageKeys: messages.map((message) => message.key),
    prependRevision,
    trimRevision,
    windowEpoch
  });
  const previousThreadIdRef = useRef<string | null>(threadId);
  const previousEpochRef = useRef(windowEpoch);
  const initialWindowRef = useRef<TranscriptVirtuosoWindow>(
    buildTranscriptVirtuosoWindow({ firstItemIndex: virtualIndex, messageCount: messages.length })
  );

  useEffect(() => {
    setScrollParent(scrollContainerRef.current);
  }, [scrollContainerRef]);

  // A new thread (or a re-windowed history) recomputes where to start.
  if (previousThreadIdRef.current !== threadId || previousEpochRef.current !== windowEpoch) {
    previousThreadIdRef.current = threadId;
    previousEpochRef.current = windowEpoch;
    initialWindowRef.current = buildTranscriptVirtuosoWindow({
      firstItemIndex: virtualIndex,
      messageCount: messages.length
    });
  }

  function handleScrollBottomClick(): void {
    if (tailTrimmed) {
      void onJumpToLatest();
      return;
    }
    virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'auto' });
  }

  return (
    <div className="relative min-h-0 flex-1" data-testid="assistant-transcript-host">
      <Virtuoso
        key={`${threadId === null ? 'none' : threadId}:${windowEpoch}:${messages.length === 0 ? 'empty' : 'loaded'}`}
        ref={virtuosoRef}
        className="h-full"
        data-testid="assistant-transcript"
        data-message-count={messages.length}
        style={{ height: '100%' }}
        customScrollParent={scrollParent === null ? undefined : scrollParent}
        alignToBottom
        data={messages}
        firstItemIndex={virtualIndex}
        initialTopMostItemIndex={initialWindowRef.current.initialTopMostItemIndex}
        computeItemKey={(_index, message) => message.key}
        increaseViewportBy={240}
        followOutput={isAtBottom ? 'auto' : false}
        atBottomStateChange={setIsAtBottom}
        itemContent={(_index, message) => <ChatMessageRow message={message} onApprovalDecision={onApprovalDecision}
          onResumeCheckpoint={onResumeCheckpoint} />}
        startReached={() => {
          if (hasMoreBefore && !loadingOlder) {
            void loadOlder();
          }
        }}
      />
      <AnimatePresence>
        {isAtBottom ? null : (
          <motion.button
            type="button"
            aria-label="滚动到最新"
            data-testid="assistant-scroll-bottom"
            onClick={handleScrollBottomClick}
            variants={popoverVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={popoverTransition}
            className="absolute bottom-2 left-1/2 flex h-7 w-7 -translate-x-1/2 items-center justify-center rounded-full border border-line bg-surface text-muted shadow-[var(--shadow-popover)] hover:text-ink active:bg-[var(--overlay-active)]"
          >
            <ChevronDown size={14} aria-hidden="true" />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}

export function countLeadingKeysAdded(previous: readonly string[], next: readonly string[]): number {
  const firstPrevious = previous[0];
  if (firstPrevious === undefined) {
    return 0;
  }
  const index = next.indexOf(firstPrevious);
  return index === -1 ? 0 : index;
}

export function countLeadingKeysRemoved(previous: readonly string[], next: readonly string[]): number {
  if (previous.length === 0) {
    return 0;
  }
  const nextKeys = new Set(next);
  let removed = 0;
  for (const key of previous) {
    if (nextKeys.has(key)) {
      break;
    }
    removed += 1;
  }
  return removed;
}

/**
 * Keeps Virtuoso's index space stable across prepends and tail trims.
 *
 * Both directions matter: prepending older history shifts everything up (subtract the
 * keys that appeared at the front), trimming the tail removes keys from the end without
 * changing the front (add the keys that disappeared). Getting either wrong makes the
 * viewport jump when the user is reading.
 */
export function useTranscriptFirstItemIndex(input: {
  threadId: string | null;
  messageCount: number;
  messageKeys: readonly string[];
  prependRevision: number;
  trimRevision: number;
  windowEpoch: number;
}): number {
  const state = useRef({
    threadId: input.threadId,
    index: 1_000_000,
    messageCount: input.messageCount,
    messageKeys: input.messageKeys,
    prependRevision: input.prependRevision,
    trimRevision: input.trimRevision,
    windowEpoch: input.windowEpoch
  });
  if (state.current.threadId !== input.threadId || state.current.windowEpoch !== input.windowEpoch) {
    state.current = {
      threadId: input.threadId,
      index: 1_000_000,
      messageCount: input.messageCount,
      messageKeys: input.messageKeys,
      prependRevision: input.prependRevision,
      trimRevision: input.trimRevision,
      windowEpoch: input.windowEpoch
    };
  } else {
    if (state.current.trimRevision !== input.trimRevision) {
      state.current.index += countLeadingKeysRemoved(state.current.messageKeys, input.messageKeys);
      state.current.trimRevision = input.trimRevision;
    }
    if (state.current.prependRevision !== input.prependRevision) {
      state.current.index -= countLeadingKeysAdded(state.current.messageKeys, input.messageKeys);
      state.current.prependRevision = input.prependRevision;
    }
    state.current.messageCount = input.messageCount;
    state.current.messageKeys = input.messageKeys;
  }
  return state.current.index;
}
