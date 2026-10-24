import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../app/loaded-state';
import type { ChatImageAttachment, ChatResumeDecision, ChatRunMode } from '../../shared/types';
import type { RocClient } from '../shared/roc-client';
import { createChatTranscriptProjector, type ChatTranscriptMessage } from './transcript';
import { useChatRun } from './use-chat-run';
import { usePersistedThreadHistory, type PersistedThreadHistory } from './use-persisted-thread-history';
import type { ChatRunState } from './run-state';
import { cancelRun, getActiveRun, getRunEvents, resumeApproval, resumeCheckpoint as resumeCheckpointRequest, resumeQuestion, startRun } from './session-store';

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
  const [recoveryAttempt, setRecoveryAttempt] = useState(0);
  const retryRecovery = useCallback(() => setRecoveryAttempt((current) => current + 1), []);
  const scopeRef = useRef({ client, threadId, projectId, workspacePath, active: true });
  const previous = scopeRef.current;
  if (previous.client !== client || previous.threadId !== threadId || previous.projectId !== projectId || previous.workspacePath !== workspacePath) {
    scopeRef.current = { client, threadId, projectId, workspacePath, active: true };
  }
  const run = useChatRun(client, { threadId, acceptUnboundEvents: sending });
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

  const send = useCallback(
    async (sendInput: SendChatInput): Promise<boolean> => {
      const text = sendInput.text.trim();
      if (text.length === 0) {
        return false;
      }
      const scope = scopeRef.current;
      setSending(true);
      setPendingUserInput(text);
      run.setError(null);
      try {
        const result = await startRun(client, {
          input: text,
          mode: sendInput.mode,
          threadId,
          enabledCapabilities: { mcpServers: [], skills: sendInput.skillIds },
          ...(workspacePath === null ? {} : { workspacePath }),
          ...(projectId === null ? {} : { researchProjectId: projectId }),
          ...(sendInput.attachments.length === 0 ? {} : { attachments: sendInput.attachments }),
          ...(sendInput.skillIds.length === 0 ? {} : { explicitSkillIds: sendInput.skillIds })
        });
        if (scopeRef.current !== scope || !scope.active) return false;
        if (!result.ok) {
          // Keep the text: a failed send must not also discard the prompt.
          run.setError(result.error.message);
          return false;
        }
        setPendingUserInput(null);
        if (result.data.threadId !== null) {
          onThreadId(result.data.threadId);
        }
        return true;
      } catch (caught) {
        if (scopeRef.current === scope && scope.active) run.setError(errorMessage(caught));
        return false;
      } finally {
        if (scopeRef.current === scope && scope.active) setSending(false);
      }
    },
    [client, onThreadId, projectId, run, threadId, workspacePath]
  );

  const cancel = useCallback(async (): Promise<void> => {
    const runId = run.state.runId;
    if (runId === null) {
      return;
    }
    const scope = scopeRef.current;
    const result = await cancelRun(client, runId);
    if (scopeRef.current !== scope || !scope.active) return;
    if (!result.ok) {
      run.setError(result.error.message);
    }
  }, [client, run]);

  const resumeWithApproval = useCallback(
    async (interruptId: string, decisions: ChatResumeDecision[]): Promise<boolean> => {
      const runId = run.state.runId;
      const activeThreadId = run.state.threadId ?? threadId;
      if (runId === null || activeThreadId === null) {
        return false;
      }
      const scope = scopeRef.current;
      const result = await resumeApproval(client, { runId, threadId: activeThreadId, interruptId, decisions });
      if (scopeRef.current !== scope || !scope.active) return false;
      if (!result.ok) {
        run.setError(result.error.message);
        return false;
      }
      return true;
    },
    [client, run, threadId]
  );

  const resumeWithQuestion = useCallback(
    async (interruptId: string, answer: string): Promise<boolean> => {
      const runId = run.state.runId;
      const activeThreadId = run.state.threadId ?? threadId;
      if (runId === null || activeThreadId === null || answer.trim().length === 0) {
        return false;
      }
      const scope = scopeRef.current;
      const result = await resumeQuestion(client, { runId, threadId: activeThreadId, interruptId, answer });
      if (scopeRef.current !== scope || !scope.active) return false;
      if (!result.ok) {
        run.setError(result.error.message);
        return false;
      }
      setPendingUserInput(null);
      return true;
    },
    [client, run, threadId]
  );

  const resumeFromCheckpoint = useCallback(async (runId: string): Promise<boolean> => {
    const activeThreadId = run.state.threadId ?? threadId;
    if (activeThreadId === null) return false;
    const scope = scopeRef.current;
    const isCurrent = (): boolean => scopeRef.current === scope && scope.active;
    const result = await resumeCheckpointRequest(client, { runId, threadId: activeThreadId });
    if (!isCurrent()) return false;
    if (!result.ok) {
      run.setError(result.error.message);
      return false;
    }
    const replayed = await getRunEvents(client, { runId, afterSequence: 0 });
    if (!isCurrent()) return false;
    if (!replayed.ok) {
      run.setError(replayed.error.message);
      return false;
    }
    run.applyReplay(replayed.data.events);
    return true;
  }, [client, run, threadId]);

  const { reset, setError, applyReplay } = run;
  useEffect(() => {
    const scope = scopeRef.current;
    scope.active = true;
    reset();
    setPendingUserInput(null);
    setSending(false);
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
          const replayed = await getRunEvents(client, { runId: active.data.runId, afterSequence: 0 });
          if (!isCurrent()) return;
          if (!replayed.ok) { setError(replayed.error.message); return; }
          applyReplay(replayed.data.events);
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
    history,
    send,
    cancel,
    resumeApproval: resumeWithApproval,
    resumeQuestion: resumeWithQuestion,
    resumeCheckpoint: resumeFromCheckpoint,
    retryRecovery
  };
}
