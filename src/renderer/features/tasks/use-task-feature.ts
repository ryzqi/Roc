import type { RocClient } from '../../shared/roc-client';
import type { TaskActions } from '../../views/tasks/use-task-actions';
import { createTaskActions, useTaskActions } from '../../views/tasks/use-task-actions';
import type { LoadedState } from '../../loaded-state';

export function createTaskFeatureActions(input: {
  client: RocClient;
  refreshTaskSurface: (selectedTaskId?: string | null) => Promise<void>;
}): TaskActions {
  return createTaskActions(input);
}

export function useTaskFeature(input: {
  client: RocClient;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
  selectedTaskId?: string | null;
}): TaskActions {
  return useTaskActions(input.client, input.updateLoadedState, {
    selectedTaskId: input.selectedTaskId
  });
}
