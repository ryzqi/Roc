import { lazy, memo, Suspense, useLayoutEffect, type AnimationEvent } from 'react';
import type { ChatTranscriptActivityBlock, ChatTranscriptMessage } from '../chat-transcript';
import type { ChatPendingInterrupt, ChatResumeDecision } from '../../shared/types';
import { CopyAnswerButton } from './CopyAnswerButton';
import { isTaskApproval, TaskApprovalCard } from '../views/tasks/TaskApprovalCard';
import { isResearchGateApproval, ResearchGateApprovalCard } from './ResearchGateCard';
import { HookCallBlock } from './hook-call/HookCallBlock';
import { QuestionInterruptCard } from './QuestionInterruptCard';
import { ReasoningBlock } from './reasoning/ReasoningBlock';
import { ToolCallView } from './tool-call-view';
import { SubagentActivityCard } from './subagent/SubagentActivityCard';

const StreamingMarkdownView = lazy(() => import('./streaming-markdown-view').then((module) => ({ default: module.StreamingMarkdownView })));

type ChatMessageRowProps = {
  message: ChatTranscriptMessage;
  onApprovalDecision?: (approvalId: string, decisions: ChatResumeDecision[]) => void;
};

const finishedEnterKeys = new Set<string>();
const finishedEnterOrder: string[] = [];
const enterMountTokens = new Map<string, number>();

// 历史窗口会丢掉旧消息，但进场 key 原先一直留着。只记最近一批，避免 renderer 按运行次数一直涨。
export const maxFinishedEnterKeys = 200;

export function rememberFinishedEnterKey(key: string): void {
  if (finishedEnterKeys.has(key)) {
    return;
  }
  finishedEnterKeys.add(key);
  finishedEnterOrder.push(key);
  while (finishedEnterOrder.length > maxFinishedEnterKeys) {
    const oldest = finishedEnterOrder.shift();
    if (oldest !== undefined) {
      finishedEnterKeys.delete(oldest);
    }
  }
}

function motionSuppressed(): boolean {
  if (typeof document === 'undefined') {
    return false;
  }
  if (document.documentElement.dataset.motion === 'conserve') {
    return true;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function shouldPlayEnter(key: string, source: ChatTranscriptMessage['source']): boolean {
  if (source === 'persisted' || finishedEnterKeys.has(key)) {
    return false;
  }
  if (motionSuppressed()) {
    rememberFinishedEnterKey(key);
    return false;
  }
  return true;
}

function commitEnter(key: string, event: AnimationEvent<HTMLDivElement>): void {
  if (event.target !== event.currentTarget) {
    return;
  }
  rememberFinishedEnterKey(key);
}

function useFinishEnterOnUnmount(key: string, active: boolean): void {
  useLayoutEffect(() => {
    if (!active) {
      return;
    }
    const token = (enterMountTokens.get(key) ?? 0) + 1;
    enterMountTokens.set(key, token);
    return () => {
      queueMicrotask(() => {
        if (enterMountTokens.get(key) !== token) {
          return;
        }
        rememberFinishedEnterKey(key);
        enterMountTokens.delete(key);
      });
    };
  }, [active, key]);
}

/** 有结构化块就用块；否则把裸 reasoning 当成一个块渲染，让历史消息也能显示推理。 */
function resolveActivityBlocks(
  message: ChatTranscriptMessage,
  blocks: ChatTranscriptActivityBlock[]
): ChatTranscriptActivityBlock[] {
  if (blocks.length > 0) {
    return blocks;
  }
  if (message.reasoning === null) {
    return [];
  }
  return [
    {
      id: `${message.key}-reasoning`,
      kind: 'reasoning',
      content: message.reasoning,
      isStreaming: message.isStreaming
    } satisfies ChatTranscriptActivityBlock
  ];
}

function ChatMessageRowImpl({ message, onApprovalDecision }: ChatMessageRowProps): React.JSX.Element {
  const isAssistant = message.role === 'assistant';
  const blocks = message.blocks ?? [];
  const attachments = message.attachments === undefined ? [] : message.attachments;
  const activityBlocks = resolveActivityBlocks(message, blocks);
  const bubbleClassName = isAssistant ? 'chat-bubble chat-bubble--assistant' : 'chat-bubble chat-bubble--user';
  const rowClassName = isAssistant ? 'chat-message-row chat-message-row--assistant' : 'chat-message-row chat-message-row--user';
  const testId = isAssistant ? 'chat-message-assistant' : 'chat-message-user';
  const animateEntry = shouldPlayEnter(message.key, message.source);
  useFinishEnterOnUnmount(message.key, animateEntry);
  const body = (
    <article className={bubbleClassName}>
      {isAssistant ? (
        <div className="chat-assistant-content" data-testid="chat-assistant-content">
          {activityBlocks.map((block) => (
            <ChatActivityBlockView key={block.id} block={block} />
          ))}
          {message.content.length === 0 ? null : (
            <Suspense fallback={null}>
              <StreamingMarkdownView text={message.content} isStreaming={message.isStreaming} />
            </Suspense>
          )}
          {message.interrupts.map((interrupt) => (
            <ChatInterruptView
              interrupt={interrupt}
              key={interrupt.interruptId}
              onApprovalDecision={onApprovalDecision}
              source={message.source}
            />
          ))}
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
  );
  return (
    <div
      className={animateEntry ? `${rowClassName} chat-message-row--enter` : rowClassName}
      data-role={message.role}
      data-testid={testId}
      onAnimationEnd={animateEntry ? (event) => commitEnter(message.key, event) : undefined}
    >
      {body}
    </div>
  );
}

export const ChatMessageRow = memo(
  ChatMessageRowImpl,
  (prev, next) =>
    prev.message.key === next.message.key &&
    prev.message.source === next.message.source &&
    prev.message.role === next.message.role &&
    prev.message.content === next.message.content &&
    prev.message.attachments === next.message.attachments &&
    prev.message.reasoning === next.message.reasoning &&
    prev.message.blocks === next.message.blocks &&
    prev.message.interrupts === next.message.interrupts &&
    prev.message.isStreaming === next.message.isStreaming
);

function ChatInterruptView(input: {
  interrupt: ChatPendingInterrupt;
  onApprovalDecision?: (approvalId: string, decisions: ChatResumeDecision[]) => void;
  source: ChatTranscriptMessage['source'];
}): React.JSX.Element {
  const { interrupt } = input;
  const approvalKey = `approval:${interrupt.interruptId}`;
  const animateApproval = interrupt.kind === 'question' || isTaskApproval(interrupt) || isResearchGateApproval(interrupt)
    ? false
    : shouldPlayEnter(approvalKey, input.source);
  useFinishEnterOnUnmount(approvalKey, animateApproval);
  if (interrupt.kind === 'question') {
    return <QuestionInterruptCard question={interrupt} />;
  }
  if (isTaskApproval(interrupt)) {
    return <TaskApprovalCard approval={interrupt} onApprovalDecision={input.onApprovalDecision} />;
  }
  if (isResearchGateApproval(interrupt)) {
    return <ResearchGateApprovalCard approval={interrupt} onApprovalDecision={input.onApprovalDecision} />;
  }
  const editableAction = interrupt.actionRequests.length === 1 ? interrupt.actionRequests[0] : undefined;
  const approvalBody = (
    <>
      <header className="chat-approval-head">
        等待审批
        <span className="chat-approval-count">{interrupt.actionRequests.length}</span>
      </header>
      <ul className="chat-approval-actions">
        {interrupt.actionRequests.map((request, index) => {
          const reviewConfig = interrupt.reviewConfigs.find((config) => config.actionName === request.name);
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
          onClick={() => input.onApprovalDecision?.(interrupt.interruptId, interrupt.actionRequests.map(() => ({ type: 'approve' })))}
        >
          approve
        </button>
        <button
          type="button"
          className="approval-btn approval-btn--reject"
          onClick={() => input.onApprovalDecision?.(interrupt.interruptId, interrupt.actionRequests.map(() => ({ type: 'reject' })))}
        >
          reject
        </button>
        {editableAction !== undefined && interrupt.reviewConfigs.some((config) => config.allowedDecisions.includes('edit')) ? (
          <button
            type="button"
            className="approval-btn approval-btn--edit"
            onClick={() => input.onApprovalDecision?.(interrupt.interruptId, [{ type: 'edit', editedAction: editableAction }])}
          >
            edit
          </button>
        ) : null}
      </div>
    </>
  );
  return (
    <div
      className={animateApproval ? 'chat-approval-card chat-approval-card--enter' : 'chat-approval-card'}
      data-testid="chat-approval-card"
      onAnimationEnd={animateApproval ? (event) => commitEnter(approvalKey, event) : undefined}
    >
      {approvalBody}
    </div>
  );
}

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
        <Suspense fallback={null}>
          <StreamingMarkdownView text={block.content} isStreaming={false} />
        </Suspense>
      </div>
    </details>
  );
}
