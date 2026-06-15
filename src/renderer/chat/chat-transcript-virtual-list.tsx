import { Virtuoso } from 'react-virtuoso';
import type { ChatTranscriptMessage } from '../chat-transcript';
import { ChatMessageRow } from './chat-message-row';

type ChatTranscriptVirtualListProps = {
  messages: ChatTranscriptMessage[];
  onApprovalDecision?: (approvalId: string, decisions: import('../../shared/types').ChatResumeDecision[]) => void;
};

export function ChatTranscriptVirtualList({ messages, onApprovalDecision }: ChatTranscriptVirtualListProps): React.JSX.Element {
  return (
    <div data-testid="chat-transcript-virtual-list">
      <Virtuoso
        style={{ height: '100%' }}
        totalCount={messages.length}
        itemContent={(index) => (
          <div data-testid="chat-transcript-virtual-item">
            <ChatMessageRow key={messages[index]?.key} message={messages[index]} onApprovalDecision={onApprovalDecision} />
          </div>
        )}
      />
    </div>
  );
}
