import { memo } from 'react';
import type { ChatTranscriptMessage } from '../chat-transcript';
import { MarkdownView } from './markdown-view';

type ChatMessageRowProps = {
  message: ChatTranscriptMessage;
};

function ChatMessageRowImpl({ message }: ChatMessageRowProps): React.JSX.Element {
  return (
    <div
      className={message.role === 'user' ? 'chat-message-row chat-message-row--user' : 'chat-message-row chat-message-row--assistant'}
      data-role={message.role}
      data-testid={message.role === 'user' ? 'chat-message-user' : 'chat-message-assistant'}
    >
      <article className={message.role === 'user' ? 'chat-bubble chat-bubble--user' : 'chat-bubble chat-bubble--assistant'}>
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
      </article>
    </div>
  );
}

export const ChatMessageRow = memo(
  ChatMessageRowImpl,
  (prev, next) =>
    prev.message.key === next.message.key &&
    prev.message.role === next.message.role &&
    prev.message.content === next.message.content &&
    prev.message.reasoning === next.message.reasoning
);
