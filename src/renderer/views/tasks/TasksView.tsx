import { useMemo, useRef, useState } from 'react';
import type { WorkflowHint } from '../../../shared/types';
import type { ChatRunState } from '../../chat-run-state';
import { buildTopMeta } from '../../app/view-routing';
import { EmptyState } from '../../components/EmptyState';
import { PageHeading } from '../../components/PageHeading';
import type { LoadedState } from '../../loaded-state';
import type { RocClient } from '../../shared/roc-client';
import { TaskBoardColumn } from './TaskBoardColumn';
import { TaskCreateDialog } from './TaskCreateDialog';
import { restoreDialogFocus } from '../../dialog-focus';
import { buildTaskBoardLanes } from './task-view-model';

type TaskBoardUiState = {
  railId: 'all' | 'todo' | 'running' | 'paused' | 'done';
  scrollTop: number;
};

export type TaskPromptSubmission = {
  input: string;
  workflowHint: WorkflowHint;
  taskSource: 'workbench';
  workspacePath: string;
};

export function TasksView({
  state,
  onOpenTaskDetail,
  onSelectedTaskIdChange,
  onSubmitTaskPrompt,
  boardUiState,
  onBoardUiStateChange
}: {
  client?: RocClient;
  state: LoadedState;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
  liveTaskRun: ChatRunState | null;
  onOpenTaskDetail: (taskId: string, boardUiState: TaskBoardUiState) => void;
  onSelectedTaskIdChange: (taskId: string | null | undefined) => void;
  onSubmitTaskPrompt: (payload: TaskPromptSubmission) => Promise<{ ok: true } | { ok: false; error: string }>;
  boardUiState: TaskBoardUiState;
  onBoardUiStateChange: (state: TaskBoardUiState) => void;
}): React.JSX.Element {
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const createDialogOpenerRef = useRef<HTMLElement | null>(null);
  const lanes = useMemo(() => buildTaskBoardLanes(state.activeTasks), [state.activeTasks]);

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

  function openCreateDialog(opener: HTMLElement): void {
    createDialogOpenerRef.current = opener;
    setCreateDialogOpen(true);
  }

  function completeCreateDialogExit(): void {
    restoreDialogFocus(createDialogOpenerRef.current);
    createDialogOpenerRef.current = null;
  }

  return (
    <>
      <PageHeading
        title="任务工作台"
        meta={buildTopMeta('tasks-board', state)}
        flags={
          <button className="action-button" type="button" onClick={(event) => openCreateDialog(event.currentTarget)}>
            新建任务
          </button>
        }
      />
      <section className="canvas-stage stage-grid task-board-page" data-testid="tasks-board-view">
        {state.activeTasks.length === 0 ? (
          <div className="task-empty-shell">
            <EmptyState
              testId="tasks-empty-state"
              title="暂无任务"
              action={
                <button className="action-button" type="button" onClick={(event) => openCreateDialog(event.currentTarget)}>
                  新建任务
                </button>
              }
            />
            <p className="muted">点击右上角“新建任务”开始创建后台任务。</p>
          </div>
        ) : (
          <div className="task-board-grid">
            {lanes.map((lane) => (
              <TaskBoardColumn
                key={lane.id}
                items={lane.items}
                onOpenTask={(taskId) => {
                  onSelectedTaskIdChange(taskId);
                  onBoardUiStateChange(boardUiState);
                  onOpenTaskDetail(taskId, boardUiState);
                }}
                title={lane.title}
              />
            ))}
          </div>
        )}
      </section>
      <TaskCreateDialog
        open={createDialogOpen}
        onClose={() => setCreateDialogOpen(false)}
        onExitComplete={completeCreateDialogExit}
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
