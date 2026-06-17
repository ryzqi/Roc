import type { ChatRunState } from '../../chat-run-state';
import type { LoadedState } from '../../loaded-state';
import type { RocClient } from '../../shared/roc-client';
import { TaskDetailView } from '../../views/tasks/TaskDetailView';
import { TasksView, type TaskPromptSubmission } from '../../views/tasks/TasksView';

export type TaskBoardUiState = {
  railId: 'all' | 'todo' | 'running' | 'paused' | 'done';
  scrollTop: number;
};

export function TasksBoardFeature(props: {
  client: RocClient;
  liveTaskRun: ChatRunState | null;
  onCreateTask: (payload: TaskPromptSubmission) => Promise<{ ok: true } | { ok: false; error: string }>;
  onOpenTaskDetail: (taskId: string, boardUiState: TaskBoardUiState) => void;
  onSelectedTaskIdChange: (taskId: string | null | undefined) => void;
  state: LoadedState;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
  boardUiState: TaskBoardUiState;
  onBoardUiStateChange: (state: TaskBoardUiState) => void;
}): React.JSX.Element {
  return (
    <div data-testid="tasks-board-view">
      <TasksView
        client={props.client}
        liveTaskRun={props.liveTaskRun}
        onNavigateToThread={(threadId) => props.onOpenTaskDetail(threadId, props.boardUiState)}
        onSelectedTaskIdChange={props.onSelectedTaskIdChange}
        onSubmitTaskPrompt={props.onCreateTask}
        state={props.state}
        updateLoadedState={props.updateLoadedState}
      />
    </div>
  );
}

export function TaskDetailFeature(props: {
  client: RocClient;
  liveTaskRun: ChatRunState | null;
  onBackToBoard: () => void;
  onSubmitTaskInput: (payload: { input: string; taskId: string }) => Promise<{ ok: true } | { ok: false; error: string }>;
  state: LoadedState;
  taskId: string;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
}): React.JSX.Element {
  return <TaskDetailView {...props} />;
}
