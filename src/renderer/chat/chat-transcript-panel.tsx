import { useEffect, useRef, useState, type RefObject } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';

import type { ChatResumeDecision } from '../../shared/types';
import { resolveMotionTransition, resolveMotionVariants, scrollBottomFade } from '../animations';
import type { ChatTranscriptMessage } from '../chat-transcript';
import { ChatMessageRow } from './chat-message-row';

type ChatTranscriptPanelProps = {
  threadId: string | null;
  messages: ChatTranscriptMessage[];
  prependRevision: number;
  trimRevision: number;
  hasMoreBefore: boolean;
  loadingOlder: boolean;
  loadOlder(): Promise<void>;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  onApprovalDecision?: (approvalId: string, decisions: ChatResumeDecision[]) => void;
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
  hasMoreBefore,
  loadingOlder,
  loadOlder,
  scrollContainerRef,
  onApprovalDecision
}: ChatTranscriptPanelProps): React.JSX.Element {
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [scrollParent, setScrollParent] = useState<HTMLDivElement | null>(null);
  const virtualIndex = useTranscriptFirstItemIndex({
    threadId,
    messageCount: messages.length,
    messageKeys: messages.map((message) => message.key),
    prependRevision,
    trimRevision
  });
  const previousThreadIdRef = useRef<string | null>(threadId);
  const initialWindowRef = useRef<TranscriptVirtuosoWindow>(
    buildTranscriptVirtuosoWindow({
      firstItemIndex: virtualIndex,
      messageCount: messages.length
    })
  );

  useEffect(() => {
    setScrollParent(scrollContainerRef.current);
  }, [scrollContainerRef]);

  // threadId 变化时重新计算初始窗口
  if (previousThreadIdRef.current !== threadId) {
    previousThreadIdRef.current = threadId;
    initialWindowRef.current = buildTranscriptVirtuosoWindow({
      firstItemIndex: virtualIndex,
      messageCount: messages.length
    });
  }

  function handleScrollBottomClick(): void {
    virtuosoRef.current?.scrollToIndex({
      index: 'LAST',
      behavior: 'auto'
    });
  }

  return (
    <>
      <Virtuoso
        key={`${threadId === null ? 'none' : threadId}:${messages.length === 0 ? 'empty' : 'loaded'}`}
        ref={virtuosoRef}
        className="chat-transcript"
        data-testid="chat-transcript"
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
        itemContent={(_index, message) => (
          <div className="chat-transcript-item">
            <ChatMessageRow message={message} onApprovalDecision={onApprovalDecision} />
          </div>
        )}
        startReached={() => {
          if (hasMoreBefore && !loadingOlder) {
            void loadOlder();
          }
        }}
      />
      <AnimatePresence>
        {isAtBottom ? null : (
          <motion.button
            key="chat-scroll-bottom"
            type="button"
            className="chat-scroll-bottom"
            aria-label="滚动到最新"
            data-testid="chat-scroll-bottom"
            initial="initial"
            animate="animate"
            exit="exit"
            variants={resolveMotionVariants(scrollBottomFade)}
            transition={resolveMotionTransition()}
            onClick={handleScrollBottomClick}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </motion.button>
        )}
      </AnimatePresence>
    </>
  );
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

export function useTranscriptFirstItemIndex(input: {
  threadId: string | null;
  messageCount: number;
  messageKeys: readonly string[];
  prependRevision: number;
  trimRevision: number;
}): number {
  const state = useRef({
    threadId: input.threadId,
    index: 1_000_000,
    messageCount: input.messageCount,
    messageKeys: input.messageKeys,
    prependRevision: input.prependRevision,
    trimRevision: input.trimRevision
  });
  if (state.current.threadId !== input.threadId) {
    state.current = {
      threadId: input.threadId,
      index: 1_000_000,
      messageCount: input.messageCount,
      messageKeys: input.messageKeys,
      prependRevision: input.prependRevision,
      trimRevision: input.trimRevision
    };
  } else {
    if (state.current.trimRevision !== input.trimRevision) {
      state.current.index += countLeadingKeysRemoved(state.current.messageKeys, input.messageKeys);
      state.current.trimRevision = input.trimRevision;
    }
    if (state.current.prependRevision !== input.prependRevision) {
      const prependedRows = Math.max(0, input.messageCount - state.current.messageCount);
      state.current.index -= prependedRows;
      state.current.prependRevision = input.prependRevision;
    }
    state.current.messageCount = input.messageCount;
    state.current.messageKeys = input.messageKeys;
  }
  return state.current.index;
}
