import type { ActiveTaskItem, TaskSnapshot } from '../../../shared/types';
import type { LoadedState } from '../../loaded-state';
import { unwrap } from '../../loaded-state';
import { loadTaskSurfaceData } from '../../app/data-loading';

export type TaskActions = {
  cancelTask: (item: ActiveTaskItem) => void;
  deleteTask: (item: ActiveTaskItem) => void;
  openInChat: (item: ActiveTaskItem) => void;
  pauseTask: (item: ActiveTaskItem) => void;
  resumeTask: (item: ActiveTaskItem) => void;
  runNow: (item: ActiveTaskItem) => void;
};

export function createTaskActions(input: {
  refreshTaskSurface: (selectedTaskId?: string | null) => Promise<void>;
  navigateToChat: (threadId: string) => void;
}): TaskActions {
  function requireTaskId(item: ActiveTaskItem): string | null {
    return item.taskId;
  }

  return {
    cancelTask: (item) => {
      const taskId = requireTaskId(item);
      if (taskId === null) {
        return;
      }
      void window.roc.tasks.cancelBackgroundTask(taskId).then(async () => input.refreshTaskSurface(taskId));
    },
    deleteTask: (item) => {
      const taskId = requireTaskId(item);
      if (taskId === null) {
        return;
      }
      void window.roc.tasks.deleteBackgroundTask(taskId).then(async () => input.refreshTaskSurface(null));
    },
    openInChat: (item) => {
      const taskId = requireTaskId(item);
      if (taskId === null) {
        input.navigateToChat(item.threadId);
        return;
      }
      void window.roc.tasks.openInChat({ taskId }).then((result) => {
        if (!result.ok) {
          return;
        }
        input.navigateToChat(result.data.threadId);
      });
    },
    pauseTask: (item) => {
      const taskId = requireTaskId(item);
      if (taskId === null) {
        return;
      }
      void window.roc.tasks.pauseBackgroundTask(taskId).then(async () => input.refreshTaskSurface(taskId));
    },
    resumeTask: (item) => {
      const taskId = requireTaskId(item);
      if (taskId === null) {
        return;
      }
      void window.roc.tasks.resumeBackgroundTask(taskId).then(async () => input.refreshTaskSurface(taskId));
    },
    runNow: (item) => {
      const taskId = requireTaskId(item);
      if (taskId === null) {
        return;
      }
      void window.roc.tasks.runBackgroundNow(taskId).then(() => input.refreshTaskSurface(taskId));
    }
  };
}

export function useTaskActions(
  updateLoadedState: (partial: Partial<LoadedState>) => void,
  input?: {
    navigateToChat?: (threadId: string) => void;
    selectedTaskId?: string | null;
  }
): TaskActions {
  return createTaskActions({
    refreshTaskSurface: async (selectedTaskId) => {
      const [taskSnapshot, taskSurfaceData] = await Promise.all([
        window.roc.tasks.getSnapshot(),
        loadTaskSurfaceData(selectedTaskId ?? input?.selectedTaskId)
      ]);
      updateLoadedState({
        taskSnapshot: unwrap<TaskSnapshot>('task snapshot', taskSnapshot),
        ...taskSurfaceData
      });
    },
    navigateToChat: (threadId) => {
      input?.navigateToChat?.(threadId);
    }
  });
}
