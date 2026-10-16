import { useCallback, useMemo, useState } from 'react';
import type { ChatImageAttachment, ChatResumeDecision, ChatRunMode } from '../../shared/types';
import type { RocClient } from '../shared/roc-client';
import { projectChatTranscript, readChatTranscriptMemoKey, type ChatTranscriptMessage } from './transcript';
import { useChatRun } from './use-chat-run';
import { usePersistedThreadHistory, type PersistedThreadHistory } from './use-persisted-thread-history';
import type { ChatRunState } from './run-state';
import { cancelRun, getActiveRun, getRunEvents, resumeApproval, resumeQuestion, startRun } from './session-store';

/**
 * The assistant's run wiring (T4.2/T4.3).
 *
 * Composes three pieces that already exist — the ported event reducer (`useChatRun`), the
 * ported history pager (`usePersistedThreadHistory`), and the ported transcript projector
 * (`projectChatTranscript`) — and owns only what is genuinely new in this shell:
 *
 *   - **`send`** builds the real `chat.startRun` payload and keeps the typed text on
 *     failure, because a failed send that also clears the box loses the user's prompt.
 *   - **`restoreActiveRun`** is what makes gate 5 pass: a run that started while the panel
 *     was closed is fetched with `chat.getActiveRun` and its events replayed from sequence
 *     0 through `run.applyReplay`, which de-duplicates against anything the live stream
 *     already delivered.
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
  restoreActiveRun: () => Promise<void>;
  /** Drops the live run state — used when switching to a different conversation. */
  resetRun: () => void;
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
  const run = useChatRun(client);
  const [pendingUserInput, setPendingUserInput] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const history = usePersistedThreadHistory({
    client,
    threadId,
    // Opaque "something changed" signal for the pager's catch-up pass. The run id is the
    // right one: a new run is exactly when new events get persisted for this thread.
    latestPersistedThreadEventId: run.state.runId
  });

  const liveRun = run.state.status === 'idle' ? null : run.state;
  const transcriptInput = useMemo(
    () => ({ events: history.events, liveRun, pendingUserInput, threadId }),
    // The memo key comes from the projector itself so a new state field cannot be silently
    // forgotten here (see `readChatTranscriptMemoKey`).
    [history.events, liveRun, pendingUserInput, threadId]
  );
  const memoKey = readChatTranscriptMemoKey(transcriptInput);
  const messages = useMemo(() => projectChatTranscript(transcriptInput), [memoKey]);

  const send = useCallback(
    async (sendInput: SendChatInput): Promise<boolean> => {
      const text = sendInput.text.trim();
      if (text.length === 0) {
        return false;
      }
      setSending(true);
      setPendingUserInput(text);
      run.setError(null);
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
      setSending(false);
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
    },
    [client, onThreadId, projectId, run, threadId, workspacePath]
  );

  const cancel = useCallback(async (): Promise<void> => {
    const runId = run.state.runId;
    if (runId === null) {
      return;
    }
    const result = await cancelRun(client, runId);
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
      const result = await resumeApproval(client, { runId, threadId: activeThreadId, interruptId, decisions });
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
      const result = await resumeQuestion(client, { runId, threadId: activeThreadId, interruptId, answer });
      if (!result.ok) {
        run.setError(result.error.message);
        return false;
      }
      setPendingUserInput(null);
      return true;
    },
    [client, run, threadId]
  );

  const resetRun = useCallback((): void => {
    run.reset();
    setPendingUserInput(null);
  }, [run]);

  const restoreActiveRun = useCallback(async (): Promise<void> => {
    if (threadId === null) {
      return;
    }
    const active = await getActiveRun(client, threadId);
    if (!active.ok) {
      run.setError(active.error.message);
      return;
    }
    if (active.data === null) {
      return;
    }
    const replayed = await getRunEvents(client, { runId: active.data.runId, afterSequence: 0 });
    if (!replayed.ok) {
      run.setError(replayed.error.message);
      return;
    }
    run.applyReplay(replayed.data.events);
  }, [client, run, threadId]);

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
    restoreActiveRun,
    resetRun
  };
}
