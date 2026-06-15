import { useEffect, useMemo, useState } from 'react';
import type { ActiveTaskItem, WorkflowHint } from '../../../shared/types';
import type { ChatRunState } from '../../chat-run-state';
import { EmptyState } from '../../components/EmptyState';
import { PageHeading } from '../../components/PageHeading';
import { buildTopMeta } from '../../app/view-routing';
import type { LoadedState } from '../../loaded-state';
import type { RocClient } from '../../shared/roc-client';
import { TaskCreateDialog } from './TaskCreateDialog';
import { TaskDetailDrawer } from './TaskDetailDrawer';
import { TaskRow } from './TaskRow';
import { buildTaskViewModel, filterTaskItems } from './task-view-model';
import type { TaskRailId } from './task-view-model';
import { useTaskActions } from './use-task-actions';

export type TaskPromptSubmission = {
  input: string;
  workflowHint: WorkflowHint;
  taskSource: 'workbench';
  workspacePath: string;
};

export function TasksView({
  client,
  state,
  updateLoadedState,
  liveTaskRun,
  onNavigateToThread,
  onSelectedTaskIdChange,
  onSubmitTaskPrompt
}: {
  client?: RocClient;
  state: LoadedState;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
  liveTaskRun: ChatRunState | null;
  onNavigateToThread: (threadId: string, workflowHint?: WorkflowHint) => void;
  onSelectedTaskIdChange: (taskId: string | null | undefined) => void;
  onSubmitTaskPrompt: (payload: TaskPromptSubmission) => Promise<{ ok: true } | { ok: false; error: string }>;
}): React.JSX.Element {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(state.activeTasks[0]?.taskId ?? state.activeTasks[0]?.threadId ?? null);
  const [selectedRailId, setSelectedRailId] = useState<TaskRailId>('all');
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const model = useMemo(() => buildTaskViewModel(state), [state]);
  const visibleItems = useMemo(() => filterTaskItems(model.allItems, selectedRailId), [model.allItems, selectedRailId]);
  const selectedRail = model.railItems.find((item) => item.id === selectedRailId) ?? model.railItems[0];
  const taskTableTitle = selectedRailId === 'all' ? '全部任务' : `${selectedRail?.title ?? '全部'}任务`;
  const actions = useTaskActions(client, updateLoadedState, {
    navigateToChat: onNavigateToThread,
    selectedTaskId: selectedTaskId === null || selectedTaskId.startsWith('thread_') ? null : selectedTaskId
  });
  const selectedItem = visibleItems.find((item) => (item.taskId ?? item.threadId) === selectedTaskId) ?? visibleItems[0] ?? null;
  const selectedBackgroundTaskId = selectedItem?.taskId ?? null;
  const selectedScheduledRuns =
    selectedBackgroundTaskId === null
      ? []
      : state.scheduledRuns.filter((run) => run.backgroundTaskId === selectedBackgroundTaskId);

  useEffect(() => {
    if (selectedItem !== null && (selectedItem.taskId ?? selectedItem.threadId) === selectedTaskId) {
      return;
    }
    const fallbackId = visibleItems[0]?.taskId ?? visibleItems[0]?.threadId ?? null;
    setSelectedTaskId(fallbackId);
  }, [selectedItem, selectedTaskId, visibleItems]);

  useEffect(() => {
    onSelectedTaskIdChange(selectedBackgroundTaskId);
  }, [onSelectedTaskIdChange, selectedBackgroundTaskId]);

  function selectTask(item: ActiveTaskItem): void {
    setSelectedTaskId(item.taskId ?? item.threadId);
  }

  async function submitTaskDescription(description: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const workspacePath = getCurrentWorkspacePath(state);
    if (workspacePath === null || workspacePath.trim().length === 0) {
      return { ok: false, error: '当前没有可用于任务的工作区路径。' };
    }

    return await onSubmitTaskPrompt({
      input: description,
      workflowHint: 'propose_background_task',
      taskSource: 'workbench',
      workspacePath
    });
  }

  return (
    <>
      <PageHeading
        title="任务"
        meta={buildTopMeta('tasks', state)}
        flags={
          <button className="action-button" type="button" onClick={() => setCreateDialogOpen(true)}>
            新建任务
          </button>
        }
      />
      <section className="canvas-stage stage-grid task-command-center" data-testid="tasks-view">
        {model.allItems.length === 0 ? (
          <div className="task-empty-shell">
            <EmptyState
              testId="tasks-empty-state"
              title="暂无任务"
              action={
                <button className="action-button" type="button" onClick={() => setCreateDialogOpen(true)}>
                  新建任务
                </button>
              }
            />
            <p className="muted">点击右上角“新建任务”开始创建后台任务。</p>
          </div>
        ) : (
          <div className="task-workbench-layout">
            <nav className="task-status-rail" data-testid="task-status-rail" aria-label="任务状态筛选">
              {model.railItems.map((item) => (
                <button
                  key={item.id}
                  className={selectedRailId === item.id ? 'task-rail-item task-rail-item--active' : 'task-rail-item'}
                  type="button"
                  aria-pressed={selectedRailId === item.id}
                  onClick={() => setSelectedRailId(item.id)}
                >
                  <span>{item.title}</span>
                  <strong>{item.count}</strong>
                </button>
              ))}
            </nav>
            <section className="task-table-panel" data-testid="task-table">
              <div className="task-table-head">
                <div>
                  <h2 className="section-title">{taskTableTitle}</h2>
                  <p>按最近更新排序 · 同一任务只出现一次</p>
                </div>
                <div className="task-table-status">
                  <span className="status-pill info">
                    <span>{visibleItems.length}</span>
                  </span>
                  <span className={`pill ${state.schedulerStatus.running ? 'ok' : 'warn'}`}>
                    调度器{state.schedulerStatus.running ? '运行中' : '未运行'}
                  </span>
                  <small>{formatSchedulerMeta(state.schedulerStatus.registeredTaskCount, state.schedulerStatus.nextFireAt)}</small>
                </div>
              </div>
              <div className="task-table-columns" aria-hidden="true">
                <span>任务</span>
                <span>当前状态</span>
                <span>下次运行</span>
                <span>最近运行</span>
              </div>
              <div className="task-table-rows">
                {visibleItems.length === 0 ? (
                  <div className="section-empty-state">
                    <strong>当前筛选没有任务</strong>
                    <p>切换左侧状态查看其他任务。</p>
                  </div>
                ) : (
                  visibleItems.map((item) => {
                    const itemId = item.taskId ?? item.threadId;
                    return <TaskRow key={itemId} item={item} selected={(selectedItem?.taskId ?? selectedItem?.threadId ?? null) === itemId} onSelect={selectTask} />;
                  })
                )}
              </div>
            </section>
              <TaskDetailDrawer
                item={selectedItem}
                detail={selectedBackgroundTaskId === state.taskDetail?.taskId ? state.taskDetail : null}
                liveRun={liveTaskRun?.threadId === selectedItem?.threadId ? liveTaskRun : null}
                scheduledRuns={selectedScheduledRuns}
                onCancel={actions.cancelTask}
                onDelete={actions.deleteTask}
                onOpenInChat={actions.openInChat}
                onPause={actions.pauseTask}
                onResume={actions.resumeTask}
                onRunNow={actions.runNow}
                onOpenChat={onNavigateToThread}
              />
          </div>
        )}
      </section>
      <TaskCreateDialog
        open={createDialogOpen}
        onClose={() => setCreateDialogOpen(false)}
        onSubmitDescription={submitTaskDescription}
      />
    </>
  );
}

function getCurrentWorkspacePath(state: LoadedState): string | null {
  if (state.workspace !== null) {
    return state.workspace.path;
  }
  if (state.appStatus.workspace.selectedPath !== null) {
    return state.appStatus.workspace.selectedPath;
  }
  return null;
}

function formatSchedulerMeta(registeredTaskCount: number, nextFireAt: string | null): string {
  if (nextFireAt === null) {
    return `注册 ${registeredTaskCount} · 无下次触发`;
  }
  return `注册 ${registeredTaskCount} · 下次 ${nextFireAt}`;
}
