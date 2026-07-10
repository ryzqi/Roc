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
  TaskDetail,
  TaskEvent,
  TaskSnapshot,
  TaskUpdateEvent,
} from '../../../shared/types';
import type { CapabilityDescriptor, EventSubscription, RocPlugin, RocPluginContext } from '../../kernel/types';
import {
  readAgentRunCompletedPayload,
  readAgentRunFailedPayload,
  readAgentRunStartedPayload,
  readAgentTaskEventPayload,
  resolveAgentRunThreadKind
} from './agent-run-payloads';
import { AgentTaskHistoryReader } from './agent-task-history';
import {
  backgroundTaskPreviewRequestSchema,
  backgroundTaskPreviewSchema,
  backgroundTaskSchema,
  updateBackgroundTaskRequestSchema
} from './contracts';
import { TaskScheduler } from './scheduler';
import { applyTaskPluginSchema } from './schema';
import { TaskRepository } from './task-repository';

const pluginId = '@roc/plugin-task';
const capabilityVersion = '1.0.0';

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
  descriptor('task.thread.messages.list', z.object({ threadId: z.string() }), z.array(z.custom<TaskEvent>())),
  descriptor('task.background.list', z.object({}), z.array(z.custom<BackgroundTask>())),
  descriptor('task.thread.delete', z.object({ threadId: z.string() }), z.object({ deleted: z.literal(true), threadId: z.string() })),
  descriptor('task.active.list', z.object({}), z.array(z.custom<ActiveTaskItem>())),
  descriptor('task.detail.get', z.object({ taskId: z.string() }), z.custom<TaskDetail>()),
  descriptor('task.scheduledRuns.list', z.object({ taskId: z.string(), limit: z.number().int().positive().optional() }), z.array(z.custom<ScheduledTaskRun>()))
] as const satisfies readonly CapabilityDescriptor[];

export function createTaskPlugin(): RocPlugin {
  let scheduler: TaskScheduler | null = null;
  let unsubscribeAgentRunStarted: EventSubscription | null = null;
  let unsubscribeAgentRunCompleted: EventSubscription | null = null;
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
      const repository = new TaskRepository(db, new AgentTaskHistoryReader(context.database.getAgentConnection()));
      scheduler = new TaskScheduler(repository, {
        startRun: (request) => context.capabilities.invoke<ChatStartRunRequest, ChatStartRunResult>('agent.run.start', request)
      });
      scheduler.start();
      registerTaskCapabilities(context, repository, scheduler);
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
      unsubscribeAgentRunCompleted = context.eventBus.subscribe('agent.run.completed', (event) => {
        const payload = readAgentRunCompletedPayload(event.payload);
        if (payload === null) {
          return;
        }
        repository.recordAgentRunCompleted(payload);
      });
      unsubscribeAgentRunFailed = context.eventBus.subscribe('agent.run.failed', (event) => {
        const payload = readAgentRunFailedPayload(event.payload);
        if (payload === null) {
          return;
        }
        repository.recordAgentRunFailed(payload);
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

function registerTaskCapabilities(context: RocPluginContext, repository: TaskRepository, scheduler: TaskScheduler): void {
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
    repository.listThreadMessages((input as { threadId: string }).threadId)
  );
  context.capabilities.register(pluginId, taskCapabilityDescriptors[15], async () => repository.listBackgroundTasks());
  context.capabilities.register(pluginId, taskCapabilityDescriptors[16], async (input) => {
    const { threadId } = input as TaskDeleteThreadRequest;
    const linkedTaskIds = repository.listBackgroundTasks()
      .filter((task) => task.threadId === threadId)
      .map((task) => task.id);
    const result = repository.deleteThread(threadId);
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
