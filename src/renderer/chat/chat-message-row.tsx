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
import type { ChatTranscriptActivityBlock, ChatTranscriptMessage } from '../chat-transcript';
import type { ChatResumeDecision } from '../../shared/types';
import { CopyAnswerButton } from './CopyAnswerButton';
import { isTaskApproval, TaskApprovalCard } from '../views/tasks/TaskApprovalCard';
import { HookCallBlock } from './hook-call/HookCallBlock';
import { ReasoningBlock } from './reasoning/ReasoningBlock';
import { ToolCallView } from './tool-call-view';
import { StreamingMarkdownView } from './streaming-markdown-view';
import { SubagentActivityCard } from './subagent/SubagentActivityCard';

type ChatMessageRowProps = {
  message: ChatTranscriptMessage;
  onApprovalDecision?: (approvalId: string, decisions: ChatResumeDecision[]) => void;
};

function ChatMessageRowImpl({ message, onApprovalDecision }: ChatMessageRowProps): React.JSX.Element {
  const approval = message.approval;
  const isAssistant = message.role === 'assistant';
  const blocks = message.blocks ?? [];
  const attachments = message.attachments === undefined ? [] : message.attachments;
  const activityBlocks =
    blocks.length > 0
      ? blocks
      : message.reasoning === null
        ? []
        : [
            {
              id: `${message.key}-reasoning`,
              kind: 'reasoning',
              content: message.reasoning,
              isStreaming: message.isStreaming
            } satisfies ChatTranscriptActivityBlock
          ];
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
            {activityBlocks.map((block) => (
              <ChatActivityBlockView key={block.id} block={block} />
            ))}
            {message.content.length === 0 ? null : (
              <StreamingMarkdownView text={message.content} isStreaming={message.isStreaming} />
            )}
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
            {!message.isStreaming && message.content.length > 0 ? <CopyAnswerButton content={message.content} /> : null}
          </div>
        ) : (
          <>
            <p>{message.content}</p>
            {attachments.length === 0 ? null : (
              <div className="chat-message-attachments" data-testid="chat-message-attachments">
                {attachments.map((attachment) => (
                  <span className="chat-message-attachment" key={`${attachment.name}-${attachment.sizeBytes}`}>
                    <span>{attachment.name}</span>
                    <small>{Math.ceil(attachment.sizeBytes / 1024)} KB</small>
                  </span>
                ))}
              </div>
            )}
          </>
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
    prev.message.attachments === next.message.attachments &&
    prev.message.reasoning === next.message.reasoning &&
    prev.message.blocks === next.message.blocks &&
    prev.message.approval === next.message.approval &&
    prev.message.isStreaming === next.message.isStreaming
);

function ChatActivityBlockView({ block }: { block: ChatTranscriptActivityBlock }): React.JSX.Element {
  if (block.kind === 'reasoning') {
    return <ReasoningBlock id={block.id} content={block.content} isStreaming={block.isStreaming} />;
  }

  if (block.kind === 'tool_call') {
    return <ToolCallView block={block} />;
  }

  if (block.kind === 'hook_call') {
    return <HookCallBlock block={block} />;
  }

  if (block.kind === 'subagent') {
    return <SubagentActivityCard block={block} />;
  }

  return (
    <details className="chat-bubble-activity chat-bubble-guardrail" data-testid="chat-activity-guardrail">
      <summary>{`Guardrail · ${block.nudgeKind}`}</summary>
      <div className="activity-body">
        <StreamingMarkdownView text={block.content} isStreaming={false} />
      </div>
    </details>
  );
}
