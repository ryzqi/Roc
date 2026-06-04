import type { WorkflowHint } from '../../../shared/types';
import type { RocClient } from '../../shared/roc-client';
import type { TaskActions } from '../../views/tasks/use-task-actions';
import { createTaskActions, useTaskActions } from '../../views/tasks/use-task-actions';
import type { LoadedState } from '../../loaded-state';

export function createTaskFeatureActions(input: {
  client: RocClient;
  refreshTaskSurface: (selectedTaskId?: string | null) => Promise<void>;
  navigateToChat: (threadId: string, workflowHint?: WorkflowHint) => void;
}): TaskActions {
  return createTaskActions(input);
}

export function useTaskFeature(input: {
  client: RocClient;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
  navigateToChat?: (threadId: string, workflowHint?: WorkflowHint) => void;
  selectedTaskId?: string | null;
}): TaskActions {
  return useTaskActions(input.client, input.updateLoadedState, {
    navigateToChat: input.navigateToChat,
    selectedTaskId: input.selectedTaskId
  });
}
