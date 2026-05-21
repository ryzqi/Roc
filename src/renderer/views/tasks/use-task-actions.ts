import type { ActiveTaskItem, TaskSnapshot } from '../../../shared/types';
import type { LoadedState } from '../../loaded-state';
import { unwrap } from '../../loaded-state';
import { loadTaskSurfaceData } from '../../app/data-loading';

export function useTaskActions(updateLoadedState: (partial: Partial<LoadedState>) => void): {
  cancelTask: (item: ActiveTaskItem) => void;
  openInChat: (item: ActiveTaskItem) => void;
  pauseTask: (item: ActiveTaskItem) => void;
  resumeTask: (item: ActiveTaskItem) => void;
  runNow: (item: ActiveTaskItem) => void;
} {
  async function refreshTaskSurface(extra: Partial<LoadedState> = {}): Promise<void> {
    const [taskSnapshot, taskSurfaceData] = await Promise.all([window.roc.tasks.getSnapshot(), loadTaskSurfaceData()]);
    updateLoadedState({
      taskSnapshot: unwrap<TaskSnapshot>('task snapshot', taskSnapshot),
      ...taskSurfaceData,
      ...extra
    });
  }

  function requireTaskId(item: ActiveTaskItem): string | null {
    return item.taskId;
  }

  return {
    cancelTask: (item) => {
      const taskId = requireTaskId(item);
      if (taskId === null) {
        return;
      }
      void window.roc.tasks.cancelBackgroundTask(taskId).then(async () => refreshTaskSurface());
    },
    openInChat: (item) => {
      const taskId = requireTaskId(item);
      if (taskId === null) {
        return;
      }
      void window.roc.tasks.openInChat({ taskId });
    },
    pauseTask: (item) => {
      const taskId = requireTaskId(item);
      if (taskId === null) {
        return;
      }
      void window.roc.tasks.pauseBackgroundTask(taskId).then(async () => refreshTaskSurface());
    },
    resumeTask: (item) => {
      const taskId = requireTaskId(item);
      if (taskId === null) {
        return;
      }
      void window.roc.tasks.resumeBackgroundTask(taskId).then(async () => refreshTaskSurface());
    },
    runNow: (item) => {
      const taskId = requireTaskId(item);
      if (taskId === null) {
        return;
      }
      void window.roc.tasks.runBackgroundNow(taskId).then(() => refreshTaskSurface());
    }
  };
}
