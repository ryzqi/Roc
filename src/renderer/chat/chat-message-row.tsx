import { memo } from 'react';
import { motion } from 'motion/react';
import {
  approvalCardEnter,
  approvalCardTransition,
  assistantBubbleEnter,
  bubbleEnterTransition,
  resolveMotionTransition,
  userBubbleEnter
} from '../animations';
import type { ChatTranscriptMessage } from '../chat-transcript';
import { MarkdownView } from './markdown-view';
import type { ChatResumeDecision } from '../../shared/types';
import { isTaskApproval, TaskApprovalCard } from '../views/tasks/TaskApprovalCard';

type ChatMessageRowProps = {
  message: ChatTranscriptMessage;
  onApprovalDecision?: (approvalId: string, decisions: ChatResumeDecision[]) => void;
};

function ChatMessageRowImpl({ message, onApprovalDecision }: ChatMessageRowProps): React.JSX.Element {
  const approval = message.approval;
  const isAssistant = message.role === 'assistant';
  const reasoningStepCount =
    message.reasoning === null
      ? 0
      : message.reasoning
          .split(/\n+/)
          .map((part) => part.trim())
          .filter((part) => part.length > 0).length;
  const reasoningLabel = reasoningStepCount > 0 ? `推理 · ${reasoningStepCount} 步` : '推理';
  const bubbleClassName = [
    isAssistant ? 'chat-bubble chat-bubble--assistant' : 'chat-bubble chat-bubble--user',
    message.isStreaming ? 'is-streaming' : ''
  ]
    .filter((part) => part.length > 0)
    .join(' ');
  const variants = isAssistant ? assistantBubbleEnter : userBubbleEnter;
  return (
    <motion.div
      animate="animate"
      className={isAssistant ? 'chat-message-row chat-message-row--assistant' : 'chat-message-row chat-message-row--user'}
      data-role={message.role}
      data-testid={isAssistant ? 'chat-message-assistant' : 'chat-message-user'}
      initial="initial"
      transition={resolveMotionTransition(bubbleEnterTransition)}
      variants={variants}
    >
      <article className={bubbleClassName}>
        {isAssistant ? (
          <div className="chat-assistant-content" data-testid="chat-assistant-content">
            {message.reasoning === null ? null : (
              <details
                className="chat-bubble-reasoning"
                data-testid="chat-message-reasoning"
                open={message.isStreaming ? true : undefined}
              >
                <summary>
                  <span className={message.isStreaming ? 'reasoning-shimmer' : undefined}>{reasoningLabel}</span>
                </summary>
                <div className="reasoning-body">
                  <MarkdownView text={message.reasoning} />
                </div>
              </details>
            )}
            {message.content.length === 0 ? null : <MarkdownView text={message.content} />}
            {approval !== null && isTaskApproval(approval) ? (
              <TaskApprovalCard approval={approval} onApprovalDecision={onApprovalDecision} />
            ) : approval === null ? null : (
              <motion.div
                className="chat-approval-card"
                data-testid="chat-approval-card"
                initial="initial"
                animate="animate"
                variants={approvalCardEnter}
                transition={resolveMotionTransition(approvalCardTransition)}
              >
                <header className="chat-approval-head">
                  等待审批
                  <span className="chat-approval-count">{approval.actionRequests.length}</span>
                </header>
                <ul className="chat-approval-actions">
                  {approval.actionRequests.map((request, index) => {
                    const reviewConfig = approval.reviewConfigs.find((config) => config.actionName === request.name);
                    return (
                      <li key={`${request.name}-${index}`} className="chat-approval-item">
                        <span className="chat-approval-tool" data-testid="chat-approval-tool-name">{request.name}</span>
                        <pre className="chat-approval-args" data-testid="chat-approval-tool-args">{JSON.stringify(request.args, null, 2)}</pre>
                        <span className="chat-approval-decisions" data-testid="chat-approval-decisions">
                          {(reviewConfig?.allowedDecisions ?? []).join(' / ')}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <div className="chat-approval-buttons">
                  <button
                    type="button"
                    className="approval-btn approval-btn--approve"
                    onClick={() =>
                      onApprovalDecision?.(
                        approval.interruptId,
                        approval.actionRequests.map(() => ({ type: 'approve' }))
                      )
                    }
                  >
                    approve
                  </button>
                  <button
                    type="button"
                    className="approval-btn approval-btn--reject"
                    onClick={() =>
                      onApprovalDecision?.(
                        approval.interruptId,
                        approval.actionRequests.map(() => ({ type: 'reject' }))
                      )
                    }
                  >
                    reject
                  </button>
                  {approval.actionRequests.length === 1 && approval.reviewConfigs.some((config) => config.allowedDecisions.includes('edit')) ? (
                    <button
                      type="button"
                      className="approval-btn approval-btn--edit"
                      onClick={() =>
                        onApprovalDecision?.(approval.interruptId, [
                          {
                            type: 'edit',
                            editedAction: approval.actionRequests[0] ?? {
                              name: 'unknown',
                              args: {}
                            }
                          }
                        ])
                      }
                    >
                      edit
                    </button>
                  ) : null}
                </div>
              </motion.div>
            )}
            {message.isStreaming ? (
              <span className="chat-typing-cursor" aria-hidden="true" />
            ) : null}
          </div>
        ) : (
          <p>{message.content}</p>
        )}
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
