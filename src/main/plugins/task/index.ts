import { z } from 'zod';

import type {
  ActiveTaskItem,
  BackgroundTask,
  BackgroundTaskSummary,
  ChatStartRunRequest,
  ChatStartRunResult,
  SchedulerStatus,
  ScheduledTaskRun,
  TaskDeleteThreadRequest,
  TaskDeleteThreadResult,
  TaskDetail,
  TaskMessageHistoryRequest,
  TaskSnapshot,
  TaskUpdateEvent,
} from '../../../shared/types';
import type { CapabilityDescriptor, EventSubscription, RocPlugin, RocPluginContext } from '../../kernel/types';
import {
  readAgentRunStartedPayload,
  readAgentTaskEventPayload,
  resolveAgentRunThreadKind
} from './agent-run-payloads';
import { AgentTaskHistoryReader } from './agent-task-history';
import {
  backgroundTaskPreviewRequestSchema,
  backgroundTaskPreviewSchema,
  backgroundTaskSchema,
  taskMessageHistoryPageSchema,
  taskMessageHistoryRequestSchema,
  updateBackgroundTaskRequestSchema
} from './contracts';
import { TaskScheduler } from './scheduler';
import { applyTaskPluginSchema } from './schema';
import { TaskRepository } from './task-repository';
import { ThreadDeletionJournal } from './thread-deletion-journal';

const pluginId = '@roc/plugin-task';
const capabilityVersion = '1.0.0';
const agentOutboxProjectorName = 'task_background_status';
const agentOutboxProjectionBatchSize = 100;

const idInputSchema = z.object({
  id: z.string()
});

const taskRunNowResultSchema = z.object({
  taskId: z.string(),
  runId: z.string()
});

const taskCapabilityDescriptors = [
  descriptor('task.snapshot.get', z.object({}), z.custom<TaskSnapshot>()),
  descriptor('task.background.preview', backgroundTaskPreviewRequestSchema, backgroundTaskPreviewSchema),
  descriptor('task.background.create', backgroundTaskPreviewRequestSchema, backgroundTaskSchema),
  descriptor('task.background.update', updateBackgroundTaskRequestSchema, backgroundTaskSchema),
  descriptor('task.background.runNow', idInputSchema, taskRunNowResultSchema),
  descriptor('task.background.pause', idInputSchema, z.custom<BackgroundTask>()),
  descriptor('task.background.resume', idInputSchema, z.custom<BackgroundTask>()),
  descriptor('task.background.cancel', idInputSchema, z.custom<BackgroundTask>()),
  descriptor('task.background.delete', idInputSchema, z.object({ deleted: z.literal(true), taskId: z.string() })),
  descriptor('task.scheduler.status', z.object({}), z.custom<SchedulerStatus>()),
  descriptor('task.scheduler.suspend', z.object({}), z.object({ suspended: z.literal(true) })),
  descriptor('task.scheduler.resume', z.object({}), z.object({ resumed: z.literal(true) })),
  descriptor('task.scheduler.handlePowerResume', z.object({}), z.object({ handled: z.literal(true) })),
  descriptor('task.background.summary', z.object({}), z.custom<BackgroundTaskSummary>()),
  descriptor('task.thread.messages.list', taskMessageHistoryRequestSchema, taskMessageHistoryPageSchema),
  descriptor('task.background.list', z.object({}), z.array(z.custom<BackgroundTask>())),
  descriptor('task.thread.delete', z.object({ threadId: z.string() }), z.object({ deleted: z.literal(true), threadId: z.string() })),
  descriptor('task.active.list', z.object({}), z.array(z.custom<ActiveTaskItem>())),
  descriptor('task.detail.get', z.object({ taskId: z.string() }), z.custom<TaskDetail>()),
  descriptor('task.scheduledRuns.list', z.object({ taskId: z.string(), limit: z.number().int().positive().optional() }), z.array(z.custom<ScheduledTaskRun>())),
  descriptor('task.outbox.replay', z.object({}), z.object({ appliedCount: z.number().int().nonnegative(), lastSequence: z.number().int().nonnegative() }))
] as const satisfies readonly CapabilityDescriptor[];

export function createTaskPlugin(): RocPlugin {
  let scheduler: TaskScheduler | null = null;
  let unsubscribeAgentRunStarted: EventSubscription | null = null;
  let unsubscribeAgentRunCompleted: EventSubscription | null = null;
  let unsubscribeAgentRunCancelled: EventSubscription | null = null;
  let unsubscribeAgentRunFailed: EventSubscription | null = null;
  let unsubscribeAgentRunTaskEvent: EventSubscription | null = null;
  return {
    manifest: {
      id: pluginId,
      version: '1.0.0',
      displayName: 'Task',
      description: 'Roc task plugin.',
      loadPhase: 'critical',
      required: true,
      order: 30,
      dependencies: ['@roc/plugin-agent', '@roc/plugin-workspace'],
      capabilities: taskCapabilityDescriptors
    },
    initialize: async (context) => {
      const db = context.database.getTaskConnection();
      applyTaskPluginSchema(db);
      const deletionJournal = new ThreadDeletionJournal(db);
      const agentHistory = new AgentTaskHistoryReader(context.database.getAgentConnection());
      const repository = new TaskRepository(db, agentHistory, deletionJournal);
      const projectAgentOutboxBestEffort = (): void => {
        try {
          projectAgentOutbox({ agentHistory, repository });
        } catch (error) {
          context.logger.warn('Agent outbox projection failed.', {
            component: 'task.outbox.projector',
            error: error instanceof Error ? error.message : String(error)
          });
        }
      };
      for (const record of repository.listIncompleteThreadDeletions()) {
        try {
          repository.deleteThread(record.threadId);
        } catch (error) {
          const failedRecord = deletionJournal.require(record.threadId);
          context.logger.warn('Task thread deletion recovery failed.', {
            component: 'task.initialize',
            threadId: record.threadId,
            state: failedRecord.state,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      projectAgentOutboxBestEffort();
      scheduler = new TaskScheduler(repository, {
        startRun: (request) => context.capabilities.invoke<ChatStartRunRequest, ChatStartRunResult>('agent.run.start', request)
      });
      scheduler.start();
      registerTaskCapabilities(context, repository, scheduler, () => projectAgentOutbox({ agentHistory, repository }));
      unsubscribeAgentRunStarted = context.eventBus.subscribe('agent.run.started', async (event) => {
        const payload = readAgentRunStartedPayload(event.payload);
        if (payload === null) {
          return;
        }
        repository.recordAgentRunStarted({
          ...payload,
          threadKind: resolveAgentRunThreadKind(payload)
        });
      });
      unsubscribeAgentRunCompleted = context.eventBus.subscribe('agent.run.completed', () => {
        projectAgentOutboxBestEffort();
      });
      unsubscribeAgentRunCancelled = context.eventBus.subscribe('agent.run.cancelled', () => {
        projectAgentOutboxBestEffort();
      });
      unsubscribeAgentRunFailed = context.eventBus.subscribe('agent.run.failed', () => {
        projectAgentOutboxBestEffort();
      });
      unsubscribeAgentRunTaskEvent = context.eventBus.subscribe('agent.run.task-event', (event) => {
        const payload = readAgentTaskEventPayload(event.payload);
        if (payload === null) {
          return;
        }
        repository.recordAgentTaskEvent({
          ...payload,
          createdAt: event.createdAt
        });
      });
    },
    shutdown: async () => {
      if (unsubscribeAgentRunStarted !== null) {
        unsubscribeAgentRunStarted();
      }
      unsubscribeAgentRunStarted = null;
      if (unsubscribeAgentRunCompleted !== null) {
        unsubscribeAgentRunCompleted();
      }
      unsubscribeAgentRunCompleted = null;
      if (unsubscribeAgentRunCancelled !== null) {
        unsubscribeAgentRunCancelled();
      }
      unsubscribeAgentRunCancelled = null;
      if (unsubscribeAgentRunFailed !== null) {
        unsubscribeAgentRunFailed();
      }
      unsubscribeAgentRunFailed = null;
      if (unsubscribeAgentRunTaskEvent !== null) {
        unsubscribeAgentRunTaskEvent();
      }
      unsubscribeAgentRunTaskEvent = null;
      if (scheduler !== null) {
        scheduler.stop();
      }
      scheduler = null;
    },
    healthCheck: async () => ({ status: 'healthy' })
  };
}

function projectAgentOutbox(input: { agentHistory: AgentTaskHistoryReader; repository: TaskRepository }): { appliedCount: number; lastSequence: number } {
  let lastSequence = input.repository.getAgentOutboxCursor(agentOutboxProjectorName);
  let appliedCount = 0;
  while (true) {
    const events = input.agentHistory.listOutboxEventsAfter({
      afterSequence: lastSequence,
      limit: agentOutboxProjectionBatchSize
    });
    if (events.length === 0) {
      return { appliedCount, lastSequence };
    }
    const result = input.repository.projectAgentOutboxEvents({
      events,
      projectorName: agentOutboxProjectorName
    });
    lastSequence = result.lastSequence;
    appliedCount += result.appliedCount;
    if (events.length < agentOutboxProjectionBatchSize) {
      return { appliedCount, lastSequence };
    }
  }
}

function registerTaskCapabilities(
  context: RocPluginContext,
  repository: TaskRepository,
  scheduler: TaskScheduler,
  replayAgentOutbox: () => { appliedCount: number; lastSequence: number }
): void {
  context.capabilities.register(pluginId, taskCapabilityDescriptors[0], async () => repository.getSnapshot());
  context.capabilities.register(pluginId, taskCapabilityDescriptors[1], async (input) =>
    repository.createBackgroundTaskPreview(backgroundTaskPreviewRequestSchema.parse(input))
  );
  context.capabilities.register(pluginId, taskCapabilityDescriptors[2], async (input) => {
    const task = repository.createBackgroundTask(backgroundTaskPreviewRequestSchema.parse(input));
    scheduler.registerTask(task);
    await publishTaskUpdated(context, { kind: 'task_created', taskId: task.id });
    return task;
  });
  context.capabilities.register(pluginId, taskCapabilityDescriptors[3], async (input) => {
    const task = repository.updateBackgroundTask(updateBackgroundTaskRequestSchema.parse(input));
    scheduler.registerTask(task);
    await publishTaskUpdated(context, { kind: 'task_status_changed', taskId: task.id, status: task.status });
    return task;
  });
  context.capabilities.register(pluginId, taskCapabilityDescriptors[4], async (input) => {
    const { id } = input as { id: string };
    const task = repository.findBackgroundTask(id);
    if (task === null) {
      throw new Error('background_task_not_found');
    }
    const startResult = await context.capabilities.invoke<ChatStartRunRequest, ChatStartRunResult>('agent.run.start', {
      input: task.goal,
      mode: 'task',
      taskSource: 'workbench',
      threadId: task.threadId,
      enabledCapabilities: task.enabledCapabilities === null ? { mcpServers: [], skills: [] } : task.enabledCapabilities,
      workspacePath: task.workspacePath
    });
    const result = scheduler.runNow(id, startResult.runId);
    await publishTaskUpdated(context, { kind: 'task_run_fired', taskId: result.taskId, runId: result.runId });
    return result;
  });
  context.capabilities.register(pluginId, taskCapabilityDescriptors[5], async (input) => {
    const task = repository.pauseBackgroundTask((input as { id: string }).id);
    scheduler.registerTask(task);
    await publishTaskUpdated(context, { kind: 'task_status_changed', taskId: task.id, status: task.status });
    return task;
  });
  context.capabilities.register(pluginId, taskCapabilityDescriptors[6], async (input) => {
    const task = repository.resumeBackgroundTask((input as { id: string }).id);
    scheduler.registerTask(task);
    await publishTaskUpdated(context, { kind: 'task_status_changed', taskId: task.id, status: task.status });
    return task;
  });
  context.capabilities.register(pluginId, taskCapabilityDescriptors[7], async (input) => {
    const task = repository.cancelBackgroundTask((input as { id: string }).id);
    scheduler.unregisterTask(task.id);
    await publishTaskUpdated(context, { kind: 'task_status_changed', taskId: task.id, status: task.status });
    return task;
  });
  context.capabilities.register(pluginId, taskCapabilityDescriptors[8], async (input) => {
    const result = repository.deleteBackgroundTask((input as { id: string }).id);
    scheduler.unregisterTask(result.taskId);
    await publishTaskUpdated(context, { kind: 'task_status_changed', taskId: result.taskId, status: 'archived' });
    return result;
  });
  context.capabilities.register(pluginId, taskCapabilityDescriptors[9], async () => scheduler.getStatus());
  context.capabilities.register(pluginId, taskCapabilityDescriptors[10], async () => {
    scheduler.suspendAll();
    return { suspended: true as const };
  });
  context.capabilities.register(pluginId, taskCapabilityDescriptors[11], async () => {
    scheduler.resumeAll();
    return { resumed: true as const };
  });
  context.capabilities.register(pluginId, taskCapabilityDescriptors[12], async () => {
    scheduler.handlePowerResume();
    return { handled: true as const };
  });
  context.capabilities.register(pluginId, taskCapabilityDescriptors[13], async () => repository.getBackgroundTaskSummary());
  context.capabilities.register(pluginId, taskCapabilityDescriptors[14], async (input) =>
    repository.listThreadMessages(input as TaskMessageHistoryRequest)
  );
  context.capabilities.register(pluginId, taskCapabilityDescriptors[15], async () => repository.listBackgroundTasks());
  context.capabilities.register(pluginId, taskCapabilityDescriptors[16], async (input) => {
    const { threadId } = input as TaskDeleteThreadRequest;
    const linkedTaskIds = repository.listBackgroundTasks()
      .filter((task) => task.threadId === threadId)
      .map((task) => task.id);
    let result: TaskDeleteThreadResult;
    try {
      result = repository.deleteThread(threadId);
    } catch (error) {
      if (repository.listIncompleteThreadDeletions().some((record) => record.threadId === threadId)) {
        for (const taskId of linkedTaskIds) {
          scheduler.unregisterTask(taskId);
        }
        await publishTaskUpdated(context, { kind: 'thread_deletion_started', threadId });
      }
      throw error;
    }
    for (const taskId of linkedTaskIds) {
      scheduler.unregisterTask(taskId);
      await publishTaskUpdated(context, { kind: 'task_status_changed', taskId, status: 'archived' });
    }
    return result;
  });
  context.capabilities.register(pluginId, taskCapabilityDescriptors[17], async () => repository.getActiveTasks());
  context.capabilities.register(pluginId, taskCapabilityDescriptors[18], async (input) =>
    repository.getTaskDetail({
      taskId: (input as { taskId: string }).taskId,
      schedulerRegistered: scheduler.getStatus().registeredTaskCount > 0
    })
  );
  context.capabilities.register(pluginId, taskCapabilityDescriptors[19], async (input) =>
    repository.listScheduledRuns(input as { taskId: string; limit?: number })
  );
  context.capabilities.register(pluginId, taskCapabilityDescriptors[20], async () => replayAgentOutbox());
}

async function publishTaskUpdated(context: RocPluginContext, payload: TaskUpdateEvent): Promise<void> {
  await context.eventBus.publish({
    type: 'task.updated',
    source: pluginId,
    payload,
    createdAt: new Date().toISOString()
  });
}

function descriptor<TInput, TOutput>(
  name: string,
  inputSchema: z.ZodType<TInput>,
  outputSchema: z.ZodType<TOutput>
): CapabilityDescriptor<TInput, TOutput> {
  return {
    name,
    version: capabilityVersion,
    inputSchema,
    outputSchema
  };
}
