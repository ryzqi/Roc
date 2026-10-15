import type {
  ActiveTaskItem,
  BackgroundTask,
  BackgroundTaskPreview,
  BackgroundTaskPreviewRequest,
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
