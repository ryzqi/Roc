import { useEffect, useMemo, useRef, useState, useDeferredValue } from 'react';
import type { LoadedState } from '../loaded-state';
import { projectChatTranscript } from '../chat-transcript';
import { useChatRun } from './use-chat-run';
import { ChatTranscriptPanel } from './chat-transcript-panel';
import { ChatComposer } from './chat-composer';
import type {
  ChatPendingInterrupt,
  ChatPendingQuestion,
  ChatResumeDecision,
  ChatResumeRunRequest
} from '../../shared/types';
import type { RocClient } from '../shared/roc-client';
import type { ChatTaskSubmitPayload } from './task-run-payload';
import type { RendererImageAttachment } from './image-attachments';
import { isImageInputSupported, toChatImageAttachments } from './image-attachments';
import { parseSlashSkillCommand } from './slash-skill-command';
import { extractLastProposedPlan } from './proposed-plan';
import { usePersistedThreadHistory } from './use-persisted-thread-history';

type ComposerPopover = 'tools' | 'skills' | 'models' | null;
type ComposerMode = 'chat' | 'plan';

function ChatWaitingIndicator({ visible }: { visible: boolean }): React.JSX.Element | null {
  if (!visible) {
    return null;
  }
  return (
    <div className="chat-wait-indicator" data-testid="chat-wait-indicator" role="status" aria-live="polite">
      <span className="chat-wait-indicator-spinner" aria-hidden="true" />
      <span className="chat-wait-indicator-text">正在思考</span>
    </div>
  );
}

export type ChatViewProps = {
  chatSelectionVersion: number;
  client: RocClient;
  selectedThreadId: string | null;
  state: LoadedState;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
  onSubmitChatTask: (payload: ChatTaskSubmitPayload) => Promise<{ ok: true } | { ok: false; error: string }>;
};

export function buildChatApprovalResumeRunRequest(input: {
  runId: string;
  threadId: string;
  interruptId: string;
  decisions: ChatResumeDecision[];
}): ChatResumeRunRequest {
  return {
    kind: 'approval',
    runId: input.runId,
    threadId: input.threadId,
    interruptId: input.interruptId,
    decisions: input.decisions
  };
}

export function buildChatQuestionResumeRunRequest(input: {
  runId: string;
  threadId: string;
  interruptId: string;
  answer: string;
}): ChatResumeRunRequest {
  return {
    kind: 'question',
    runId: input.runId,
    threadId: input.threadId,
    interruptId: input.interruptId,
    answer: input.answer
  };
}

export function selectPendingQuestion(interrupts: readonly ChatPendingInterrupt[]): ChatPendingQuestion | null {
  const interrupt = interrupts[0];
  return interrupt?.kind === 'question' ? interrupt : null;
}

export function ChatView({
  chatSelectionVersion,
  client,
  selectedThreadId,
  state,
  updateLoadedState,
  onSubmitChatTask
}: ChatViewProps): React.JSX.Element {
  const chatRun = useChatRun(client);
  const [chatInput, setChatInput] = useState('');
  const [pendingUserInput, setPendingUserInput] = useState<string | null>(null);
  const [selectedAttachments, setSelectedAttachments] = useState<RendererImageAttachment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [activeComposerPopover, setActiveComposerPopover] = useState<ComposerPopover>(null);
  const [composerMode, setComposerMode] = useState<ComposerMode>('chat');
  // 记录已被用户处置（执行或继续规划）的 plan 运行，避免计划操作区停留在屏幕上
  const [dismissedPlanRunId, setDismissedPlanRunId] = useState<string | null>(null);
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);
  const selectedAttachmentsRef = useRef<RendererImageAttachment[]>([]);

  const deferredAssistantMessage = useDeferredValue(chatRun.state.assistantMessage);
  const deferredActivityBlocks = useDeferredValue(chatRun.state.activityBlocks);
  const activeThreadId = selectedThreadId ?? chatRun.state.threadId;
  const latestPersistedThreadEventId =
    activeThreadId === null
      ? null
      : state.taskSnapshot.recentEvents.find((event) => event.threadId === activeThreadId)?.id ?? null;
  const history = usePersistedThreadHistory({
    client,
    threadId: activeThreadId,
    latestPersistedThreadEventId
  });

  const chatTranscript = useMemo(
    () =>
      projectChatTranscript({
        events: history.events,
        liveRun: {
          ...chatRun.state,
          assistantMessage: deferredAssistantMessage,
          activityBlocks: deferredActivityBlocks
        },
        pendingUserInput,
        threadId: selectedThreadId
      }),
    [
      chatRun.state.runId,
      chatRun.state.mode,
      chatRun.state.threadId,
      chatRun.state.providerId,
      chatRun.state.modelId,
      chatRun.state.createdAt,
      chatRun.state.status,
      chatRun.state.durationMs,
      chatRun.state.summary,
      chatRun.state.errorCode,
      chatRun.state.errorMessage,
      chatRun.state.retryable,
      chatRun.state.pendingInterrupts,
      chatRun.state.resumeBusy,
      chatRun.state.todos,
      chatRun.state.subagents,
      deferredAssistantMessage,
      deferredActivityBlocks,
      history.events,
      pendingUserInput,
      selectedThreadId
    ]
  );
  const executablePlanText = useMemo(() => {
    if (chatRun.state.status !== 'completed' || chatRun.state.mode !== 'plan') {
      return null;
    }
    if (chatRun.state.runId !== null && chatRun.state.runId === dismissedPlanRunId) {
      return null;
    }
    return extractLastProposedPlan(chatRun.state.assistantMessage);
  }, [chatRun.state.assistantMessage, chatRun.state.mode, chatRun.state.runId, chatRun.state.status, dismissedPlanRunId]);

  useEffect(() => {
    if (pendingUserInput === null || selectedThreadId === null) {
      return;
    }
    const hasPersistedUserMessage = state.taskSnapshot.recentEvents.some((event) => {
      if (event.threadId !== selectedThreadId || event.type !== 'message') {
        return false;
      }
      return event.payload.role === 'user' && event.payload.content === pendingUserInput;
    });
    if (hasPersistedUserMessage) {
      setPendingUserInput(null);
    }
  }, [pendingUserInput, selectedThreadId, state.taskSnapshot.recentEvents]);

  useEffect(() => {
    selectedAttachmentsRef.current = selectedAttachments;
  }, [selectedAttachments]);

  useEffect(() => {
    setChatInput('');
    setPendingUserInput(null);
    revokeAttachmentPreviewUrls(selectedAttachmentsRef.current);
    setSelectedAttachments([]);
    setSubmitting(false);
    setActiveComposerPopover(null);
    setComposerMode('chat');
    setDismissedPlanRunId(null);
    chatRun.reset();
    // chatRun.reset 引用每次渲染都会变；只依赖版本号触发重置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatSelectionVersion]);

  async function submitCurrentInput(): Promise<void> {
    const parsedSkillCommand = parseSlashSkillCommand(
      chatInput,
      state.skills.filter((skill) => skill.enabled && skill.status === 'ready').map((skill) => skill.id)
    );
    if (parsedSkillCommand.kind === 'error') {
      chatRun.setError(parsedSkillCommand.message);
      return;
    }
    const submissionInput = parsedSkillCommand.kind === 'ok' ? parsedSkillCommand.input : chatInput;
    const trimmedInput = submissionInput.trim();
    const pendingQuestion = selectPendingQuestion(chatRun.state.pendingInterrupts);
    const imageInputSupported = isImageInputSupported(state);
    const sendDisabled =
      submitting ||
      trimmedInput.length === 0 ||
      state.agent.execution !== 'ready' ||
      (pendingQuestion === null && selectedAttachments.length > 0 && !imageInputSupported);
    if (sendDisabled) {
      return;
    }
    setSubmitting(true);
    try {
      if (pendingQuestion !== null) {
        if (chatRun.state.runId === null || chatRun.state.threadId === null) {
          chatRun.setError('当前没有可恢复的提问运行。');
          return;
        }
        const result = await client.api.chat.resumeRun(
          buildChatQuestionResumeRunRequest({
            runId: chatRun.state.runId,
            threadId: chatRun.state.threadId,
            interruptId: pendingQuestion.interruptId,
            answer: trimmedInput
          })
        );
        if (result.ok) {
          setPendingUserInput(trimmedInput);
          setChatInput('');
          revokeAttachmentPreviewUrls(selectedAttachments);
          setSelectedAttachments([]);
        } else {
          chatRun.setError(result.error.message);
        }
        return;
      }
      const attachments = toChatImageAttachments(selectedAttachments);
      const payload: ChatTaskSubmitPayload = {
        input: trimmedInput
      };
      if (composerMode === 'plan') {
        payload.mode = 'plan';
      }
      if (attachments.length > 0) {
        payload.attachments = attachments;
      }
      if (parsedSkillCommand.kind === 'ok') {
        payload.explicitSkillIds = parsedSkillCommand.explicitSkillIds;
      }
      const result = await onSubmitChatTask(payload);
      if (result.ok) {
        setPendingUserInput(trimmedInput);
        setChatInput('');
        revokeAttachmentPreviewUrls(selectedAttachments);
        setSelectedAttachments([]);
      } else {
        chatRun.setError(result.error);
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleApprovalDecision(approvalId: string, decisions: ChatResumeDecision[]): Promise<void> {
    if (chatRun.state.runId === null || chatRun.state.threadId === null) {
      chatRun.setError('当前没有可恢复的审批运行。');
      return;
    }
    const result = await client.api.chat.resumeRun(
      buildChatApprovalResumeRunRequest({
        runId: chatRun.state.runId,
        threadId: chatRun.state.threadId,
        interruptId: approvalId,
        decisions
      })
    );
    if (!result.ok) {
      chatRun.setError(result.error.message);
    }
  }

  async function executePlan(planText: string): Promise<void> {
    if (submitting) {
      return;
    }
    const planRunId = chatRun.state.runId;
    setSubmitting(true);
    setComposerMode('chat');
    // 先隐藏计划操作区，避免已完成的 plan 运行继续占据界面
    setDismissedPlanRunId(planRunId);
    try {
      const result = await onSubmitChatTask({
        input: planText,
        mode: 'chat',
        cleanThread: true
      });
      if (result.ok) {
        setPendingUserInput(planText);
      } else {
        // 提交失败时恢复计划操作区，让用户可以重试
        setDismissedPlanRunId(null);
        setComposerMode('plan');
        chatRun.setError(result.error);
      }
    } finally {
      setSubmitting(false);
    }
  }

  function continuePlanning(): void {
    setDismissedPlanRunId(chatRun.state.runId);
    setComposerMode('plan');
  }

  const showEmptyState = chatTranscript.length === 0;
  const isAwaitingFirstByte =
    chatRun.state.status === 'running' &&
    deferredAssistantMessage.length === 0 &&
    deferredActivityBlocks.length === 0;

  return (
    <section className="canvas-stage chat-stage" data-testid="chat-view">
      <div className="chat-empty-plane" aria-label="聊天主画布" ref={transcriptScrollRef}>
        <div className="chat-page-shell">
          <div className={showEmptyState ? 'chat-feedback-shell chat-feedback-shell--empty' : 'chat-feedback-shell'}>
            <div className="chat-feedback-stack">
              {showEmptyState ? (
                <header className="chat-empty-copy" data-testid="chat-empty-state">
                  <h1>Roc 本地工作台</h1>
                  <p>问问 Roc 或交给它一个任务</p>
                </header>
              ) : null}
              {state.agent.execution !== 'ready' ? <span className="inline-warning" data-testid="chat-blocked">需要先配置默认模型</span> : null}
              {chatRun.errorMessage === null ? null : <span className="inline-warning" data-testid="chat-error">{chatRun.errorMessage}</span>}
              {history.error === null ? null : <span className="inline-warning" data-testid="chat-history-error">{history.error}</span>}
              <ChatTranscriptPanel
                threadId={activeThreadId}
                messages={chatTranscript}
                prependRevision={history.prependRevision}
                hasMoreBefore={history.hasMoreBefore}
                loadingOlder={history.loadingOlder}
                loadOlder={history.loadOlder}
                scrollContainerRef={transcriptScrollRef}
                onApprovalDecision={(approvalId, decisions) => {
                  void handleApprovalDecision(approvalId, decisions);
                }}
              />
              {executablePlanText === null ? null : (
                <div className="chat-plan-actions" data-testid="chat-plan-actions">
                  <button
                    className="chat-plan-action-primary"
                    data-testid="chat-plan-execute"
                    type="button"
                    onClick={() => void executePlan(executablePlanText)}
                  >
                    执行计划
                  </button>
                  <button
                    className="chat-plan-action-secondary"
                    data-testid="chat-plan-continue"
                    type="button"
                    onClick={continuePlanning}
                  >
                    继续规划
                  </button>
                </div>
              )}
              <ChatWaitingIndicator visible={isAwaitingFirstByte} />
            </div>
          </div>
        </div>
      </div>
      <div className={showEmptyState ? 'chat-bottom-stack chat-bottom-stack--empty' : 'chat-bottom-stack'}>
        <ChatComposer
          client={client}
          chatInput={chatInput}
          onChatInputChange={setChatInput}
          selectedAttachments={selectedAttachments}
          onSelectedAttachmentsChange={setSelectedAttachments}
          imageInputSupported={isImageInputSupported(state)}
          activeComposerPopover={activeComposerPopover}
          onActiveComposerPopoverChange={setActiveComposerPopover}
          composerMode={composerMode}
          onComposerModeChange={setComposerMode}
          submitting={submitting}
          state={state}
          updateLoadedState={updateLoadedState}
          onSubmit={submitCurrentInput}
        />
      </div>
    </section>
  );
}

function revokeAttachmentPreviewUrls(attachments: readonly RendererImageAttachment[]): void {
  attachments.forEach((attachment) => {
    if (attachment.previewUrl !== null) {
      URL.revokeObjectURL(attachment.previewUrl);
    }
  });
}
