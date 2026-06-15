import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { ChatTranscriptMessage } from '../chat-transcript';
import { resolveMotionTransition, scrollBottomFade, scrollBottomTransition } from '../animations';
import type { ChatResumeDecision } from '../../shared/types';
import { ChatTranscriptVirtualList } from './chat-transcript-virtual-list';

type ChatTranscriptPanelProps = {
  messages: ChatTranscriptMessage[];
  liveSignal: string;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  onApprovalDecision?: (approvalId: string, decisions: ChatResumeDecision[]) => void;
};

const BOTTOM_THRESHOLD_PX = 96;

export function buildStreamingAutoFollowScrollOptions(scrollHeight: number): ScrollToOptions {
  return { top: scrollHeight };
}

export function buildManualScrollBottomOptions(scrollHeight: number, reducedMotion: boolean): ScrollToOptions {
  if (reducedMotion) {
    return { top: scrollHeight };
  }
  return { top: scrollHeight, behavior: 'smooth' };
}

function prefersReducedMotion(): boolean {
  if (typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function ChatTranscriptPanel({
  messages,
  liveSignal,
  scrollContainerRef,
  onApprovalDecision
}: ChatTranscriptPanelProps): React.JSX.Element {
  const rafHandleRef = useRef<number | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const measureAtBottom = useCallback((): boolean => {
    const container = scrollContainerRef.current;
    if (container === null) {
      return true;
    }
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    return distanceFromBottom <= BOTTOM_THRESHOLD_PX;
  }, [scrollContainerRef]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (container === null) {
      return;
    }
    let frameHandle: number | null = null;
    function onScroll(): void {
      if (frameHandle !== null) {
        return;
      }
      frameHandle = requestAnimationFrame(() => {
        frameHandle = null;
        setIsAtBottom(measureAtBottom());
      });
    }
    container.addEventListener('scroll', onScroll, { passive: true });
    setIsAtBottom(measureAtBottom());
    return () => {
      container.removeEventListener('scroll', onScroll);
      if (frameHandle !== null) {
        cancelAnimationFrame(frameHandle);
      }
    };
  }, [measureAtBottom, scrollContainerRef]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (container === null) {
      return;
    }
    if (!measureAtBottom()) {
      return;
    }
    if (rafHandleRef.current !== null) {
      return;
    }
    rafHandleRef.current = requestAnimationFrame(() => {
      rafHandleRef.current = null;
      const node = scrollContainerRef.current;
      if (node !== null) {
        node.scrollTo(buildStreamingAutoFollowScrollOptions(node.scrollHeight));
      }
    });
  }, [liveSignal, measureAtBottom, messages, scrollContainerRef]);

  useEffect(() => {
    return () => {
      if (rafHandleRef.current !== null) {
        cancelAnimationFrame(rafHandleRef.current);
        rafHandleRef.current = null;
      }
    };
  }, []);

  function handleScrollBottomClick(): void {
    const node = scrollContainerRef.current;
    if (node === null) {
      return;
    }
    node.scrollTo(buildManualScrollBottomOptions(node.scrollHeight, prefersReducedMotion()));
  }

  return (
    <>
      <div className="chat-transcript" data-testid="chat-transcript">
        <ChatTranscriptVirtualList messages={messages} onApprovalDecision={onApprovalDecision} />
      </div>
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
            variants={scrollBottomFade}
            transition={resolveMotionTransition(scrollBottomTransition)}
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
