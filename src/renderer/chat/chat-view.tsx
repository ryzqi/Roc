import { useEffect, useMemo, useRef, useState, useDeferredValue } from 'react';
import type { LoadedState } from '../loaded-state';
import { buildChatTranscript } from '../chat-transcript';
import { useChatRun } from './use-chat-run';
import { ChatTranscriptPanel } from './chat-transcript-panel';
import { ChatComposer } from './chat-composer';
import type { TaskEvent } from '../../shared/types';

type ComposerPopover = 'tools' | 'skills' | 'models' | null;

type ChatViewProps = {
  chatSelectionVersion: number;
  selectedThreadId: string | null;
  state: LoadedState;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
  onSubmitChatTask: (input: string) => Promise<{ ok: true } | { ok: false; error: string }>;
};

export function ChatView({
  chatSelectionVersion,
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
        backgroundTasks: state.backgroundTasks,
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
      state.backgroundTasks,
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

  async function submitCurrentInput(): Promise<void> {
    const trimmedInput = chatInput.trim();
    const sendDisabled = submitting || trimmedInput.length === 0 || state.agent.execution !== 'ready';
    if (sendDisabled) {
      return;
    }
    setSubmitting(true);
    try {
      const result = await onSubmitChatTask(trimmedInput);
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

  const liveSignal = `${chatRun.state.runId ?? ''}|${deferredAssistantMessage.length}|${deferredReasoning.length}`;

  return (
    <section className="canvas-stage chat-stage" data-testid="chat-view">
      <div className="chat-empty-plane" aria-label="聊天主画布" ref={transcriptScrollRef}>
        <div className="chat-page-shell">
          <div className="chat-feedback-shell">
            <div className="chat-feedback-stack">
              {state.agent.execution !== 'ready' ? <span className="inline-warning" data-testid="chat-blocked">需要先配置默认模型</span> : null}
              {chatRun.errorMessage === null ? null : <span className="inline-warning" data-testid="chat-error">{chatRun.errorMessage}</span>}
              <ChatTranscriptPanel messages={chatTranscript} liveSignal={liveSignal} scrollContainerRef={transcriptScrollRef} />
            </div>
          </div>
        </div>
      </div>
      <div className="chat-bottom-stack">
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
