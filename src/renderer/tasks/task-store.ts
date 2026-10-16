import type {
  ActiveTaskItem,
  BackgroundTask,
  BackgroundTaskPreview,
  BackgroundTaskPreviewRequest,
  ScheduledTaskRun,
  SchedulerStatus,
  TaskDetail,
  TaskMessageHistoryPage,
  TaskMessageHistoryRequest,
  TaskSnapshot
} from '../../shared/types';
import type { IpcLikeResult } from '../app/loaded-state';
import type { RocClient } from '../shared/roc-client';

/**
 * Task data layer (P6/T6.6, T6.7).
 *
 * Two argument shapes coexist in this domain and are easy to mix up (F18), so the wrappers
 * exist precisely to hide the difference:
 *
 *   - `task.snapshot.get` / `task.active.list` / `task.scheduler.status` take **no
 *     arguments**;
 *   - `task.detail.get` takes `{ taskId }`;
 *   - `task.background.pause` / `resume` / `cancel` / `runNow` / `delete` take a **bare id
 *     string** (`inputTransform: id('id')`), not an object.
 *
 * `task.background.update` additionally requires a `reason` (the backend records it as the
 * change's provenance), so an update without one is refused rather than silently sent.
 */

export function getSnapshot(client: RocClient): Promise<IpcLikeResult<TaskSnapshot>> {
  return client.api.tasks.getSnapshot();
}

export function getActiveTasks(client: RocClient): Promise<IpcLikeResult<ActiveTaskItem[]>> {
  return client.api.tasks.getActiveTasks();
}

export function getSchedulerStatus(client: RocClient): Promise<IpcLikeResult<SchedulerStatus>> {
  return client.api.tasks.getSchedulerStatus();
}

export function getTaskDetail(client: RocClient, taskId: string): Promise<IpcLikeResult<TaskDetail>> {
  return client.api.tasks.getTaskDetail({ taskId });
}

export function getThreadMessages(
  client: RocClient,
  input: TaskMessageHistoryRequest
): Promise<IpcLikeResult<TaskMessageHistoryPage>> {
  return client.api.tasks.getThreadMessages(input);
}

export function listBackgroundTasks(client: RocClient): Promise<IpcLikeResult<BackgroundTask[]>> {
  return client.api.tasks.listBackgroundTasks();
}

export function pauseBackgroundTask(client: RocClient, taskId: string): Promise<IpcLikeResult<BackgroundTask>> {
  return client.api.tasks.pauseBackgroundTask(taskId);
}

export function resumeBackgroundTask(client: RocClient, taskId: string): Promise<IpcLikeResult<BackgroundTask>> {
  return client.api.tasks.resumeBackgroundTask(taskId);
}

export function cancelBackgroundTask(client: RocClient, taskId: string): Promise<IpcLikeResult<BackgroundTask>> {
  return client.api.tasks.cancelBackgroundTask(taskId);
}

export function runBackgroundNow(client: RocClient, taskId: string): Promise<IpcLikeResult<{ taskId: string; runId: string }>> {
  return client.api.tasks.runBackgroundNow(taskId);
}

export function deleteBackgroundTask(
  client: RocClient,
  taskId: string
): Promise<IpcLikeResult<{ deleted: true; taskId: string }>> {
  return client.api.tasks.deleteBackgroundTask(taskId);
}

export function updateBackgroundTask(
  client: RocClient,
  input: { taskId: string; patch: Partial<BackgroundTaskPreviewRequest>; reason: string }
): Promise<IpcLikeResult<BackgroundTask>> {
  return client.api.tasks.updateBackgroundTask(input);
}

/** Same shape as create/update, used by the board's "立即运行" preview step if ever needed. */
export function previewBackgroundTask(
  client: RocClient,
  input: BackgroundTaskPreviewRequest
): Promise<IpcLikeResult<BackgroundTaskPreview>> {
  return client.api.tasks.createBackgroundTaskPreview(input);
}

/**
 * Creates the task **after** a preview (P9/T9.4).
 *
 * The preview is not optional in spirit: it is what returns `riskLevel`,
 * `requiresConfirmation`, `scheduled`, `cronExpression` and `nextRunAt`, i.e. the facts the
 * user must confirm. The management drawer always previews first and passes the same request
 * to this call, so the created task is exactly the one that was previewed.
 */
export function createBackgroundTask(
  client: RocClient,
  input: BackgroundTaskPreviewRequest
): Promise<IpcLikeResult<BackgroundTask>> {
  return client.api.tasks.createBackgroundTask(input);
}

/** The real scheduling history for one task (`tasks.listScheduledRuns`, in the order returned). */
export function listScheduledRuns(
  client: RocClient,
  input: { taskId: string; limit?: number }
): Promise<IpcLikeResult<ScheduledTaskRun[]>> {
  return client.api.tasks.listScheduledRuns(input);
}

export type TaskListAction = 'pause' | 'resume' | 'cancel' | 'runNow' | 'delete';

/**
 * One list action → one capability.
 *
 * A `switch` rather than a chain of ternaries: the five capabilities take a **bare id string**
 * (F18) but return different payloads, so the branch is about which call to make, not about a
 * shared shape — and a table is what makes a sixth action a one-line addition.
 *
 * It lives here, next to the wrappers, because two surfaces run these actions (the P6 board and
 * the P9 management drawer's task tab); a second copy would be the drift this store exists to
 * prevent.
 */
export async function dispatchTaskAction(
  client: RocClient,
  action: TaskListAction,
  taskId: string
): Promise<IpcLikeResult<BackgroundTask> | IpcLikeResult<{ taskId: string; runId: string }> | IpcLikeResult<{ deleted: true; taskId: string }>> {
  switch (action) {
    case 'pause':
      return pauseBackgroundTask(client, taskId);
    case 'resume':
      return resumeBackgroundTask(client, taskId);
    case 'cancel':
      return cancelBackgroundTask(client, taskId);
    case 'runNow':
      return runBackgroundNow(client, taskId);
    case 'delete':
      return deleteBackgroundTask(client, taskId);
    default:
      // Exhaustive over `TaskListAction`; the default keeps a future sixth action from
      // silently doing nothing.
      throw new Error(`unknown_task_action:${String(action)}`);
  }
}
