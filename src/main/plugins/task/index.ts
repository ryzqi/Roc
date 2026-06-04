import { z } from 'zod';

import type {
  BackgroundTask,
  BackgroundTaskPreview,
  BackgroundTaskPreviewRequest,
  ChatStartRunRequest,
  ChatStartRunResult,
  SchedulerStatus,
  TaskSnapshot,
  TaskUpdateEvent,
  UpdateBackgroundTaskRequest
} from '../../../shared/types';
import type { CapabilityDescriptor, RocPlugin, RocPluginContext } from '../../kernel/types';
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

export const taskCapabilityDescriptors = [
  descriptor('task.snapshot.get', z.object({}), z.custom<TaskSnapshot>()),
  descriptor('task.background.preview', z.custom<BackgroundTaskPreviewRequest>(), z.custom<BackgroundTaskPreview>()),
  descriptor('task.background.create', z.custom<BackgroundTaskPreview>(), z.custom<BackgroundTask>()),
  descriptor('task.background.update', z.custom<UpdateBackgroundTaskRequest>(), z.custom<BackgroundTask>()),
  descriptor('task.background.runNow', idInputSchema, taskRunNowResultSchema),
  descriptor('task.background.pause', idInputSchema, z.custom<BackgroundTask>()),
  descriptor('task.background.resume', idInputSchema, z.custom<BackgroundTask>()),
  descriptor('task.background.cancel', idInputSchema, z.custom<BackgroundTask>()),
  descriptor('task.background.delete', idInputSchema, z.object({ deleted: z.literal(true), taskId: z.string() })),
  descriptor('task.scheduler.status', z.object({}), z.custom<SchedulerStatus>())
] as const satisfies readonly CapabilityDescriptor[];

export function createTaskPlugin(): RocPlugin {
  let scheduler: TaskScheduler | null = null;
  return {
    manifest: {
      id: pluginId,
      version: '1.0.0',
      displayName: 'Task',
      description: 'Roc task plugin.',
      loadPhase: 'critical',
      required: true,
      order: 30,
      dependencies: ['@roc/plugin-agent'],
      capabilities: taskCapabilityDescriptors
    },
    initialize: async (context) => {
      const db = context.database.getConnection();
      applyTaskPluginSchema(db);
      const repository = new TaskRepository(db);
      scheduler = new TaskScheduler(repository);
      scheduler.start();
      scheduler.registerAllFromDatabase();
      registerTaskCapabilities(context, repository, scheduler);
    },
    shutdown: async () => {
      if (scheduler !== null) {
        scheduler.stop();
      }
      scheduler = null;
    },
    healthCheck: async () => ({ status: 'healthy' })
  };
}

export const taskPlugin = createTaskPlugin();

function registerTaskCapabilities(context: RocPluginContext, repository: TaskRepository, scheduler: TaskScheduler): void {
  context.capabilities.register(pluginId, taskCapabilityDescriptors[0], async () => repository.getSnapshot());
  context.capabilities.register(pluginId, taskCapabilityDescriptors[1], async (input) =>
    repository.createBackgroundTaskPreview(input as BackgroundTaskPreviewRequest)
  );
  context.capabilities.register(pluginId, taskCapabilityDescriptors[2], async (input) => {
    const task = repository.createBackgroundTask(input as BackgroundTaskPreview);
    scheduler.registerTask(task);
    await publishTaskUpdated(context, { kind: 'task_created', taskId: task.id });
    return task;
  });
  context.capabilities.register(pluginId, taskCapabilityDescriptors[3], async (input) => {
    const task = repository.updateBackgroundTask(input as UpdateBackgroundTaskRequest);
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
      threadId: task.threadId,
      enabledCapabilities: task.enabledCapabilities === null ? { mcpServers: [], skills: [] } : task.enabledCapabilities
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
