import type {
  AgentCapabilityManifest,
  AgentCapabilityPreview,
  ActiveTaskItem,
  BackgroundTask,
  BackgroundTaskPreview,
  BackgroundTaskPreviewRequest,
  BackgroundTaskSummary,
  EnabledCapabilities,
  ProviderExecutionResult,
  ScheduledTaskRun,
  TaskDetail,
  TaskEvent,
  TaskRun,
  TaskSnapshot,
  UpdateBackgroundTaskRequest
} from '../../shared/types';
import type { DatabaseService } from './database-service';
import { requireBackgroundTask } from './task';
import * as backgroundTaskCreate from './task/background-task-create';
import * as backgroundTaskLifecycle from './task/background-task-lifecycle';
import * as taskRunManagement from './task/task-run-management';
import * as scheduledRunStore from './task/scheduled-run-store';
import * as taskEventRecorder from './task/task-event-recorder';
import * as snapshotBuilders from './task/snapshot-builders';

export class TaskService {
  constructor(private readonly database: DatabaseService) {}

  createBackgroundTaskPreview(request: BackgroundTaskPreviewRequest): BackgroundTaskPreview {
    return backgroundTaskCreate.createBackgroundTaskPreview({ request });
  }

  createBackgroundTask(preview: BackgroundTaskPreview): BackgroundTask {
    return backgroundTaskCreate.createBackgroundTask({ database: this.database, preview });
  }

  pauseBackgroundTask(id: string): BackgroundTask {
    return backgroundTaskLifecycle.pauseBackgroundTask({ database: this.database, id });
  }

  resumeBackgroundTask(id: string): BackgroundTask {
    return backgroundTaskLifecycle.resumeBackgroundTask({ database: this.database, id });
  }

  cancelBackgroundTask(id: string): BackgroundTask {
    return backgroundTaskLifecycle.cancelBackgroundTask({ database: this.database, id });
  }

  deleteBackgroundTask(id: string): { deleted: true; taskId: string } {
    return backgroundTaskLifecycle.deleteBackgroundTask({ database: this.database, id });
  }

  updateBackgroundTask(request: UpdateBackgroundTaskRequest): BackgroundTask {
    return backgroundTaskLifecycle.updateBackgroundTask({
      database: this.database,
      request,
      createPreview: (previewRequest) => this.createBackgroundTaskPreview(previewRequest)
    });
  }

  listBackgroundTasks(): BackgroundTask[] {
    return backgroundTaskLifecycle.listBackgroundTasks({ database: this.database });
  }

  findBackgroundTask(id: string): BackgroundTask | null {
    return backgroundTaskLifecycle.findBackgroundTask({ database: this.database, id });
  }

  getBackgroundTaskSummary(): BackgroundTaskSummary {
    return snapshotBuilders.getBackgroundTaskSummary({ database: this.database });
  }

  listSchedulableBackgroundTasks(): BackgroundTask[] {
    return backgroundTaskLifecycle.listSchedulableBackgroundTasks({ database: this.database });
  }

  getActiveTasks(): ActiveTaskItem[] {
    return snapshotBuilders.getActiveTasks({ database: this.database });
  }

  getTaskDetail(input: { taskId: string; schedulerRegistered: boolean }): TaskDetail {
    return snapshotBuilders.getTaskDetail({ database: this.database, ...input });
  }

  listScheduledRuns(input: { taskId: string; limit?: number }): ScheduledTaskRun[] {
    return scheduledRunStore.listScheduledRuns({ database: this.database, ...input });
  }

  openBackgroundTaskInChat(taskId: string): { threadId: string } {
    const task = requireBackgroundTask(this.database, taskId);
    this.recordEvent({
      threadId: task.threadId,
      runId: task.runId,
      type: 'message',
      payload: {
        role: 'system',
        content: `[系统] 用户准备修改后台任务 ${task.id}。`
      }
    });
    return {
      threadId: task.threadId
    };
  }

  recordScheduledTaskRun(input: {
    backgroundTaskId: string;
    scheduledAt: string;
    status: ScheduledTaskRun['status'];
    taskRunId?: string | null;
    triggeredAt?: string | null;
    skipReason?: string | null;
  }): ScheduledTaskRun {
    return scheduledRunStore.recordScheduledTaskRun({ database: this.database, ...input });
  }

  countRecentSkippedScheduledRuns(since: string): number {
    return scheduledRunStore.countRecentSkippedScheduledRuns({ database: this.database, since });
  }

  markBackgroundTaskFired(input: { taskId: string; runId: string; firedAt: string; nextRunAt: string | null }): BackgroundTask {
    return backgroundTaskLifecycle.markBackgroundTaskFired({ database: this.database, ...input });
  }

  updateBackgroundTaskNextRunAt(taskId: string, nextRunAt: string | null): BackgroundTask {
    return backgroundTaskLifecycle.updateBackgroundTaskNextRunAt({ database: this.database, taskId, nextRunAt });
  }

  pauseBackgroundTaskForScheduler(input: { taskId: string; runId: string; reason: string }): BackgroundTask {
    return backgroundTaskLifecycle.pauseBackgroundTaskForScheduler({ database: this.database, ...input });
  }

  createTaskRun(input: {
    userInput: string;
    modelId: string;
    enabledCapabilities: EnabledCapabilities;
    threadId?: string;
  }): TaskRun {
    return taskRunManagement.createTaskRun({ database: this.database, ...input });
  }

  archiveThread(threadId: string): { deleted: true; threadId: string } {
    return taskRunManagement.archiveThread({ database: this.database, threadId });
  }

  getRun(id: string): TaskRun {
    return taskRunManagement.getRun({ database: this.database, id });
  }

  listThreadMessages(threadId: string): TaskEvent[] {
    return taskRunManagement.listThreadMessages({ database: this.database, threadId });
  }

  recordEvent(input: { threadId: string; runId: string; type: TaskEvent['type']; payload: unknown }): TaskEvent {
    return taskEventRecorder.recordEvent({ database: this.database, ...input });
  }

  recordEvents(inputs: Array<{ threadId: string; runId: string; type: TaskEvent['type']; payload: unknown }>): TaskEvent[] {
    return taskEventRecorder.recordEvents({ database: this.database, inputs });
  }

  markRunRunning(runId: string): void {
    taskRunManagement.markRunRunning({ database: this.database, runId });
  }

  markRunWaitingUser(runId: string): void {
    taskRunManagement.markRunWaitingUser({ database: this.database, runId });
  }

  markRunResumed(runId: string): void {
    taskRunManagement.markRunResumed({ database: this.database, runId });
  }

  recordApprovalRequested(input: { runId: string; payload: unknown }): TaskEvent {
    return taskEventRecorder.recordApprovalRequested({ database: this.database, ...input });
  }

  recordApprovalDecision(input: { runId: string; payload: unknown }): TaskEvent {
    return taskEventRecorder.recordApprovalDecision({ database: this.database, ...input });
  }

  completeRunWithProviderResult(input: { runId: string; result: ProviderExecutionResult }): void {
    taskRunManagement.completeRunWithProviderResult({ database: this.database, ...input });
  }

  failRunWithProviderError(input: {
    runId: string;
    providerId: string;
    modelId: string;
    code: string;
    diagnostic?: {
      badKeys?: string[];
      schemaPath?: string;
      toolName?: string;
    };
    message: string;
    retryable: boolean;
    suggestion?: string;
  }): void {
    taskRunManagement.failRunWithProviderError({ database: this.database, ...input });
  }

  recordAgentCapabilityManifest(input: {
    threadId: string;
    runId: string;
    preview: AgentCapabilityPreview;
  }): AgentCapabilityManifest {
    return taskRunManagement.recordAgentCapabilityManifest({ database: this.database, ...input });
  }

  getSnapshot(): TaskSnapshot {
    return snapshotBuilders.getSnapshot({ database: this.database });
  }
}
