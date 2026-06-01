import { useEffect, useMemo, useRef, useState, useDeferredValue } from 'react';
import type { LoadedState } from '../loaded-state';
import { buildChatTranscript } from '../chat-transcript';
import { useChatRun } from './use-chat-run';
import { ChatTranscriptPanel } from './chat-transcript-panel';
import { ChatComposer } from './chat-composer';
import type { ChatResumeDecision, TaskEvent } from '../../shared/types';
import type { ChatTaskSubmitPayload, QueuedTaskPrompt } from './task-run-payload';

type ComposerPopover = 'tools' | 'skills' | 'models' | null;

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

type ChatViewProps = {
  chatSelectionVersion: number;
  queuedTaskPrompt: QueuedTaskPrompt | null;
  onQueuedTaskPromptHandled: () => void;
  selectedThreadId: string | null;
  state: LoadedState;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
  onSubmitChatTask: (payload: ChatTaskSubmitPayload) => Promise<{ ok: true } | { ok: false; error: string }>;
};

export function buildChatResumeRunRequest(input: {
  runId: string;
  threadId: string;
  interruptId: string;
  decisions: ChatResumeDecision[];
}) {
  return {
    runId: input.runId,
    threadId: input.threadId,
    interruptId: input.interruptId,
    decisions: input.decisions
  };
}

export function ChatView({
  chatSelectionVersion,
  queuedTaskPrompt,
  onQueuedTaskPromptHandled,
  selectedThreadId,
  state,
  updateLoadedState,
  onSubmitChatTask
}: ChatViewProps): React.JSX.Element {
  const chatRun = useChatRun();
  const [chatInput, setChatInput] = useState('');
  const [pendingUserInput, setPendingUserInput] = useState<string | null>(null);
  const [selectedAttachments, setSelectedAttachments] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [activeComposerPopover, setActiveComposerPopover] = useState<ComposerPopover>(null);
  const [persistedMessages, setPersistedMessages] = useState<TaskEvent[]>([]);
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);
  const queuedTaskPromptInFlightRef = useRef<string | null>(null);

  const deferredAssistantMessage = useDeferredValue(chatRun.state.assistantMessage);
  const deferredReasoning = useDeferredValue(chatRun.state.reasoning);
  const activeThreadId = selectedThreadId ?? chatRun.state.threadId;
  const latestPersistedMessageEventId =
    activeThreadId === null
      ? null
      : state.taskSnapshot.recentEvents.find((event) => event.threadId === activeThreadId && event.type === 'message')?.id ?? null;

  const chatTranscript = useMemo(
    () =>
      buildChatTranscript({
        promotedThreadIds: new Set(
          state.activeTasks
            .filter((item) => item.kind === 'background')
            .map((item) => item.threadId)
        ),
        chatRunState: {
          ...chatRun.state,
          assistantMessage: deferredAssistantMessage,
          reasoning: deferredReasoning
        },
        pendingUserInput,
        persistedMessages,
        selectedThreadId,
        taskSnapshot: state.taskSnapshot
      }),
    [
      chatRun.state,
      deferredAssistantMessage,
      deferredReasoning,
      pendingUserInput,
      persistedMessages,
      selectedThreadId,
      state.activeTasks,
      state.taskSnapshot
    ]
  );

  useEffect(() => {
    if (pendingUserInput === null || selectedThreadId === null) {
      return;
    }
    const hasPersistedUserMessage = state.taskSnapshot.recentEvents.some((event) => {
      if (event.threadId !== selectedThreadId || event.type !== 'message') {
        return false;
      }
      if (typeof event.payload !== 'object' || event.payload === null) {
        return false;
      }
      return Reflect.get(event.payload, 'role') === 'user' && Reflect.get(event.payload, 'content') === pendingUserInput;
    });
    if (hasPersistedUserMessage) {
      setPendingUserInput(null);
    }
  }, [pendingUserInput, selectedThreadId, state.taskSnapshot.recentEvents]);

  useEffect(() => {
    let cancelled = false;

    async function loadPersistedMessages(threadId: string): Promise<void> {
      const result = await window.roc.tasks.getThreadMessages({ threadId });
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      if (cancelled) {
        return;
      }
      setPersistedMessages(result.data);
    }

    if (activeThreadId === null || latestPersistedMessageEventId === null) {
      setPersistedMessages([]);
      return;
    }

    void loadPersistedMessages(activeThreadId).catch(() => {
      if (!cancelled) {
        setPersistedMessages([]);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [activeThreadId, latestPersistedMessageEventId]);

  useEffect(() => {
    setChatInput('');
    setPendingUserInput(null);
    setPersistedMessages([]);
    setSelectedAttachments([]);
    setSubmitting(false);
    setActiveComposerPopover(null);
    chatRun.reset();
    // chatRun.reset 引用每次渲染都会变；只依赖版本号触发重置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatSelectionVersion]);

  useEffect(() => {
    if (queuedTaskPrompt === null) {
      return;
    }
    if (state.agent.execution !== 'ready') {
      return;
    }
    const queuedTaskPromptKey = buildQueuedTaskPromptKey(queuedTaskPrompt);
    if (queuedTaskPromptInFlightRef.current === queuedTaskPromptKey) {
      return;
    }

    queuedTaskPromptInFlightRef.current = queuedTaskPromptKey;
    setSubmitting(true);
    void onSubmitChatTask({
      input: queuedTaskPrompt.input,
      workflowHint: queuedTaskPrompt.workflowHint
    })
      .then((result) => {
        if (result.ok) {
          setPendingUserInput(queuedTaskPrompt.input);
          queuedTaskPromptInFlightRef.current = null;
          onQueuedTaskPromptHandled();
        } else {
          chatRun.setError(result.error);
          queuedTaskPromptInFlightRef.current = null;
          onQueuedTaskPromptHandled();
        }
      })
      .finally(() => {
        setSubmitting(false);
      });
  }, [onQueuedTaskPromptHandled, onSubmitChatTask, queuedTaskPrompt, state.agent.execution]);

  async function submitCurrentInput(): Promise<void> {
    const trimmedInput = chatInput.trim();
    const sendDisabled = submitting || trimmedInput.length === 0 || state.agent.execution !== 'ready';
    if (sendDisabled) {
      return;
    }
    setSubmitting(true);
    try {
      const result = await onSubmitChatTask({ input: trimmedInput });
      if (result.ok) {
        setPendingUserInput(trimmedInput);
        setChatInput('');
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
    const result = await window.roc.chat.resumeRun(buildChatResumeRunRequest({
      runId: chatRun.state.runId,
      threadId: chatRun.state.threadId,
      interruptId: approvalId,
      decisions
    }));
    if (!result.ok) {
      chatRun.setError(result.error.message);
    }
  }

  const liveSignal = `${chatRun.state.runId ?? ''}|${deferredAssistantMessage.length}|${deferredReasoning.length}`;
  const showEmptyState = chatTranscript.length === 0;
  const isAwaitingFirstByte =
    chatRun.state.status === 'running' &&
    deferredAssistantMessage.length === 0 &&
    deferredReasoning.length === 0;

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
              <ChatTranscriptPanel
                messages={chatTranscript}
                liveSignal={liveSignal}
                scrollContainerRef={transcriptScrollRef}
                onApprovalDecision={(approvalId, decisions) => {
                  void handleApprovalDecision(approvalId, decisions);
                }}
              />
              <ChatWaitingIndicator visible={isAwaitingFirstByte} />
            </div>
          </div>
        </div>
      </div>
      <div className={showEmptyState ? 'chat-bottom-stack chat-bottom-stack--empty' : 'chat-bottom-stack'}>
        <ChatComposer
          chatInput={chatInput}
          onChatInputChange={setChatInput}
          selectedAttachments={selectedAttachments}
          onSelectedAttachmentsChange={setSelectedAttachments}
          activeComposerPopover={activeComposerPopover}
          onActiveComposerPopoverChange={setActiveComposerPopover}
          submitting={submitting}
          state={state}
          updateLoadedState={updateLoadedState}
          onSubmit={submitCurrentInput}
        />
      </div>
    </section>
  );
}

function buildQueuedTaskPromptKey(prompt: QueuedTaskPrompt): string {
  return `${prompt.workflowHint ?? 'none'}\0${prompt.input}`;
}
