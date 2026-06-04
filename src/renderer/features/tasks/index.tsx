import type { RocClient } from '../../shared/roc-client';
import { TasksView, type TaskPromptSubmission } from '../../views/tasks/TasksView';
import type { LoadedState } from '../../loaded-state';
import type { ChatRunState } from '../../chat-run-state';
import type { WorkflowHint } from '../../../shared/types';

export function TasksFeature({
  client,
  liveTaskRun,
  onNavigateToThread,
  onSelectedTaskIdChange,
  onSubmitTaskPrompt,
  state,
  updateLoadedState
}: {
  client: RocClient;
  liveTaskRun: ChatRunState | null;
  onNavigateToThread: (threadId: string, workflowHint?: WorkflowHint) => void;
  onSelectedTaskIdChange: (taskId: string | null | undefined) => void;
  onSubmitTaskPrompt: (payload: TaskPromptSubmission) => Promise<{ ok: true } | { ok: false; error: string }>;
  state: LoadedState;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
}): React.JSX.Element {
  return (
    <TasksView
      client={client}
      liveTaskRun={liveTaskRun}
      onNavigateToThread={onNavigateToThread}
      onSelectedTaskIdChange={onSelectedTaskIdChange}
      onSubmitTaskPrompt={onSubmitTaskPrompt}
      state={state}
      updateLoadedState={updateLoadedState}
    />
  );
}
