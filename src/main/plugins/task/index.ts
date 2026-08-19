import { z } from 'zod';

import {
  activeTaskItemSchema,
  backgroundTaskSchema,
  scheduledTaskRunSchema,
  scheduledTaskRunsRequestSchema,
  schedulerStatusSchema,
  taskDeleteBackgroundResultSchema,
  taskDeleteThreadRequestSchema,
  taskDeleteThreadResultSchema,
  taskDetailSchema,
  taskIdRequestSchema,
  taskRunNowResultSchema,
  taskSnapshotSchema
} from '../../../shared/schemas/ipc-core';
import type {
  BackgroundTaskSummary,
  ChatStartRunRequest,
  ChatStartRunResult,
  TaskDeleteThreadRequest,
  TaskDeleteThreadResult,
  TaskMessageHistoryRequest,
  TaskUpdateEvent
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

const taskCapabilityDescriptorByName = {
  'task.snapshot.get': descriptor('task.snapshot.get', z.object({}), taskSnapshotSchema),
  'task.background.preview': descriptor('task.background.preview', backgroundTaskPreviewRequestSchema, backgroundTaskPreviewSchema),
  'task.background.create': descriptor('task.background.create', backgroundTaskPreviewRequestSchema, backgroundTaskSchema),
  'task.background.update': descriptor('task.background.update', updateBackgroundTaskRequestSchema, backgroundTaskSchema),
  'task.background.runNow': descriptor('task.background.runNow', idInputSchema, taskRunNowResultSchema),
  'task.background.pause': descriptor('task.background.pause', idInputSchema, backgroundTaskSchema),
  'task.background.resume': descriptor('task.background.resume', idInputSchema, backgroundTaskSchema),
  'task.background.cancel': descriptor('task.background.cancel', idInputSchema, backgroundTaskSchema),
  'task.background.delete': descriptor('task.background.delete', idInputSchema, taskDeleteBackgroundResultSchema),
  'task.scheduler.status': descriptor('task.scheduler.status', z.object({}), schedulerStatusSchema),
  'task.scheduler.suspend': descriptor('task.scheduler.suspend', z.object({}), z.object({ suspended: z.literal(true) })),
  'task.scheduler.resume': descriptor('task.scheduler.resume', z.object({}), z.object({ resumed: z.literal(true) })),
  'task.scheduler.handlePowerResume': descriptor(
    'task.scheduler.handlePowerResume',
    z.object({}),
    z.object({ handled: z.literal(true) })
  ),
  'task.background.summary': descriptor('task.background.summary', z.object({}), z.custom<BackgroundTaskSummary>()),
  'task.thread.messages.list': descriptor(
    'task.thread.messages.list',
    taskMessageHistoryRequestSchema,
    taskMessageHistoryPageSchema
  ),
  'task.background.list': descriptor('task.background.list', z.object({}), backgroundTaskSchema.array()),
  'task.thread.delete': descriptor('task.thread.delete', taskDeleteThreadRequestSchema, taskDeleteThreadResultSchema),
  'task.active.list': descriptor('task.active.list', z.object({}), activeTaskItemSchema.array()),
  'task.detail.get': descriptor('task.detail.get', taskIdRequestSchema, taskDetailSchema),
  'task.scheduledRuns.list': descriptor(
    'task.scheduledRuns.list',
    scheduledTaskRunsRequestSchema,
    scheduledTaskRunSchema.array()
  ),
  'task.outbox.replay': descriptor(
    'task.outbox.replay',
    z.object({}),
    z.object({ appliedCount: z.number().int().nonnegative(), lastSequence: z.number().int().nonnegative() })
  )
} as const satisfies Record<string, CapabilityDescriptor>;

type TaskCapabilityName = keyof typeof taskCapabilityDescriptorByName;
type TaskCapabilityHandler = (input: unknown) => Promise<unknown>;

const taskCapabilityDescriptors = Object.values(taskCapabilityDescriptorByName);

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
        scheduler?.reconcile();
      });
      unsubscribeAgentRunCancelled = context.eventBus.subscribe('agent.run.cancelled', () => {
        projectAgentOutboxBestEffort();
        scheduler?.reconcile();
      });
      unsubscribeAgentRunFailed = context.eventBus.subscribe('agent.run.failed', () => {
        projectAgentOutboxBestEffort();
        scheduler?.reconcile();
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
  const handlers = {
    'task.snapshot.get': async () => repository.getSnapshot(),
    'task.background.preview': async (input) =>
      repository.createBackgroundTaskPreview(backgroundTaskPreviewRequestSchema.parse(input)),
    'task.background.create': async (input) => {
      const task = repository.createBackgroundTask(backgroundTaskPreviewRequestSchema.parse(input));
      scheduler.registerTask(task);
      await publishTaskUpdated(context, { kind: 'task_created', taskId: task.id });
      return task;
    },
    'task.background.update': async (input) => {
      const task = repository.updateBackgroundTask(updateBackgroundTaskRequestSchema.parse(input));
      scheduler.registerTask(task);
      await publishTaskUpdated(context, { kind: 'task_status_changed', taskId: task.id, status: task.status });
      return task;
    },
    'task.background.runNow': async (input) => {
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
        shellAllowedCommands: [...task.allowedActions],
        workspacePath: task.workspacePath
      });
      const result = scheduler.runNow(id, startResult.runId);
      await publishTaskUpdated(context, { kind: 'task_run_fired', taskId: result.taskId, runId: result.runId });
      return result;
    },
    'task.background.pause': async (input) => {
      const task = repository.pauseBackgroundTask((input as { id: string }).id);
      scheduler.registerTask(task);
      await publishTaskUpdated(context, { kind: 'task_status_changed', taskId: task.id, status: task.status });
      return task;
    },
    'task.background.resume': async (input) => {
      const task = repository.resumeBackgroundTask((input as { id: string }).id);
      scheduler.registerTask(task);
      await publishTaskUpdated(context, { kind: 'task_status_changed', taskId: task.id, status: task.status });
      return task;
    },
    'task.background.cancel': async (input) => {
      const task = repository.cancelBackgroundTask((input as { id: string }).id);
      scheduler.unregisterTask(task.id);
      await publishTaskUpdated(context, { kind: 'task_status_changed', taskId: task.id, status: task.status });
      return task;
    },
    'task.background.delete': async (input) => {
      const result = repository.deleteBackgroundTask((input as { id: string }).id);
      scheduler.unregisterTask(result.taskId);
      await publishTaskUpdated(context, { kind: 'task_status_changed', taskId: result.taskId, status: 'archived' });
      return result;
    },
    'task.scheduler.status': async () => scheduler.getStatus(),
    'task.scheduler.suspend': async () => {
      scheduler.suspendAll();
      return { suspended: true as const };
    },
    'task.scheduler.resume': async () => {
      scheduler.resumeAll();
      return { resumed: true as const };
    },
    'task.scheduler.handlePowerResume': async () => {
      scheduler.handlePowerResume();
      return { handled: true as const };
    },
    'task.background.summary': async () => repository.getBackgroundTaskSummary(),
    'task.thread.messages.list': async (input) => repository.listThreadMessages(input as TaskMessageHistoryRequest),
    'task.background.list': async () => repository.listBackgroundTasks(),
    'task.thread.delete': async (input) => {
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
    },
    'task.active.list': async () => repository.getActiveTasks(),
    'task.detail.get': async (input) =>
      repository.getTaskDetail({
        taskId: (input as { taskId: string }).taskId,
        schedulerRegistered: scheduler.getStatus().registeredTaskCount > 0
      }),
    'task.scheduledRuns.list': async (input) =>
      repository.listScheduledRuns(input as { taskId: string; limit?: number }),
    'task.outbox.replay': async () => replayAgentOutbox()
  } satisfies Record<TaskCapabilityName, TaskCapabilityHandler>;

  const registeredNames = new Set<TaskCapabilityName>();
  for (const descriptor of taskCapabilityDescriptors) {
    if (registeredNames.has(descriptor.name)) {
      throw new Error(`task_capability_descriptor_duplicate:${descriptor.name}`);
    }
    registeredNames.add(descriptor.name);
    context.capabilities.register(pluginId, descriptor, handlers[descriptor.name]);
  }
}

async function publishTaskUpdated(context: RocPluginContext, payload: TaskUpdateEvent): Promise<void> {
  await context.eventBus.publish({
    type: 'task.updated',
    source: pluginId,
    payload,
    createdAt: new Date().toISOString()
  });
}

function descriptor<TName extends string, TInput, TOutput>(
  name: TName,
  inputSchema: z.ZodType<TInput>,
  outputSchema: z.ZodType<TOutput>
): CapabilityDescriptor<TInput, TOutput> & { readonly name: TName } {
  return {
    name,
    version: capabilityVersion,
    inputSchema,
    outputSchema
  };
}
