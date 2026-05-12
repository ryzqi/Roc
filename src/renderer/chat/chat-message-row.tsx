import { memo } from 'react';
import { motion } from 'motion/react';
import { bubbleEnter, bubbleEnterTransition } from '../animations';
import type { ChatTranscriptMessage } from '../chat-transcript';
import { MarkdownView } from './markdown-view';

type ChatMessageRowProps = {
  message: ChatTranscriptMessage;
};

function ChatMessageRowImpl({ message }: ChatMessageRowProps): React.JSX.Element {
  const bubbleClassName = [
    message.role === 'user' ? 'chat-bubble chat-bubble--user' : 'chat-bubble chat-bubble--assistant',
    message.isStreaming ? 'is-streaming' : ''
  ]
    .filter((part) => part.length > 0)
    .join(' ');
  return (
    <motion.div
      animate="animate"
      className={message.role === 'user' ? 'chat-message-row chat-message-row--user' : 'chat-message-row chat-message-row--assistant'}
      data-role={message.role}
      data-testid={message.role === 'user' ? 'chat-message-user' : 'chat-message-assistant'}
      initial="initial"
      transition={bubbleEnterTransition}
      variants={bubbleEnter}
    >
      <article className={bubbleClassName}>
        {message.content.length === 0
          ? null
          : message.role === 'assistant'
            ? <MarkdownView text={message.content} />
            : <p>{message.content}</p>}
        {message.reasoning === null ? null : (
          <div className="chat-bubble-reasoning" data-testid="chat-message-reasoning">
            <strong>思考</strong>
            <p>{message.reasoning}</p>
          </div>
        )}
        {message.isStreaming && message.role === 'assistant' ? (
          <span className="chat-typing-cursor" aria-hidden="true" />
        ) : null}
      </article>
    </motion.div>
  );
}

export const ChatMessageRow = memo(
  ChatMessageRowImpl,
  (prev, next) =>
    prev.message.key === next.message.key &&
    prev.message.role === next.message.role &&
    prev.message.content === next.message.content &&
    prev.message.reasoning === next.message.reasoning &&
    prev.message.isStreaming === next.message.isStreaming
);
