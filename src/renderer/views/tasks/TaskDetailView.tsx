import { ArrowLeft, Pause, Play, RotateCw, Trash2, XCircle } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import type { ActiveTaskItem, BackgroundTask, ChatResumeDecision } from '../../../shared/types';
import type { ChatRunState } from '../../chat-run-state';
import { appendLiveTranscriptMessages, buildPersistedTranscriptMessages } from '../../chat-transcript';
import { ChatTranscriptPanel } from '../../chat/chat-transcript-panel';
import { usePersistedThreadHistory } from '../../chat/use-persisted-thread-history';
import type { LoadedState } from '../../loaded-state';
import type { RocClient } from '../../shared/roc-client';
import type { TaskActions } from './use-task-actions';

export type TaskDetailApprovalRequest = {
  kind: 'approval';
  runId: string;
  threadId: string;
  interruptId: string;
  decisions: ChatResumeDecision[];
};

export type TaskDetailInputRequest = {
  input: string;
  taskId: string;
  threadId: string;
  workspacePath: string | null;
};

type LoadedTaskDetail = NonNullable<LoadedState['taskDetail']>;

export function TaskDetailView({
  client,
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
  const latestPersistedThreadEventId =
    detail === null
      ? null
      : state.taskSnapshot.recentEvents.find((event) => event.threadId === detail.threadId)?.id ?? null;
  const history = usePersistedThreadHistory({
    client,
    threadId: detail === null ? null : detail.threadId,
    latestPersistedThreadEventId
  });
  const transcript = useMemo(() => {
    if (detail === null) {
      return [];
    }
    const persistedMessages = buildPersistedTranscriptMessages(history.events, detail.threadId);
    if (liveTaskRun === null) {
      return persistedMessages;
    }
    return appendLiveTranscriptMessages({
      chatRunState: liveTaskRun,
      pendingUserInput: null,
      persistedMessages,
      selectedThreadId: detail.threadId
    });
  }, [detail, history.events, liveTaskRun]);

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
  const actionItem = loadedDetail.backgroundTask === null ? null : createTaskActionItem(loadedDetail);

  async function submitFollowup(): Promise<void> {
    const input = followupInput.trim();
    if (input.length === 0) {
      setInlineError('请输入继续任务的内容。');
      return;
    }
    const workspacePath = loadedDetail.backgroundTask === null ? null : loadedDetail.backgroundTask.workspacePath;
    const result = await onSubmitTaskInput({
      input,
      taskId,
      threadId: loadedDetail.threadId,
      workspacePath
    });
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
        <button className="action-button task-detail-back-button" type="button" onClick={onBackToBoard}>
          <ArrowLeft aria-hidden="true" size={16} />
          <span>返回任务工作台</span>
        </button>
        <div className="page-copy">
          <h1 className="page-title mini">{loadedDetail.thread.title}</h1>
        </div>
      </div>
      <div className="task-detail-content-shell">
        <div className="task-detail-page-body" data-testid="task-detail-page-body" ref={transcriptScrollRef}>
          <div className="task-detail-main-column">
            <TaskDetailSummaryPanel detail={loadedDetail} />
            <section className="task-detail-panel task-detail-transcript-shell">
              <div className="task-detail-panel-head">
                <div>
                  <span className="task-detail-kicker">Execution Stream</span>
                  <h2>执行记录</h2>
                </div>
                <span className="task-detail-count">{transcript.length} 条消息</span>
              </div>
              <ChatTranscriptPanel
                threadId={loadedDetail.threadId}
                messages={transcript}
                liveSignal={liveSignal}
                prependRevision={history.prependRevision}
                hasMoreBefore={history.hasMoreBefore}
                loadingOlder={history.loadingOlder}
                loadOlder={history.loadOlder}
                scrollContainerRef={transcriptScrollRef}
                onApprovalDecision={(interruptId, decisions) => {
                  if (loadedDetail.lastRunId === null) {
                    setInlineError('当前没有可恢复的审批运行。');
                    return;
                  }
                  void onApprovalDecision({
                    kind: 'approval',
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
              {history.error === null ? null : <span className="inline-warning">{history.error}</span>}
            </section>
            {waitingUser ? (
              <form
                className="task-detail-followup"
                data-testid="task-detail-followup"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitFollowup();
                }}
              >
                <div className="task-detail-panel-head">
                  <div>
                    <span className="task-detail-kicker">Input Required</span>
                    <h2>继续任务</h2>
                  </div>
                </div>
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
            {inlineError === null ? null : <span className="inline-warning">{inlineError}</span>}
          </div>
          <aside className="task-detail-side-column">
            <TaskDetailMetaPanel detail={loadedDetail} />
            {actionItem === null ? null : <TaskActionControls item={actionItem} taskActions={taskActions} />}
          </aside>
        </div>
      </div>
    </section>
  );
}

function TaskDetailSummaryPanel({ detail }: { detail: LoadedTaskDetail }): React.JSX.Element {
  const task = detail.backgroundTask;
  const goal = task === null ? detail.thread.goal : task.goal;
  const runCount = task === null ? detail.runHistory.length : task.runCount;
  const lastRunAt = task === null ? detail.runHistory[0]?.startedAt : task.lastRunAt;
  const nextRunAt = task === null ? null : task.nextRunAt;

  return (
    <section className="task-detail-panel task-detail-summary-panel" data-testid="task-detail-summary-panel">
      <div className="task-detail-panel-head">
        <div>
          <span className="task-detail-kicker">Task Console</span>
          <h2>任务概览</h2>
        </div>
        <span className="task-detail-thread-id">{detail.threadId}</span>
      </div>
      <p className="task-detail-goal">{goal}</p>
      <div className="task-detail-metric-grid">
        <div className="task-detail-metric">
          <span>当前状态</span>
          <strong>{detail.thread.status}</strong>
        </div>
        <div className="task-detail-metric">
          <span>运行次数</span>
          <strong>运行 {runCount} 次</strong>
        </div>
        <div className="task-detail-metric">
          <span>最近运行</span>
          <strong>{formatTaskDate(lastRunAt)}</strong>
        </div>
        <div className="task-detail-metric">
          <span>下次运行</span>
          <strong>{formatTaskDate(nextRunAt)}</strong>
        </div>
      </div>
    </section>
  );
}

function TaskDetailMetaPanel({ detail }: { detail: LoadedTaskDetail }): React.JSX.Element {
  const task = detail.backgroundTask;

  return (
    <section className="task-detail-panel task-detail-meta-panel" data-testid="task-detail-meta-panel">
      <div className="task-detail-panel-head">
        <div>
          <span className="task-detail-kicker">Configuration</span>
          <h2>任务参数</h2>
        </div>
      </div>
      <dl className="task-detail-meta-list">
        <TaskDetailMetaRow label="工作区" value={task === null ? '未记录' : task.workspacePath} />
        <TaskDetailMetaRow label="触发器" value={formatTaskTrigger(task)} />
        <TaskDetailMetaRow label="Cron" value={task === null || task.cronExpression === null ? '无' : task.cronExpression} />
        <TaskDetailMetaRow label="下次运行" value={task === null ? '未记录' : formatTaskDate(task.nextRunAt)} />
        <TaskDetailMetaRow label="最近运行状态" value={task === null || task.lastRunStatus === null ? '未记录' : task.lastRunStatus} />
        <TaskDetailMetaRow label="失败策略" value={task === null ? '未记录' : formatFailurePolicy(task.failurePolicy)} />
        <TaskDetailMetaRow label="通知策略" value={task === null ? '未记录' : formatNotificationPolicy(task.notificationPolicy)} />
        <TaskDetailMetaRow label="确认要求" value={task === null ? '未记录' : formatConfirmation(task.requiresConfirmation)} />
      </dl>
    </section>
  );
}

function TaskDetailMetaRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="task-detail-meta-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
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
      <span className="task-detail-kicker task-detail-actions-label">Task Actions</span>
      {terminal ? null : paused ? (
        <button className="action-button task-action-button" data-testid="task-detail-action-resume" type="button" onClick={() => taskActions.resumeTask(item)}>
          <Play aria-hidden="true" size={15} />
          <span>恢复</span>
        </button>
      ) : (
        <button className="action-button task-action-button" data-testid="task-detail-action-pause" type="button" onClick={() => taskActions.pauseTask(item)}>
          <Pause aria-hidden="true" size={15} />
          <span>暂停</span>
        </button>
      )}
      {terminal ? null : (
        <>
          <button className="action-button task-action-button" data-testid="task-detail-action-run-now" type="button" onClick={() => taskActions.runNow(item)}>
            <RotateCw aria-hidden="true" size={15} />
            <span>立即运行</span>
          </button>
          <button className="action-button task-action-button task-action-button--warn" data-testid="task-detail-action-cancel" type="button" onClick={() => taskActions.cancelTask(item)}>
            <XCircle aria-hidden="true" size={15} />
            <span>取消任务</span>
          </button>
        </>
      )}
      <button className="action-button task-action-button task-action-button--danger" data-testid="task-detail-action-delete" type="button" onClick={() => taskActions.deleteTask(item)}>
        <Trash2 aria-hidden="true" size={15} />
        <span>删除</span>
      </button>
    </div>
  );
}

function createTaskActionItem(detail: LoadedTaskDetail): ActiveTaskItem {
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

function formatTaskDate(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    return '未记录';
  }
  return value.slice(0, 16).replace('T', ' ');
}

function formatTaskTrigger(task: BackgroundTask | null): string {
  if (task === null) {
    return '未记录';
  }
  if (task.triggerType === 'manual') {
    return task.triggerDescription;
  }
  return `${task.triggerDescription} · ${task.triggerType}`;
}

function formatFailurePolicy(policy: BackgroundTask['failurePolicy']): string {
  if (policy === 'pause_and_report') {
    return '暂停并报告';
  }
  return policy;
}

function formatNotificationPolicy(policy: BackgroundTask['notificationPolicy']): string {
  if (policy === 'failures_and_confirmations') {
    return '失败和确认时通知';
  }
  return policy;
}

function formatConfirmation(requiresConfirmation: boolean): string {
  if (requiresConfirmation) {
    return '需要确认';
  }
  return '无需确认';
}
