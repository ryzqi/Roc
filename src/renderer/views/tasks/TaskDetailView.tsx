import { useMemo, useRef, useState } from 'react';
import type { ActiveTaskItem, ChatResumeDecision } from '../../../shared/types';
import type { ChatRunState } from '../../chat-run-state';
import { buildPersistedTranscriptMessages } from '../../chat-transcript';
import { ChatTranscriptPanel } from '../../chat/chat-transcript-panel';
import type { LoadedState } from '../../loaded-state';
import type { RocClient } from '../../shared/roc-client';
import type { TaskActions } from './use-task-actions';

export type TaskDetailApprovalRequest = {
  runId: string;
  threadId: string;
  interruptId: string;
  decisions: ChatResumeDecision[];
};

export type TaskDetailInputRequest = {
  input: string;
  taskId: string;
  threadId: string;
};

export function TaskDetailView({
  liveTaskRun,
  onApprovalDecision,
  onBackToBoard,
  onSubmitTaskInput,
  state,
  taskActions,
  taskId
}: {
  client: RocClient;
  liveTaskRun: ChatRunState | null;
  onApprovalDecision: (request: TaskDetailApprovalRequest) => Promise<{ ok: true } | { ok: false; error: string }>;
  onBackToBoard: () => void;
  onSubmitTaskInput: (payload: TaskDetailInputRequest) => Promise<{ ok: true } | { ok: false; error: string }>;
  state: LoadedState;
  taskActions: TaskActions;
  taskId: string;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
}): React.JSX.Element {
  const [followupInput, setFollowupInput] = useState('');
  const [inlineError, setInlineError] = useState<string | null>(null);
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);
  const detail = state.taskDetail;
  const transcript = useMemo(() => {
    if (detail === null) {
      return [];
    }
    return buildPersistedTranscriptMessages(detail.recentEvents, detail.threadId);
  }, [detail]);

  if (detail === null || detail.taskId !== taskId) {
    return (
      <section className="canvas-stage task-detail-page" data-testid="task-detail-view">
        <div className="task-detail-page-head">
          <button className="action-button" type="button" onClick={onBackToBoard}>
            返回任务工作台
          </button>
        </div>
        <div className="task-detail-content-shell">
          <div className="section-empty-state">
            <strong>任务不存在</strong>
            <p>当前任务不存在或已经删除。</p>
          </div>
        </div>
      </section>
    );
  }

  const loadedDetail = detail;
  const waitingUser = loadedDetail.thread.status === 'waiting_user';
  const liveSignal = `${liveTaskRun?.runId ?? ''}|${transcript.length}`;

  async function submitFollowup(): Promise<void> {
    const input = followupInput.trim();
    if (input.length === 0) {
      setInlineError('请输入继续任务的内容。');
      return;
    }
    const result = await onSubmitTaskInput({ input, taskId, threadId: loadedDetail.threadId });
    if (result.ok) {
      setFollowupInput('');
      setInlineError(null);
      return;
    }
    setInlineError(result.error);
  }

  return (
    <section className="canvas-stage task-detail-page" data-testid="task-detail-view">
      <div className="task-detail-page-head">
        <button className="action-button" type="button" onClick={onBackToBoard}>
          返回任务工作台
        </button>
        <div className="page-copy">
          <h1 className="page-title mini">{loadedDetail.thread.title}</h1>
          <p className="page-meta">{loadedDetail.thread.status}</p>
        </div>
      </div>
      <div className="task-detail-content-shell">
        <div className="task-detail-page-body" ref={transcriptScrollRef}>
          <div className="task-detail-transcript-shell">
            <ChatTranscriptPanel
              messages={transcript}
              liveSignal={liveSignal}
              scrollContainerRef={transcriptScrollRef}
              onApprovalDecision={(interruptId, decisions) => {
                if (loadedDetail.lastRunId === null) {
                  setInlineError('当前没有可恢复的审批运行。');
                  return;
                }
                void onApprovalDecision({
                  runId: loadedDetail.lastRunId,
                  threadId: loadedDetail.threadId,
                  interruptId,
                  decisions
                }).then((result) => {
                  if (result.ok) {
                    setInlineError(null);
                  } else {
                    setInlineError(result.error);
                  }
                });
              }}
            />
          </div>
          {waitingUser ? (
            <form
              className="task-detail-followup"
              onSubmit={(event) => {
                event.preventDefault();
                void submitFollowup();
              }}
            >
              <textarea
                data-testid="task-detail-followup-input"
                placeholder="继续说明任务需要的信息..."
                value={followupInput}
                onChange={(event) => setFollowupInput(event.target.value)}
              />
              <button className="action-button" data-testid="task-detail-followup-submit" type="submit">
                继续任务
              </button>
            </form>
          ) : null}
          {loadedDetail.backgroundTask === null ? null : (
            <TaskActionControls item={createTaskActionItem(loadedDetail)} taskActions={taskActions} />
          )}
          {inlineError === null ? null : <span className="inline-warning">{inlineError}</span>}
        </div>
      </div>
    </section>
  );
}

function TaskActionControls({
  item,
  taskActions
}: {
  item: ActiveTaskItem;
  taskActions: TaskActions;
}): React.JSX.Element {
  const terminal = item.status === 'cancelled' || item.status === 'completed' || item.status === 'archived';
  const paused = item.status === 'paused';

  return (
    <div className="task-detail-actions" data-testid="task-detail-actions">
      {terminal ? null : paused ? (
        <button className="action-button" data-testid="task-detail-action-resume" type="button" onClick={() => taskActions.resumeTask(item)}>
          恢复
        </button>
      ) : (
        <button className="action-button" data-testid="task-detail-action-pause" type="button" onClick={() => taskActions.pauseTask(item)}>
          暂停
        </button>
      )}
      {terminal ? null : (
        <>
          <button className="action-button" data-testid="task-detail-action-run-now" type="button" onClick={() => taskActions.runNow(item)}>
            立即运行
          </button>
          <button className="action-button" data-testid="task-detail-action-cancel" type="button" onClick={() => taskActions.cancelTask(item)}>
            取消任务
          </button>
        </>
      )}
      <button className="action-button" data-testid="task-detail-action-delete" type="button" onClick={() => taskActions.deleteTask(item)}>
        删除
      </button>
    </div>
  );
}

function createTaskActionItem(detail: NonNullable<LoadedState['taskDetail']>): ActiveTaskItem {
  const task = detail.backgroundTask;
  if (task === null) {
    throw new Error('task_detail_background_task_missing');
  }
  return {
    kind: 'background',
    threadId: task.threadId,
    taskId: task.id,
    title: detail.thread.title,
    goal: task.goal,
    status: task.status,
    trigger: null,
    nextRunAt: task.nextRunAt,
    lastRunAt: task.lastRunAt,
    riskLevel: task.riskLevel,
    workspacePath: task.workspacePath,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  };
}
