import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../app/loaded-state';
import type { ChatImageAttachment, ChatResumeDecision, ChatRunMode } from '../../shared/types';
import type { RocClient } from '../shared/roc-client';
import { getMcpConfig } from '../shared/mcp-store';
import { createChatTranscriptProjector, type ChatTranscriptMessage } from './transcript';
import { useChatRun } from './use-chat-run';
import { usePersistedThreadHistory, type PersistedThreadHistory } from './use-persisted-thread-history';
import type { ChatRunState } from './run-state';
import { cancelRun, getActiveRun, getRunEventsReplay, resumeApproval, resumeCheckpoint as resumeCheckpointRequest, resumeQuestion, startRun } from './session-store';

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
  send: (input: SendChatInput) => Promise<boolean>;
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
  const [cancelling, setCancelling] = useState(false);
  const [recoveryAttempt, setRecoveryAttempt] = useState(0);
  const retryRecovery = useCallback(() => setRecoveryAttempt((current) => current + 1), []);
  const scopeRef = useRef({ client, threadId, projectId, workspacePath, active: true, mutating: false, cancelling: false });
  const previous = scopeRef.current;
  if (previous.client !== client || previous.threadId !== threadId || previous.projectId !== projectId || previous.workspacePath !== workspacePath) {
    scopeRef.current = { client, threadId, projectId, workspacePath, active: true, mutating: false, cancelling: false };
  }
  const scope = scopeRef.current;
  const run = useChatRun(client, { threadId, acceptUnboundEvents: sending });
  const { reset, setError, applyReplay } = run;
  const history = usePersistedThreadHistory({
    client,
    threadId,
    // Opaque "something changed" signal for the pager's catch-up pass. The run id is the
    // right one: a new run is exactly when new events get persisted for this thread.
    latestPersistedThreadEventId: run.state.runId
  });

  const liveRun = run.state.status === 'idle' ? null : run.state;
  const projectTranscript = useMemo(createChatTranscriptProjector, []);
  const messages = projectTranscript({ events: history.events, liveRun, pendingUserInput, threadId });

  const runMutation = useCallback(async (
    mutation: (isCurrent: () => boolean) => Promise<boolean>
  ): Promise<boolean> => {
    const isCurrent = (): boolean => scopeRef.current === scope && scope.active;
    if (!isCurrent() || scope.mutating) return false;
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
    [client, onThreadId, projectId, runMutation, setError, threadId]
  );

  const cancel = useCallback(async (): Promise<void> => {
    const isCurrent = (): boolean => scopeRef.current === scope && scope.active;
    if (!isCurrent() || scope.cancelling) return;
    const runId = run.state.runId;
    if (runId === null) {
      return;
    }
    scope.cancelling = true;
    setCancelling(true);
    try {
      const result = await cancelRun(client, runId);
      if (isCurrent() && !result.ok) setError(result.error.message);
    } catch (caught) {
      if (isCurrent()) setError(errorMessage(caught));
    } finally {
      scope.cancelling = false;
      if (isCurrent()) setCancelling(false);
    }
  }, [client, run.state.runId, scope, setError]);

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
    setCancelling(false);
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
    send,
    cancel,
    resumeApproval: resumeWithApproval,
    resumeQuestion: resumeWithQuestion,
    resumeCheckpoint: resumeFromCheckpoint,
    retryRecovery
  };
}
