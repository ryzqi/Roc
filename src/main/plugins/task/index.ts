import { z } from 'zod';

import type {
  ActiveTaskItem,
  AgentCapabilityPreview,
  BackgroundTask,
  BackgroundTaskPreview,
  BackgroundTaskPreviewRequest,
  BackgroundTaskSummary,
  ChatStartRunRequest,
  ChatStartRunResult,
  EnabledCapabilities,
  TaskDeleteThreadRequest,
  TaskDetail,
  TaskEvent,
  SchedulerStatus,
  ScheduledTaskRun,
  TaskSnapshot,
  TaskUpdateEvent,
  UpdateBackgroundTaskRequest
} from '../../../shared/types';
import type { CapabilityDescriptor, EventSubscription, RocPlugin, RocPluginContext } from '../../kernel/types';
import { TaskScheduler } from './scheduler';
import { applyTaskPluginSchema } from './schema';
import { createTaskProposalWorkflow } from './task-proposal-workflow';
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
  descriptor('task.scheduledRuns.list', z.object({ taskId: z.string(), limit: z.number().int().optional() }), z.array(z.custom<ScheduledTaskRun>())),
  descriptor('task.background.openInChat', z.object({ taskId: z.string() }), z.object({ threadId: z.string() }))
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
      const db = context.database.getConnection();
      applyTaskPluginSchema(db);
      const repository = new TaskRepository(db);
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
        repository.recordAgentRunStarted(payload);
        if (payload.workflowHint === 'propose_background_task') {
          const workflow = createTaskProposalWorkflow(context);
          const result = await workflow({
            runId: payload.runId,
            threadId: payload.threadId,
            input: payload.userInput,
            enabledCapabilities: payload.enabledCapabilities,
            recordTaskEvent: async (type, eventPayload) => {
              repository.recordAgentTaskEvent({
                runId: payload.runId,
                threadId: payload.threadId,
                type,
                payload: eventPayload,
                createdAt: new Date().toISOString()
              });
            }
          });
          repository.recordAgentRunCompleted({
            runId: payload.runId,
            threadId: payload.threadId,
            assistantMessage: result.assistantMessage,
            providerId: payload.providerId,
            modelId: payload.modelId,
            durationMs: 0,
            summary: result.summary,
            finishReason: 'stop'
          });
        }
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
      taskSource: 'workbench',
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
    const result = repository.archiveThread(threadId);
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
  context.capabilities.register(pluginId, taskCapabilityDescriptors[20], async (input) =>
    repository.openBackgroundTaskInChat((input as { taskId: string }).taskId)
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

function readAgentRunCompletedPayload(payload: unknown): {
  runId: string;
  threadId: string;
  assistantMessage: string;
  providerId: string;
  modelId: string;
  durationMs: number;
  summary: string;
  finishReason: string;
} | null {
  if (payload === null || typeof payload !== 'object') {
    return null;
  }
  const runId = Reflect.get(payload, 'runId');
  const threadId = Reflect.get(payload, 'threadId');
  const assistantMessage = Reflect.get(payload, 'assistantMessage');
  const providerId = Reflect.get(payload, 'providerId');
  const modelId = Reflect.get(payload, 'modelId');
  const durationMs = Reflect.get(payload, 'durationMs');
  const summary = Reflect.get(payload, 'summary');
  const finishReason = Reflect.get(payload, 'finishReason');
  if (
    typeof runId !== 'string' ||
    typeof threadId !== 'string' ||
    typeof assistantMessage !== 'string' ||
    typeof providerId !== 'string' ||
    typeof modelId !== 'string' ||
    typeof durationMs !== 'number' ||
    typeof summary !== 'string' ||
    typeof finishReason !== 'string'
  ) {
    return null;
  }
  return {
    runId,
    threadId,
    assistantMessage,
    providerId,
    modelId,
    durationMs,
    summary,
    finishReason
  };
}

function readAgentRunFailedPayload(payload: unknown): {
  runId: string;
  threadId: string;
  providerId: string;
  modelId: string;
  error: string;
  code: string;
  retryable: boolean;
} | null {
  if (payload === null || typeof payload !== 'object') {
    return null;
  }
  const runId = Reflect.get(payload, 'runId');
  const threadId = Reflect.get(payload, 'threadId');
  const providerId = Reflect.get(payload, 'providerId');
  const modelId = Reflect.get(payload, 'modelId');
  const error = Reflect.get(payload, 'error');
  const code = Reflect.get(payload, 'code');
  const retryable = Reflect.get(payload, 'retryable');
  if (
    typeof runId !== 'string' ||
    typeof threadId !== 'string' ||
    typeof providerId !== 'string' ||
    typeof modelId !== 'string' ||
    typeof error !== 'string' ||
    typeof code !== 'string' ||
    typeof retryable !== 'boolean'
  ) {
    return null;
  }
  return {
    runId,
    threadId,
    providerId,
    modelId,
    error,
    code,
    retryable
  };
}

function readAgentTaskEventPayload(payload: unknown): {
  runId: string;
  threadId: string;
  type: TaskEvent['type'];
  payload: Record<string, unknown>;
} | null {
  if (payload === null || typeof payload !== 'object') {
    return null;
  }
  const runId = Reflect.get(payload, 'runId');
  const threadId = Reflect.get(payload, 'threadId');
  const type = Reflect.get(payload, 'type');
  const eventPayload = Reflect.get(payload, 'payload');
  if (
    typeof runId !== 'string' ||
    typeof threadId !== 'string' ||
    !isAgentTaskEventType(type) ||
    eventPayload === null ||
    typeof eventPayload !== 'object' ||
    Array.isArray(eventPayload)
  ) {
    return null;
  }
  return {
    runId,
    threadId,
    type,
    payload: eventPayload as Record<string, unknown>
  };
}

function isAgentTaskEventType(value: unknown): value is TaskEvent['type'] {
  return (
    value === 'tool_call' ||
    value === 'assistant_block' ||
    value === 'guardrail_nudge' ||
    value === 'subagent_started' ||
    value === 'subagent_completed' ||
    value === 'approval_requested' ||
    value === 'approval_decision'
  );
}

function readAgentRunStartedPayload(payload: unknown): {
  runId: string;
  threadId: string;
  mode: ChatStartRunRequest['mode'];
  userInput: string;
  providerId: string;
  modelId: string;
  enabledCapabilities: EnabledCapabilities;
  workflowHint: ChatStartRunRequest['workflowHint'] | null;
  capabilityPreview?: AgentCapabilityPreview;
  createdAt: string;
} | null {
  if (payload === null || typeof payload !== 'object') {
    return null;
  }
  const runId = Reflect.get(payload, 'runId');
  const threadId = Reflect.get(payload, 'threadId');
  const mode = Reflect.get(payload, 'mode');
  const userInput = Reflect.get(payload, 'userInput');
  const providerId = Reflect.get(payload, 'providerId');
  const modelId = Reflect.get(payload, 'modelId');
  const enabledCapabilities = readEnabledCapabilities(Reflect.get(payload, 'enabledCapabilities'));
  const workflowHint = readWorkflowHint(Reflect.get(payload, 'workflowHint'));
  const capabilityPreview = readAgentCapabilityPreview(Reflect.get(payload, 'capabilityPreview'));
  const createdAt = Reflect.get(payload, 'createdAt');
  if (
    typeof runId !== 'string' ||
    typeof threadId !== 'string' ||
    !isChatRunMode(mode) ||
    typeof userInput !== 'string' ||
    typeof providerId !== 'string' ||
    typeof modelId !== 'string' ||
    enabledCapabilities === null ||
    workflowHint === undefined ||
    typeof createdAt !== 'string'
  ) {
    return null;
  }
  return {
    runId,
    threadId,
    mode,
    userInput,
    providerId,
    modelId,
    enabledCapabilities,
    workflowHint,
    ...(capabilityPreview === undefined ? {} : { capabilityPreview }),
    createdAt
  };
}

function isChatRunMode(value: unknown): value is ChatStartRunRequest['mode'] {
  return value === 'chat' || value === 'task';
}

function readWorkflowHint(value: unknown): ChatStartRunRequest['workflowHint'] | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }
  if (value === 'propose_background_task' || value === 'background_task_change') {
    return value;
  }
  return undefined;
}

function readAgentCapabilityPreview(value: unknown): AgentCapabilityPreview | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== 'object') {
    return undefined;
  }
  const requestedCapabilities = readEnabledCapabilities(Reflect.get(value, 'requestedCapabilities'));
  const selectedCapabilities = readEnabledCapabilities(Reflect.get(value, 'selectedCapabilities'));
  const skippedCapabilities = Reflect.get(value, 'skippedCapabilities');
  const toolCards = Reflect.get(value, 'toolCards');
  const skillCards = Reflect.get(value, 'skillCards');
  const untrustedContextPolicy = Reflect.get(value, 'untrustedContextPolicy');
  if (
    requestedCapabilities === null ||
    selectedCapabilities === null ||
    !Array.isArray(skippedCapabilities) ||
    !Array.isArray(toolCards) ||
    !Array.isArray(skillCards) ||
    untrustedContextPolicy !== 'external_content_reference_only'
  ) {
    return undefined;
  }
  return value as AgentCapabilityPreview;
}

function readEnabledCapabilities(value: unknown): EnabledCapabilities | null {
  if (value === null || typeof value !== 'object') {
    return null;
  }
  const mcpServers = Reflect.get(value, 'mcpServers');
  const skills = Reflect.get(value, 'skills');
  if (!isStringArray(mcpServers) || !isStringArray(skills)) {
    return null;
  }
  return {
    mcpServers,
    skills
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
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
