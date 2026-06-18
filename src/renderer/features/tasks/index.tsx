import type { ChatRunState } from '../../chat-run-state';
import type { LoadedState } from '../../loaded-state';
import type { RocClient } from '../../shared/roc-client';
import { TaskDetailView, type TaskDetailApprovalRequest, type TaskDetailInputRequest } from '../../views/tasks/TaskDetailView';
import { TasksView, type TaskPromptSubmission } from '../../views/tasks/TasksView';
import { useTaskFeature } from './use-task-feature';

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
    <TasksView
      client={props.client}
      liveTaskRun={props.liveTaskRun}
      onOpenTaskDetail={props.onOpenTaskDetail}
      onSelectedTaskIdChange={props.onSelectedTaskIdChange}
      onSubmitTaskPrompt={props.onCreateTask}
      state={props.state}
      updateLoadedState={props.updateLoadedState}
      boardUiState={props.boardUiState}
      onBoardUiStateChange={props.onBoardUiStateChange}
    />
  );
}

export function TaskDetailFeature(props: {
  client: RocClient;
  liveTaskRun: ChatRunState | null;
  onApprovalDecision: (request: TaskDetailApprovalRequest) => Promise<{ ok: true } | { ok: false; error: string }>;
  onBackToBoard: () => void;
  onDeleteTaskStarted: () => void;
  onSubmitTaskInput: (payload: TaskDetailInputRequest) => Promise<{ ok: true } | { ok: false; error: string }>;
  state: LoadedState;
  taskId: string;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
}): React.JSX.Element {
  const taskActions = useTaskFeature({
    client: props.client,
    onTaskDeleted: props.onBackToBoard,
    onTaskDeleteStarted: props.onDeleteTaskStarted,
    selectedTaskId: props.taskId,
    updateLoadedState: props.updateLoadedState
  });
  return <TaskDetailView {...props} taskActions={taskActions} />;
}
