import { ipcChannels } from '../../shared/ipc';
import type { TaskService } from '../services/task-service';
import type { TaskSchedulerService } from '../services/task-scheduler-service';
import { RocDomainError, wrapIpc } from '../services/errors';
import type { TimedHandle } from './ipc-common';
import type { AppWindowControls } from './register-ipc';

export function registerTasksIpc(
  timedHandle: TimedHandle,
  taskService: TaskService,
  taskSchedulerService: TaskSchedulerService,
  controls: Pick<AppWindowControls, 'broadcastTaskUpdated'>
): void {
  timedHandle(ipcChannels.tasksGetSnapshot, () => wrapIpc(() => taskService.getSnapshot()));
  timedHandle(ipcChannels.tasksGetThreadMessages, (_event, request) =>
    wrapIpc(() => taskService.listThreadMessages(request.threadId))
  );
  timedHandle(ipcChannels.tasksListBackgroundTasks, () => wrapIpc(() => taskService.listBackgroundTasks()));
  timedHandle(ipcChannels.tasksDeleteThread, (_event, request) =>
    wrapIpc(() => {
      const result = taskService.archiveThread(request.threadId);
      controls.broadcastTaskUpdated();
      return result;
    })
  );
  timedHandle(ipcChannels.tasksCreateBackgroundPreview, (_event, request) =>
    wrapIpc(() => taskService.createBackgroundTaskPreview(request))
  );
  timedHandle(ipcChannels.tasksCreateBackgroundTask, (_event, preview) =>
    wrapIpc(() => {
      const task = taskService.createBackgroundTask(preview);
      taskSchedulerService.registerTask(task);
      controls.broadcastTaskUpdated();
      return task;
    })
  );
  timedHandle(ipcChannels.tasksPauseBackgroundTask, (_event, id: string) =>
    wrapIpc(() => {
      const task = taskService.pauseBackgroundTask(id);
      taskSchedulerService.unregisterTask(task.id);
      controls.broadcastTaskUpdated();
      return task;
    })
  );
  timedHandle(ipcChannels.tasksResumeBackgroundTask, (_event, id: string) =>
    wrapIpc(() => {
      const task = taskService.resumeBackgroundTask(id);
      taskSchedulerService.registerTask(task);
      controls.broadcastTaskUpdated();
      return task;
    })
  );
  timedHandle(ipcChannels.tasksCancelBackgroundTask, (_event, id: string) =>
    wrapIpc(() => {
      const task = taskService.cancelBackgroundTask(id);
      controls.broadcastTaskUpdated({ kind: 'task_status_changed', taskId: task.id, status: task.status });
      return task;
    })
  );
  timedHandle(ipcChannels.tasksGetActiveTasks, () => wrapIpc(() => taskService.getActiveTasks()));
  timedHandle(ipcChannels.tasksGetTaskDetail, (_event, request) =>
    wrapIpc(() =>
      taskService.getTaskDetail({
        taskId: request.taskId,
        schedulerRegistered: taskSchedulerService.getStatus().registeredTaskCount > 0
      })
    )
  );
  timedHandle(ipcChannels.tasksListScheduledRuns, (_event, request) =>
    wrapIpc(() => taskService.listScheduledRuns(request))
  );
  timedHandle(ipcChannels.tasksRunBackgroundNow, async (_event, id: string) =>
    wrapIpc(async () => {
      const runId = await taskSchedulerService.fire(id);
      if (runId === null) {
        throw new RocDomainError({
          code: 'background_task_run_not_started',
          message: '后台任务没有启动新的运行。',
          category: 'conflict',
          retryable: true,
          userAction: '请刷新任务工作台，确认任务仍处于可运行状态后重试。'
        });
      }
      controls.broadcastTaskUpdated({ kind: 'task_run_fired', taskId: id, runId });
      return { taskId: id, runId };
    })
  );
  timedHandle(ipcChannels.tasksDeleteBackgroundTask, (_event, id: string) =>
    wrapIpc(() => {
      const result = taskService.deleteBackgroundTask(id);
      taskSchedulerService.unregisterTask(id);
      controls.broadcastTaskUpdated();
      return result;
    })
  );
  timedHandle(ipcChannels.tasksUpdateBackgroundTask, (_event, request) =>
    wrapIpc(() => {
      const task = taskService.updateBackgroundTask(request);
      taskSchedulerService.refreshTask(task);
      controls.broadcastTaskUpdated({ kind: 'task_status_changed', taskId: task.id, status: task.status });
      return task;
    })
  );
  timedHandle(ipcChannels.tasksOpenInChat, (_event, request) =>
    wrapIpc(() => taskService.openBackgroundTaskInChat(request.taskId))
  );
  timedHandle(ipcChannels.tasksGetSchedulerStatus, () => wrapIpc(() => taskSchedulerService.getStatus()));
}
