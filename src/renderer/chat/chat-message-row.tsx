import { memo } from 'react';
import { motion } from 'motion/react';
import { bubbleEnter, bubbleEnterTransition } from '../animations';
import type { ChatTranscriptMessage } from '../chat-transcript';
import { MarkdownView } from './markdown-view';
import type { ChatResumeDecision } from '../../shared/types';

type ChatMessageRowProps = {
  message: ChatTranscriptMessage;
  onApprovalDecision?: (approvalId: string, decision: ChatResumeDecision) => void;
};

function ChatMessageRowImpl({ message, onApprovalDecision }: ChatMessageRowProps): React.JSX.Element {
  const approval = message.approval;
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
            <MarkdownView text={message.reasoning} />
          </div>
        )}
        {approval === null ? null : (
          <div className="chat-bubble-approval" data-testid="chat-approval-card">
            <strong>等待审批</strong>
            {approval.actionRequests.map((request, index) => {
              const reviewConfig = approval.reviewConfigs.find((config) => config.actionName === request.name);
              return (
                <div key={`${request.name}-${index}`} className="chat-bubble-approval-item">
                  <div data-testid="chat-approval-tool-name">{request.name}</div>
                  <pre data-testid="chat-approval-tool-args">{JSON.stringify(request.args, null, 2)}</pre>
                  <div data-testid="chat-approval-decisions">
                    {(reviewConfig?.allowedDecisions ?? []).join(' / ')}
                  </div>
                </div>
              );
            })}
            <div className="action-strip">
              <button
                type="button"
                onClick={() => onApprovalDecision?.(approval.interruptId, { type: 'approve' })}
              >
                approve
              </button>
              <button
                type="button"
                onClick={() => onApprovalDecision?.(approval.interruptId, { type: 'reject' })}
              >
                reject
              </button>
              {approval.reviewConfigs.some((config) => config.allowedDecisions.includes('edit')) ? (
                <button
                  type="button"
                  onClick={() =>
                    onApprovalDecision?.(approval.interruptId, {
                      type: 'edit',
                      editedAction: approval.actionRequests[0] ?? {
                        name: 'unknown',
                        args: {}
                      }
                    })
                  }
                >
                  edit
                </button>
              ) : null}
            </div>
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
    prev.message.approval === next.message.approval &&
    prev.message.isStreaming === next.message.isStreaming
);
