import { z } from 'zod';

import type {
  BackgroundTask,
  BackgroundTaskPreview,
  BackgroundTaskPreviewRequest,
  BackgroundTaskTrigger,
  EnabledCapabilities,
  PersistedTaskEvent,
  TaskEvent,
  TaskMessageHistoryPage,
  TaskMessageHistoryRequest,
  UpdateBackgroundTaskRequest
} from '../../../shared/types';

const taskEventTypeSchema = z.enum([
  'message',
  'assistant_block',
  'agent_update',
  'plan',
  'tool_call',
  'mcp_call',
  'skill_loaded',
  'subagent_event',
  'hook_started',
  'hook_completed',
  'agent_execute',
  'file_change',
  'git_operation',
  'memory_operation',
  'approval_requested',
  'approval_decision',
  'human_question_requested',
  'human_question_answered',
  'recovery_point',
  'context_manifest',
  'background_task_created',
  'background_task_paused',
  'background_task_resumed',
  'background_task_cancelled',
  'long_running_promoted',
  'guardrail_nudge',
  'diagnostic',
  'verification',
  'error',
  'summary'
]);

export const taskEventSchema = z
  .object({
    id: z.string().trim().min(1),
    threadId: z.string().trim().min(1),
    runId: z.string().trim().min(1),
    type: taskEventTypeSchema,
    payload: z.unknown(),
    createdAt: z.string().datetime({ offset: true }),
    sequence: z.number().int().positive().optional()
  })
  .strict() satisfies z.ZodType<TaskEvent>;

export const persistedTaskEventSchema = taskEventSchema
  .omit({ sequence: true })
  .extend({ sequence: z.number().int().positive() })
  .strict() satisfies z.ZodType<PersistedTaskEvent>;

const taskMessageCursorSchema = z.discriminatedUnion('direction', [
  z.object({ direction: z.literal('before'), sequence: z.number().int().positive() }).strict(),
  z.object({ direction: z.literal('after'), sequence: z.number().int().positive() }).strict()
]);

export const taskMessageHistoryRequestSchema = z
  .object({
    threadId: z.string().trim().min(1),
    limit: z.number().int().min(1).max(200),
    cursor: taskMessageCursorSchema.nullable()
  })
  .strict() satisfies z.ZodType<TaskMessageHistoryRequest>;

export const taskMessageHistoryPageSchema = z
  .object({
    items: z.array(persistedTaskEventSchema),
    oldestSequence: z.number().int().positive().nullable(),
    newestSequence: z.number().int().positive().nullable(),
    hasMoreBefore: z.boolean(),
    hasMoreAfter: z.boolean()
  })
  .strict() satisfies z.ZodType<TaskMessageHistoryPage>;

export const enabledCapabilitiesSchema = z
  .object({
    mcpServers: z.array(z.string().trim().min(1)),
    skills: z.array(z.string().trim().min(1))
  })
  .strict() satisfies z.ZodType<EnabledCapabilities>;

export const backgroundTaskTriggerSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('manual'),
      description: z.string().trim().min(1)
    })
    .strict(),
  z
    .object({
      type: z.literal('once'),
      description: z.string().trim().min(1),
      nextRunAt: z.string().datetime({ offset: true })
    })
    .strict(),
  z
    .object({
      type: z.literal('cron'),
      description: z.string().trim().min(1),
      cronExpression: z.string().trim().min(1),
      nextRunAt: z.string().datetime({ offset: true })
    })
    .strict()
]) satisfies z.ZodType<BackgroundTaskTrigger>;

export const backgroundTaskPreviewRequestSchema = z
  .object({
    goal: z.string().trim().min(1),
    trigger: backgroundTaskTriggerSchema,
    workspacePath: z.string().trim().min(1),
    allowedActions: z.array(z.string().trim().min(1)),
    forbiddenActions: z.array(z.string().trim().min(1)),
    failurePolicy: z.literal('pause_and_report'),
    notificationPolicy: z.literal('failures_and_confirmations'),
    enabledCapabilities: enabledCapabilitiesSchema.nullable().optional()
  })
  .strict() satisfies z.ZodType<BackgroundTaskPreviewRequest>;

export const backgroundTaskPreviewSchema = backgroundTaskPreviewRequestSchema
  .extend({
    scheduled: z.boolean(),
    nextRunAt: z.string().datetime({ offset: true }).nullable(),
    cronExpression: z.string().nullable(),
    riskLevel: z.enum(['low', 'medium', 'high']),
    requiresConfirmation: z.boolean(),
    enabledCapabilities: enabledCapabilitiesSchema.nullable()
  })
  .strict() satisfies z.ZodType<BackgroundTaskPreview>;

export const updateBackgroundTaskRequestSchema = z
  .object({
    taskId: z.string().trim().min(1),
    patch: backgroundTaskPreviewRequestSchema.partial().strict(),
    reason: z.string().trim().min(1)
  })
  .strict() satisfies z.ZodType<UpdateBackgroundTaskRequest>;

export const backgroundTaskSchema = z
  .object({
    id: z.string().trim().min(1),
    threadId: z.string().trim().min(1),
    runId: z.string().trim().min(1),
    goal: z.string().trim().min(1),
    status: z.enum([
      'draft',
      'pending_confirmation',
      'running',
      'paused',
      'waiting_user',
      'waiting_next_turn',
      'failed',
      'cancelled',
      'completed',
      'archived'
    ]),
    scheduled: z.boolean(),
    triggerType: z.enum(['manual', 'once', 'cron']),
    triggerDescription: z.string().trim().min(1),
    nextRunAt: z.string().datetime({ offset: true }).nullable(),
    cronExpression: z.string().nullable(),
    workspacePath: z.string().trim().min(1),
    allowedActions: z.array(z.string().trim().min(1)),
    forbiddenActions: z.array(z.string().trim().min(1)),
    failurePolicy: z.literal('pause_and_report'),
    notificationPolicy: z.literal('failures_and_confirmations'),
    riskLevel: z.enum(['low', 'medium', 'high']),
    requiresConfirmation: z.boolean(),
    lastRunAt: z.string().datetime({ offset: true }).nullable(),
    lastRunStatus: z.enum(['success', 'failed', 'cancelled']).nullable(),
    runCount: z.number().int().min(0),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    enabledCapabilities: enabledCapabilitiesSchema.nullable()
  })
  .strict() satisfies z.ZodType<BackgroundTask>;
