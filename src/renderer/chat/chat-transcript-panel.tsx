import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { ChatTranscriptMessage } from '../chat-transcript';
import { ChatMessageRow } from './chat-message-row';
import { scrollBottomFade, scrollBottomTransition } from '../animations';
import type { ChatResumeDecision } from '../../shared/types';

type ChatTranscriptPanelProps = {
  messages: ChatTranscriptMessage[];
  liveSignal: string;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  onApprovalDecision?: (approvalId: string, decision: ChatResumeDecision) => void;
};

const BOTTOM_THRESHOLD_PX = 96;

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
        node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
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
    node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
  }

  return (
    <>
      <div className="chat-transcript" data-testid="chat-transcript">
        {messages.map((message) => (
          <ChatMessageRow key={message.key} message={message} onApprovalDecision={onApprovalDecision} />
        ))}
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
            transition={scrollBottomTransition}
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
