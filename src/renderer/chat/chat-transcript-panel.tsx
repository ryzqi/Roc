import { useEffect, useRef, type RefObject } from 'react';
import type { ChatTranscriptMessage } from '../chat-transcript';
import { ChatMessageRow } from './chat-message-row';

type ChatTranscriptPanelProps = {
  messages: ChatTranscriptMessage[];
  liveSignal: string;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
};

export function ChatTranscriptPanel({ messages, liveSignal, scrollContainerRef }: ChatTranscriptPanelProps): React.JSX.Element {
  const rafHandleRef = useRef<number | null>(null);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (container === null) {
      return;
    }
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom > 96) {
      // 用户主动向上翻阅时不要打断
      return;
    }
    if (rafHandleRef.current !== null) {
      return;
    }
    rafHandleRef.current = requestAnimationFrame(() => {
      rafHandleRef.current = null;
      const node = scrollContainerRef.current;
      if (node !== null) {
        node.scrollTop = node.scrollHeight;
      }
    });
  }, [liveSignal, messages, scrollContainerRef]);

  useEffect(() => {
    return () => {
      if (rafHandleRef.current !== null) {
        cancelAnimationFrame(rafHandleRef.current);
        rafHandleRef.current = null;
      }
    };
  }, []);

  return (
    <div className="chat-transcript" data-testid="chat-transcript">
      {messages.map((message) => (
        <ChatMessageRow key={message.key} message={message} />
      ))}
    </div>
  );
}
