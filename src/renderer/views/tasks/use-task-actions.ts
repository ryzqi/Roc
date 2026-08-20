import type { ActiveTaskItem, TaskSnapshot } from '../../../shared/types';
import type { LoadedState } from '../../loaded-state';
import { unwrap } from '../../loaded-state';
import { loadTaskSurfaceData } from '../../app/data-loading';
import type { RocClient } from '../../shared/roc-client';
import { createRocClient } from '../../shared/roc-client';

export type TaskActions = {
  cancelTask: (item: ActiveTaskItem) => void;
  deleteTask: (item: ActiveTaskItem) => void;
  pauseTask: (item: ActiveTaskItem) => void;
  resumeTask: (item: ActiveTaskItem) => void;
  runNow: (item: ActiveTaskItem) => void;
};

export function createTaskActions(input: {
  client?: RocClient;
  onTaskDeleted?: (item: ActiveTaskItem) => void;
  onTaskDeleteStarted?: (item: ActiveTaskItem) => void;
  refreshTaskSurface: (selectedTaskId?: string | null) => Promise<void>;
}): TaskActions {
  function resolveClient(): RocClient {
    return input.client ?? createRocClient();
  }

  function executeAndRefresh(
    item: ActiveTaskItem,
    operation: (client: RocClient, taskId: string) => Promise<unknown>
  ): void {
    const client = resolveClient();
    void operation(client, item.taskId).then(async () => input.refreshTaskSurface(item.taskId));
  }

  return {
    cancelTask: (item) => {
      executeAndRefresh(item, async (client, taskId) => await client.api.tasks.cancelBackgroundTask(taskId));
    },
    deleteTask: (item) => {
      const client = resolveClient();
      input.onTaskDeleteStarted?.(item);
      void client.api.tasks.deleteBackgroundTask(item.taskId).then(async (result) => {
        if (!result.ok) {
          return;
        }
        await input.refreshTaskSurface(null);
        input.onTaskDeleted?.(item);
      });
    },
    pauseTask: (item) => {
      executeAndRefresh(item, async (client, taskId) => await client.api.tasks.pauseBackgroundTask(taskId));
    },
    resumeTask: (item) => {
      executeAndRefresh(item, async (client, taskId) => await client.api.tasks.resumeBackgroundTask(taskId));
    },
    runNow: (item) => {
      const client = resolveClient();
      void client.api.tasks.runBackgroundNow(item.taskId).then(async (result) => {
        if (!result.ok) {
          return;
        }
        await input.refreshTaskSurface(item.taskId);
      });
    }
  };
}

export function useTaskActions(
  client: RocClient | undefined,
  updateLoadedState: (partial: Partial<LoadedState>) => void,
  input?: {
    onTaskDeleted?: (item: ActiveTaskItem) => void;
    onTaskDeleteStarted?: (item: ActiveTaskItem) => void;
    selectedTaskId?: string | null;
  }
): TaskActions {
  return createTaskActions({
    client,
    refreshTaskSurface: async (selectedTaskId) => {
      const taskClient = client ?? createRocClient();
      const [taskSnapshot, taskSurfaceData] = await Promise.all([
        taskClient.api.tasks.getSnapshot(),
        loadTaskSurfaceData(selectedTaskId === undefined ? input?.selectedTaskId : selectedTaskId, taskClient)
      ]);
      updateLoadedState({
        taskSnapshot: unwrap<TaskSnapshot>('task snapshot', taskSnapshot),
        ...taskSurfaceData
      });
    },
    onTaskDeleted: input?.onTaskDeleted,
    onTaskDeleteStarted: input?.onTaskDeleteStarted
  });
}
