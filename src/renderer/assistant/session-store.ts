import type {
  ActiveChatRun,
  ChatImageAttachment,
  ChatResumeDecision,
  ChatRunMode,
  ChatStartRunIpcRequest,
  ChatStartRunResult,
  SequencedChatRunEvent,
  TaskThread,
  WorkflowHint
} from '../../shared/types';
import type { IpcLikeResult } from '../app/loaded-state';
import type { RocClient } from '../shared/roc-client';

/**
 * Assistant data layer (P4/T4.2–T4.7).
 *
 * Thin wrappers plus the one **contract correction** this phase found, which is worth
 * stating because the plan's wording does not match the backend:
 *
 *   `agent.sessions.list` is **not** "list the sessions" — its input is
 *   `{ threadId, limit }` and it returns that thread's messages. The only place that
 *   enumerates threads is `tasks.getSnapshot()`, whose `threads[]` carry
 *   `{ id, kind: 'chat' | 'background', title, goal, status, createdAt, updatedAt }`.
 *   So the 会话 tab lists `kind === 'chat'` threads from the snapshot, and loads a
 *   thread's messages through `listThreadMessages` when it is opened.
 *
 *   **There is no project association on a thread.** `taskThreadSchema` has no project
 *   field, so "按当前项目过滤" (T4.7) cannot be honoured from real data. The UI shows the
 *   real chat threads and says so; the missing field is registered as a backend task
 *   order rather than faked by filtering on a title/prefix heuristic.
 */

export type StartRunInput = {
  input: string;
  mode: ChatRunMode;
  threadId: string | null;
  enabledCapabilities: { mcpServers: string[]; skills: string[] };
  workflowHint?: WorkflowHint;
  workspacePath?: string | null;
  researchProjectId?: string;
  attachments?: ChatImageAttachment[];
  explicitSkillIds?: string[];
};

export function startRun(client: RocClient, input: StartRunInput): Promise<IpcLikeResult<ChatStartRunResult>> {
  const request: ChatStartRunIpcRequest = { ...input };
  return client.api.chat.startRun({ ...request, dispatchKey: crypto.randomUUID() });
}

export function cancelRun(client: RocClient, runId: string): Promise<IpcLikeResult<{ runId: string; cancelled: boolean }>> {
  return client.api.chat.cancelRun(runId);
}

export function resumeApproval(
  client: RocClient,
  input: { runId: string; threadId: string; interruptId: string; decisions: ChatResumeDecision[] }
): Promise<IpcLikeResult<{ runId: string; threadId: string; resumedAt: string }>> {
  return client.api.chat.resumeRun({ kind: 'approval', ...input });
}

export function resumeQuestion(
  client: RocClient,
  input: { runId: string; threadId: string; interruptId: string; answer: string }
): Promise<IpcLikeResult<{ runId: string; threadId: string; resumedAt: string }>> {
  return client.api.chat.resumeRun({ kind: 'question', ...input });
}

export function getActiveRun(client: RocClient, threadId: string): Promise<IpcLikeResult<ActiveChatRun | null>> {
  return client.api.chat.getActiveRun({ threadId });
}

/**
 * Replays a run's events from `afterSequence`.
 *
 * The sequence cursor is required by the contract and it is also what makes reconnect
 * safe: a resumed panel asks for everything after the last sequence it has already
 * applied, so a re-delivered event cannot double-apply.
 */
export function getRunEvents(
  client: RocClient,
  input: { runId: string; afterSequence: number }
): Promise<IpcLikeResult<{ runId: string; events: SequencedChatRunEvent[] }>> {
  // Sequenced: each event carries its `sequence`, which is what
  // `shouldApplySequencedRunEvent` de-duplicates on when a live event and a replayed
  // one describe the same step.
  return client.api.chat.getRunEvents(input);
}

/** Every thread the backend knows about; the caller filters by `kind`. */
export function listThreads(client: RocClient): Promise<IpcLikeResult<{ threads: TaskThread[] }>> {
  return client.api.tasks.getSnapshot();
}

export function deleteThread(client: RocClient, threadId: string): Promise<IpcLikeResult<unknown>> {
  return client.api.tasks.deleteThread({ threadId });
}

