import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../app/loaded-state';
import type { ChatImageAttachment, ChatResumeDecision, ChatRunMode } from '../../shared/types';
import type { RocClient } from '../shared/roc-client';
import { getMcpConfig } from '../shared/mcp-store';
import { createChatTranscriptProjector, type ChatTranscriptMessage } from './transcript';
import { useChatRun } from './use-chat-run';
import { usePersistedThreadHistory, type PersistedThreadHistory } from './use-persisted-thread-history';
import type { ChatRunState } from './run-state';
import { cancelRun, correctRun, getActiveRun, getRunEventsReplay, getRunInputs, resumeApproval, resumeCheckpoint as resumeCheckpointRequest, resumeQuestion, startRun, type RunInputKind, type RunInputReceipt } from './session-store';

// Keep uncertain submissions stable when the assistant panel closes and reopens.
// This shares the lifetime of the in-memory composer drafts, without persisting prompt content.
const pendingInputSubmissions = new WeakMap<RocClient, Map<string, string>>();

/**
 * The assistant's run wiring (T4.2/T4.3).
 *
 * Composes three pieces that already exist — the ported event reducer (`useChatRun`), the
 * ported history pager (`usePersistedThreadHistory`), and the ported transcript projector
 * (`projectChatTranscript`) — and owns only what is genuinely new in this shell:
 *
 *   - **`send`** builds the real `chat.startRun` payload and keeps the typed text on
 *     failure, because a failed send that also clears the box loses the user's prompt.
 *   - Recovery belongs to this module: `chat.getActiveRun` and replay from sequence 0
 *     restore a run started while the panel was closed, while scope changes discard old
 *     responses. `run.applyReplay` de-duplicates anything the live stream already delivered.
 *   - **`liveRun` is fed to the projector only when the run is not idle.** Passing a stale
 *     terminal run state would render its blocks a second time on top of the persisted
 *     history of the same run.
 *
 * Token usage is deliberately not tracked here: `ChatRunState` has no such field and the
 * plan says to hide it when it cannot be sourced (T4.6), rather than estimate it.
 */

export type SendChatInput = {
  text: string;
  mode: ChatRunMode;
  skillIds: string[];
  attachments: ChatImageAttachment[];
};

export type ChatSession = {
  messages: ChatTranscriptMessage[];
  runState: ChatRunState;
  errorMessage: string | null;
  /** The optimistic echo of the prompt while `startRun` is in flight. */
  pendingUserInput: string | null;
  sending: boolean;
  cancelling: boolean;
  history: PersistedThreadHistory;
  runInputs: RunInputReceipt[];
  runInputsError: string | null;
  refreshRunInputs: () => void;
  send: (input: SendChatInput) => Promise<boolean>;
  sendRunInput: (input: SendChatInput & {kind: RunInputKind}) => Promise<boolean>;
  cancel: () => Promise<void>;
  resumeApproval: (interruptId: string, decisions: ChatResumeDecision[]) => Promise<boolean>;
  resumeQuestion: (interruptId: string, answer: string) => Promise<boolean>;
  resumeCheckpoint: (runId: string) => Promise<boolean>;
  retryRecovery: () => void;
};

export function useChatSession(input: {
  client: RocClient;
  threadId: string | null;
  projectId: string | null;
  workspacePath: string | null;
  /** Called when the backend created a thread for a fresh conversation. */
  onThreadId: (threadId: string) => void;
}): ChatSession {
  const { client, threadId, projectId, workspacePath, onThreadId } = input;
  const [pendingUserInput, setPendingUserInput] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [stopRunId, setStopRunId] = useState<string | null>(null);
  const [recoveryAttempt, setRecoveryAttempt] = useState(0);
  const [runInputsRefresh, setRunInputsRefresh] = useState(0);
  const refreshRunInputs = useCallback(() => setRunInputsRefresh(value => value + 1), []);
  const [inputReceipts, setInputReceipts] = useState<{scope: object; threadId: string; runId: string; items: RunInputReceipt[]; error: string | null} | null>(null);
  const retryRecovery = useCallback(() => setRecoveryAttempt((current) => current + 1), []);
  const scopeRef = useRef({ client, threadId, projectId, workspacePath, active: true, mutating: false, stopRunId: null as string | null });
  const previous = scopeRef.current;
  if (previous.client !== client || previous.threadId !== threadId || previous.projectId !== projectId || previous.workspacePath !== workspacePath) {
    scopeRef.current = { client, threadId, projectId, workspacePath, active: true, mutating: false, stopRunId: null };
  }
  const scope = scopeRef.current;
  const run = useChatRun(client, { threadId, acceptUnboundEvents: sending });
  const { reset, setError, applyReplay, getCurrentState } = run;
  const cancellable = run.state.status === 'running' || run.state.status === 'recovering';
  const cancelling = stopRunId !== null && stopRunId === run.state.runId &&
    (cancellable || run.state.status === 'waiting_user');
  const history = usePersistedThreadHistory({
    client,
    threadId,
    // Opaque "something changed" signal for the pager's catch-up pass. The run id is the
    // right one: a new run is exactly when new events get persisted for this thread.
    latestPersistedThreadEventId: run.state.runId
  });

  const liveRun = run.state.status === 'idle' ? null : run.state;
  const projectTranscript = useMemo(createChatTranscriptProjector, []);
  const messages = projectTranscript({ events: history.events, liveRun, pendingUserInput: sending ? pendingUserInput : null, threadId });
  const latestHistoryEvent = history.events.at(-1);
  const inputsRunId = run.state.threadId === threadId && run.state.runId !== null
    ? run.state.runId : latestHistoryEvent?.threadId === threadId ? latestHistoryEvent.runId : null;
  const currentInputReceipts = inputReceipts?.scope === scope && inputReceipts.threadId === threadId && inputReceipts.runId === inputsRunId
    ? inputReceipts : null;

  useEffect(() => {
    if (threadId === null || inputsRunId === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const isCurrent = () => !cancelled && scopeRef.current === scope && scope.active;
    const refresh = async (): Promise<void> => {
      try {
        const result = await getRunInputs(client, {runId: inputsRunId, threadId});
        if (!isCurrent()) return;
        if (!result.ok) throw new Error(result.error.message);
        if (result.data.runId !== inputsRunId || result.data.threadId !== threadId) {
          throw new Error('运行输入记录与当前会话不匹配。');
        }
        setInputReceipts({...result.data, scope, error: null});
        if (result.data.items.some(item => item.status === 'queued') &&
          (run.state.status === 'running' || run.state.status === 'recovering' || run.state.status === 'waiting_user')) {
          timer = setTimeout(() => void refresh(), 1500);
        }
      } catch (caught) {
        if (!isCurrent()) return;
        setInputReceipts(current => ({scope, threadId, runId: inputsRunId,
          items: current?.scope === scope && current.threadId === threadId && current.runId === inputsRunId ? current.items : [],
          error: errorMessage(caught)}));
      }
    };
    void refresh();
    return () => {cancelled = true; clearTimeout(timer);};
  }, [client, inputsRunId, run.state.status, runInputsRefresh, scope, threadId]);

  useEffect(() => {
    if (stopRunId !== null && !cancelling && scope.stopRunId === stopRunId) {
      scope.stopRunId = null;
      setStopRunId(null);
    }
  }, [cancelling, scope, stopRunId]);

  const runMutation = useCallback(async (
    mutation: (isCurrent: () => boolean) => Promise<boolean>
  ): Promise<boolean> => {
    const isCurrent = (): boolean => scopeRef.current === scope && scope.active;
    if (!isCurrent() || scope.mutating || scope.stopRunId !== null) return false;
    scope.mutating = true;
    setSending(true);
    setError(null);
    try {
      return await mutation(isCurrent);
    } catch (caught) {
      if (isCurrent()) setError(errorMessage(caught));
      return false;
    } finally {
      scope.mutating = false;
      if (isCurrent()) setSending(false);
    }
  }, [scope, setError]);

  const send = useCallback(
    async (sendInput: SendChatInput): Promise<boolean> => {
      const text = sendInput.text.trim();
      if (text.length === 0) {
        return false;
      }
      const { status } = getCurrentState();
      if (status === 'running' || status === 'recovering' || status === 'waiting_user') return false;
      return runMutation(async (isCurrent) => {
        setPendingUserInput(text);
        const mcpConfig = await getMcpConfig(client);
        if (!isCurrent()) return false;
        if (!mcpConfig.ok) {
          setError(mcpConfig.error.message);
          return false;
        }
        const result = await startRun(client, {
          input: text,
          mode: sendInput.mode,
          threadId,
          enabledCapabilities: {
            mcpServers: mcpConfig.data.servers.filter(server => server.enabled).map(server => server.id),
            skills: sendInput.skillIds
          },
          ...(projectId === null ? {} : { researchProjectId: projectId }),
          ...(sendInput.attachments.length === 0 ? {} : { attachments: sendInput.attachments }),
          ...(sendInput.skillIds.length === 0 ? {} : { explicitSkillIds: sendInput.skillIds })
        });
        if (!isCurrent()) return false;
        if (!result.ok) {
          // Keep the text: a failed send must not also discard the prompt.
          setError(result.error.message);
          return false;
        }
        setPendingUserInput(null);
        if (result.data.threadId !== null) {
          onThreadId(result.data.threadId);
        }
        return true;
      });
    },
    [client, getCurrentState, onThreadId, projectId, runMutation, setError, threadId]
  );

  const cancel = useCallback(async (): Promise<void> => {
    const isCurrent = (): boolean => scopeRef.current === scope && scope.active;
    const { runId, status } = getCurrentState();
    if (!isCurrent() || scope.stopRunId !== null || runId === null ||
      (status !== 'running' && status !== 'recovering')) return;
    const isStillActive = (): boolean => {
      if (!isCurrent() || scope.stopRunId !== runId) return false;
      const current = getCurrentState();
      return current.runId === runId &&
        (current.status === 'running' || current.status === 'recovering' || current.status === 'waiting_user');
    };
    const reportUnconfirmed = (message: string): void => {
      if (!isStillActive()) return;
      scope.stopRunId = null;
      setStopRunId(null);
      setError(message);
    };
    scope.stopRunId = runId;
    setStopRunId(runId);
    setError(null);
    try {
      const result = await cancelRun(client, runId);
      if (!isStillActive()) return;
      if (!result.ok) {
        reportUnconfirmed(result.error.message);
        return;
      }
      // A terminal event normally arrives first. Replay recovers it after a missed
      // delivery and handles the race where the run finished on its own.
      const replay = await getRunEventsReplay(client, { runId, afterSequence: 0 });
      if (!isStillActive()) return;
      if (!replay.ok) {
        reportUnconfirmed(replay.error.message);
        return;
      }
      applyReplay(replay.data, 0);
      reportUnconfirmed('未确认停止。可重试。');
    } catch (caught) {
      reportUnconfirmed(errorMessage(caught));
    }
  }, [applyReplay, client, getCurrentState, scope, setError]);

  const sendRunInput = useCallback(async (input: SendChatInput & {kind: RunInputKind}): Promise<boolean> => {
    const content = input.text.trim();
    const current = getCurrentState();
    const activeThreadId = current.threadId ?? threadId;
    const runId = current.runId;
    if (content.length === 0 || runId === null || runId !== run.state.runId || activeThreadId === null ||
      (current.status !== 'running' && current.status !== 'recovering') || current.pendingInterrupts.length > 0) return false;
    if (input.attachments.length > 0 || input.skillIds.length > 0) {
      setError('运行中仅接受文本补充。请移除图片和技能命令后重试。');
      return false;
    }
    return runMutation(async (isCurrent) => {
      const key = JSON.stringify([projectId, workspacePath, activeThreadId, runId, input.kind, content]);
      let submissions = pendingInputSubmissions.get(client);
      if (submissions === undefined) {
        submissions = new Map();
        pendingInputSubmissions.set(client, submissions);
      }
      const submissionId = submissions.get(key) ?? crypto.randomUUID();
      submissions.set(key, submissionId);
      const result = await correctRun(client, {
        runId, threadId: activeThreadId, content, kind: input.kind, submissionId
      });
      if (!isCurrent()) return false;
      if (!result.ok) {
        setError(result.error.message);
        refreshRunInputs();
        return false;
      }
      submissions.delete(key);
      setInputReceipts(receipts => {
        const items = receipts?.scope === scope && receipts.threadId === activeThreadId && receipts.runId === runId ? receipts.items : [];
        return {scope, threadId: activeThreadId, runId, error: null,
          items: items.some(item => item.submissionId === submissionId) ? items : [...items, {
            submissionId, sequence: result.data.sequence, content, kind: input.kind, status: 'queued'
          }]};
      });
      refreshRunInputs();
      return true;
    });
  }, [client, getCurrentState, projectId, refreshRunInputs, run.state.runId, runMutation, scope, setError, threadId, workspacePath]);

  const resumeWithApproval = useCallback(
    async (interruptId: string, decisions: ChatResumeDecision[]): Promise<boolean> => {
      return runMutation(async (isCurrent) => {
        const runId = run.state.runId;
        const activeThreadId = run.state.threadId ?? threadId;
        if (runId === null || activeThreadId === null) {
          setError('此审批已不在当前待恢复运行中。请查看任务状态，重新请求现有阶段的审核。');
          return false;
        }
        const result = await resumeApproval(client, { runId, threadId: activeThreadId, interruptId, decisions });
        if (!isCurrent()) return false;
        if (!result.ok) {
          setError(result.error.message);
          return false;
        }
        return true;
      });
    },
    [client, run.state.runId, run.state.threadId, runMutation, setError, threadId]
  );

  const resumeWithQuestion = useCallback(
    async (interruptId: string, answer: string): Promise<boolean> => {
      if (answer.trim().length === 0) return false;
      return runMutation(async (isCurrent) => {
        const runId = run.state.runId;
        const activeThreadId = run.state.threadId ?? threadId;
        if (runId === null || activeThreadId === null) return false;
        const result = await resumeQuestion(client, { runId, threadId: activeThreadId, interruptId, answer });
        if (!isCurrent()) return false;
        if (!result.ok) {
          setError(result.error.message);
          return false;
        }
        setPendingUserInput(null);
        return true;
      });
    },
    [client, run.state.runId, run.state.threadId, runMutation, setError, threadId]
  );

  const resumeFromCheckpoint = useCallback(async (runId: string): Promise<boolean> => {
    return runMutation(async (isCurrent) => {
      const activeThreadId = run.state.threadId ?? threadId;
      if (activeThreadId === null) return false;
      const result = await resumeCheckpointRequest(client, { runId, threadId: activeThreadId });
      if (!isCurrent()) return false;
      if (!result.ok) {
        setError(result.error.message);
        return false;
      }
      const replayed = await getRunEventsReplay(client, { runId, afterSequence: 0 });
      if (!isCurrent()) return false;
      if (!replayed.ok) {
        setError(replayed.error.message);
        return false;
      }
      applyReplay(replayed.data, 0);
      return true;
    });
  }, [applyReplay, client, run.state.threadId, runMutation, setError, threadId]);

  useEffect(() => {
    const scope = scopeRef.current;
    scope.active = true;
    reset();
    setPendingUserInput(null);
    setSending(false);
    setStopRunId(null);
    setInputReceipts(null);
    return () => { scope.active = false; };
  }, [client, threadId, projectId, workspacePath, reset]);

  useEffect(() => {
    const scope = scopeRef.current;
    let cancelled = false;
    const isCurrent = (): boolean => !cancelled && scopeRef.current === scope;
    if (threadId !== null) {
      void (async () => {
        try {
          const active = await getActiveRun(client, threadId);
          if (!isCurrent()) return;
          if (!active.ok) { setError(active.error.message); return; }
          if (active.data === null) return;
          const replayed = await getRunEventsReplay(client, { runId: active.data.runId, afterSequence: 0 });
          if (!isCurrent()) return;
          if (!replayed.ok) { setError(replayed.error.message); return; }
          applyReplay(replayed.data, 0);
        } catch (caught) {
          if (isCurrent()) setError(errorMessage(caught));
        }
      })();
    }
    return () => { cancelled = true; };
  }, [client, threadId, projectId, workspacePath, setError, applyReplay, recoveryAttempt]);

  return {
    messages,
    runState: run.state,
    errorMessage: run.errorMessage,
    pendingUserInput,
    sending,
    cancelling,
    history,
    runInputs: currentInputReceipts?.items ?? [],
    runInputsError: currentInputReceipts?.error ?? null,
    refreshRunInputs,
    send,
    sendRunInput,
    cancel,
    resumeApproval: resumeWithApproval,
    resumeQuestion: resumeWithQuestion,
    resumeCheckpoint: resumeFromCheckpoint,
    retryRecovery
  };
}
