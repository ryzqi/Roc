import { memo, useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import type { ChatPendingInterrupt, ChatResumeDecision } from '../../../shared/types';
import type { ChatTranscriptActivityBlock, ChatTranscriptMessage } from '../transcript';
import { useCopyFeedback } from '../../shared/hooks/use-copy-feedback';
import {
  ChatApprovalCard,
  ResearchGateApprovalCard,
  TaskApprovalCard,
  isResearchGateApproval,
  isTaskApproval
} from './approval-cards';
import { GuardrailBlock } from './guardrail-block';
import { HookCallBlock } from './hook-call-block';
import { QuestionInterruptCard } from './question-card';
import { ReasoningBlock } from './reasoning-block';
import { SubagentActivityCard } from './subagent-card';
import { ToolCallBlock } from './tool-call-block';

/**
 * One transcript row (T4.3/T4.4), ported from `chat/chat-message-row.tsx`.
 *
 * Everything the migration plan cares about is here:
 *
 *   - **Every block kind has a branch**: reasoning / tool_call / hook_call / subagent,
 *     with `guardrail` as the typed fallback. That is the "don't lose event information"
 *     requirement (D3) made concrete — a new `kind` in the union is a type error here,
 *     not a silently dropped block.
 *   - **Interrupts render their own card**: question, background-task approval, research
 *     gate, or the generic approval. Predicates live in `approval-cards.tsx` so P6 can
 *     grow the task card without touching this file.
 *   - **The memo comparison is field-by-field, not identity**, because the transcript
 *     rebuilds message objects on every run event; without it every token would re-render
 *     every row (R8).
 *
 * One deliberate change: the legacy row played a CSS keyframe animation and tracked
 * completion with `onAnimationEnd`, plus a `data-motion="conserve"` check. This uses a
 * one-frame state flip + a short transition, relies on the global
 * `prefers-reduced-motion` rule for the reduced case, and marks the key as played as
 * soon as it mounts. Same visible behaviour (a new message fades in once, history never
 * replays), far less machinery, and the bounded key set — which existed so a long
 * session could not grow the renderer's memory without limit — is kept.
 */

export type ChatMessageRowProps = {
  message: ChatTranscriptMessage;
  onApprovalDecision?: (approvalId: string, decisions: ChatResumeDecision[]) => void;
};

const finishedEnterKeys = new Set<string>();
const finishedEnterOrder: string[] = [];

/** History windows drop old messages, so only the most recent batch is remembered. */
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

function shouldPlayEnter(key: string, source: ChatTranscriptMessage['source']): boolean {
  // Persisted history must not animate in: reopening a session would flash every row.
  return source !== 'persisted' && !finishedEnterKeys.has(key);
}

/** Plays the enter transition once per key, for the row and for interrupt cards. */
function useEnterTransition(key: string, enabled: boolean): boolean {
  const [entering, setEntering] = useState(enabled);
  useEffect(() => {
    if (!enabled) {
      setEntering(false);
      return;
    }
    rememberFinishedEnterKey(key);
    const frame = window.requestAnimationFrame(() => setEntering(false));
    return () => window.cancelAnimationFrame(frame);
  }, [enabled, key]);
  return entering;
}

const ENTER_CLASS = 'opacity-0 translate-y-1';
const ENTERED_CLASS = 'opacity-100 translate-y-0';

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
  const attachments = message.attachments ?? [];
  const activityBlocks = resolveActivityBlocks(message, message.blocks);
  const animateEntry = shouldPlayEnter(message.key, message.source);
  const entering = useEnterTransition(message.key, animateEntry);
  const motionClass = `transition-[opacity,transform] duration-[var(--duration-base)] ease-[var(--ease-soft)] motion-reduce:transition-none ${
    animateEntry ? (entering ? ENTER_CLASS : ENTERED_CLASS) : ''
  }`;

  return (
    <div
      className={`flex ${isAssistant ? 'justify-start' : 'justify-end'} px-3 py-1.5 ${motionClass}`}
      data-role={message.role}
      data-testid={isAssistant ? 'assistant-message-assistant' : 'assistant-message-user'}
    >
      {isAssistant ? (
        <article className="flex min-w-0 max-w-full flex-1 flex-col gap-1" data-testid="assistant-message-content">
          {activityBlocks.map((block) => (
            <ChatActivityBlockView key={block.id} block={block} />
          ))}
          {message.content.length === 0 ? null : (
            <StreamingText text={message.content} isStreaming={message.isStreaming} />
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
            <span
              aria-hidden="true"
              className="mt-0.5 h-3.5 w-1.5 animate-pulse rounded-full bg-accent motion-reduce:animate-none"
              data-testid="assistant-typing-cursor"
            />
          ) : null}
          {!message.isStreaming && message.content.length > 0 ? (
            <CopyAnswerButton content={message.content} />
          ) : null}
        </article>
      ) : (
        <article className="flex max-w-[92%] flex-col gap-1 rounded-card border border-line bg-bg-soft px-2.5 py-1.5">
          <p className="whitespace-pre-wrap text-ink text-[var(--font-read-size)]">{message.content}</p>
          {attachments.length === 0 ? null : (
            <div className="flex flex-wrap gap-1" data-testid="assistant-message-attachments">
              {attachments.map((attachment) => (
                <span
                  className="flex items-center gap-1 rounded-control bg-[var(--overlay-hover)] px-1.5 py-0.5 text-muted text-[var(--font-micro-size)]"
                  key={`${attachment.name}-${attachment.sizeBytes}`}
                >
                  <span className="max-w-[180px] truncate">{attachment.name}</span>
                  <span className="text-subtle">{Math.ceil(attachment.sizeBytes / 1024)} KB</span>
                </span>
              ))}
            </div>
          )}
        </article>
      )}
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

/**
 * Streaming helper text is lazily rendered so `streamdown` stays behind a dynamic
 * import (the eager-graph guard denies it at the entry).
 */
function StreamingText({ text, isStreaming }: { text: string; isStreaming: boolean }): React.JSX.Element {
  const [View, setView] = useState<React.ComponentType<{ text: string; isStreaming: boolean }> | null>(null);
  useEffect(() => {
    let cancelled = false;
    void import('./streaming-markdown-view').then((module) => {
      if (!cancelled) {
        setView(() => module.StreamingMarkdownView);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);
  if (View === null) {
    // First paint before the Markdown chunk lands: show the raw text rather than a
    // spinner, so the answer never appears to stall.
    return <p className="whitespace-pre-wrap text-[var(--font-read-size)]">{text}</p>;
  }
  return <View text={text} isStreaming={isStreaming} />;
}

function CopyAnswerButton({ content }: { content: string }): React.JSX.Element {
  const copy = useCopyFeedback();
  const label = copy.copied ? '已复制回答' : '复制回答';
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-testid="assistant-copy-answer"
      onClick={() => copy.copy(content)}
      className="flex h-6 w-6 items-center justify-center self-start rounded-control text-muted hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)]"
    >
      {copy.copied ? (
        <Check size={12} aria-hidden="true" className="text-[var(--st-ok)]" />
      ) : (
        <Copy size={12} aria-hidden="true" />
      )}
    </button>
  );
}

function ChatInterruptView(input: {
  interrupt: ChatPendingInterrupt;
  onApprovalDecision?: (approvalId: string, decisions: ChatResumeDecision[]) => void;
  source: ChatTranscriptMessage['source'];
}): React.JSX.Element {
  const { interrupt } = input;
  // Cards that the user must act on do not animate: an approval sliding into place while
  // the cursor is already moving toward a button is a click on the wrong control.
  const animateApproval = interrupt.kind === 'question' || isTaskApproval(interrupt) || isResearchGateApproval(interrupt)
    ? false
    : shouldPlayEnter(`approval:${interrupt.interruptId}`, input.source);
  const entering = useEnterTransition(`approval:${interrupt.interruptId}`, animateApproval);
  const motionClass = `transition-opacity duration-[var(--duration-base)] motion-reduce:transition-none ${
    animateApproval ? (entering ? 'opacity-0' : 'opacity-100') : ''
  }`;

  if (interrupt.kind === 'question') {
    return <QuestionInterruptCard question={interrupt} />;
  }
  if (isTaskApproval(interrupt)) {
    return (
      <div className={motionClass}>
        <TaskApprovalCard approval={interrupt} onApprovalDecision={input.onApprovalDecision} />
      </div>
    );
  }
  if (isResearchGateApproval(interrupt)) {
    return (
      <div className={motionClass}>
        <ResearchGateApprovalCard approval={interrupt} onApprovalDecision={input.onApprovalDecision} />
      </div>
    );
  }
  return (
    <div className={motionClass}>
      <ChatApprovalCard approval={interrupt} onApprovalDecision={input.onApprovalDecision} />
    </div>
  );
}

function ChatActivityBlockView({ block }: { block: ChatTranscriptActivityBlock }): React.JSX.Element {
  if (block.kind === 'reasoning') {
    return <ReasoningBlock id={block.id} content={block.content} isStreaming={block.isStreaming} />;
  }
  if (block.kind === 'tool_call') {
    return <ToolCallBlock block={block} />;
  }
  if (block.kind === 'hook_call') {
    return <HookCallBlock block={block} />;
  }
  if (block.kind === 'subagent') {
    return <SubagentActivityCard block={block} />;
  }
  return <GuardrailBlock block={block} />;
}
