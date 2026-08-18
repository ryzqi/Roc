import { z } from 'zod';

import { enabledCapabilitiesSchema } from './agent';
import { hitlRequestSchema, hitlResumeDecisionSchema } from './hitl';

const identifierSchema = z.string().trim().min(1);
const timestampSchema = z.string().datetime({ offset: true });
const jsonObjectSchema = z.record(z.string(), z.json());

export const chatPersistedAttachmentSchema = z
  .object({
    kind: z.literal('image'),
    name: z.string(),
    mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    sizeBytes: z.number().nonnegative()
  })
  .strict();

export const messageTaskEventPayloadSchema = z.discriminatedUnion('role', [
  z
    .object({
      role: z.literal('user'),
      content: z.string(),
      enabledCapabilities: enabledCapabilitiesSchema.optional(),
      attachments: z.array(chatPersistedAttachmentSchema).optional()
    })
    .strict(),
  z
    .object({
      role: z.literal('assistant'),
      content: z.string(),
      providerId: identifierSchema,
      modelId: identifierSchema
    })
    .strict()
]);

const textAssistantBlockSchema = z
  .object({
    kind: z.literal('text'),
    blockId: identifierSchema,
    phase: z.enum(['delta', 'end']),
    text: z.string().optional()
  })
  .strict();

const reasoningAssistantBlockSchema = z
  .object({
    kind: z.literal('reasoning'),
    blockId: identifierSchema,
    phase: z.enum(['delta', 'end']),
    text: z.string().optional()
  })
  .strict();

export const toolCallAssistantBlockSchema = z
  .object({
    kind: z.literal('tool_call'),
    blockId: identifierSchema,
    callId: identifierSchema,
    name: identifierSchema,
    phase: z.enum(['start', 'progress', 'end', 'error']),
    input: z.json().optional(),
    output: z.json().optional(),
    error: z.json().optional()
  })
  .strict();

export const chatAssistantBlockSchema = z.discriminatedUnion('kind', [
  textAssistantBlockSchema,
  reasoningAssistantBlockSchema,
  toolCallAssistantBlockSchema
]);

export const hookRunSummarySchema = z
  .object({
    runId: identifierSchema,
    handlerId: identifierSchema,
    event: z.enum(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd']),
    status: z.enum(['skipped', 'running', 'completed', 'failed', 'blocked']),
    durationMs: z.number().nonnegative().nullable(),
    message: z.string().nullable(),
    additionalContext: z.string().nullable(),
    requestContinue: z.string().nullable(),
    commandDisplay: z.string()
  })
  .strict();

export const subagentIdentitySchema = z
  .object({
    subagentId: identifierSchema,
    parentSubagentId: identifierSchema.nullable(),
    name: identifierSchema,
    depth: z.number().int().nonnegative(),
    path: z.array(identifierSchema),
    execution: z.enum(['sync', 'async']),
    taskInput: z.string().nullable(),
    asyncTaskId: identifierSchema.optional()
  })
  .strict();

export const asyncTaskStatusSchema = z.enum([
  'pending',
  'running',
  'success',
  'error',
  'cancelled',
  'timeout',
  'interrupted'
]);

export const subagentEventPayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('started') }).strict(),
  z.object({ kind: z.literal('assistant_block'), block: chatAssistantBlockSchema }).strict(),
  z.object({ kind: z.literal('tool_call'), block: toolCallAssistantBlockSchema }).strict(),
  z
    .object({
      kind: z.literal('async_status'),
      status: asyncTaskStatusSchema,
      checkedAt: timestampSchema.optional()
    })
    .strict(),
  z.object({ kind: z.literal('completed'), summary: z.string().nullable() }).strict(),
  z.object({ kind: z.literal('failed'), error: z.string() }).strict(),
  z.object({ kind: z.literal('cancelled'), reason: z.string().optional() }).strict()
]);

export const subagentTaskEventPayloadSchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    identity: subagentIdentitySchema,
    event: subagentEventPayloadSchema
  })
  .strict();

export const guardrailTaskEventPayloadSchema = z
  .object({
    nudgeKind: identifierSchema,
    content: z.string(),
    tier: z.number().int().nonnegative().optional(),
    toolCallId: identifierSchema.optional(),
    toolName: identifierSchema.optional()
  })
  .strict();

const approvalRequestedPayloadSchema = hitlRequestSchema.extend({
  interruptId: identifierSchema
});

export const approvalDecisionPayloadSchema = z
  .object({
    interruptId: identifierSchema,
    decisions: z.array(hitlResumeDecisionSchema)
  })
  .strict();

const humanQuestionRequestedPayloadSchema = z
  .object({
    interruptId: identifierSchema,
    question: z.string(),
    context: z.string().nullable(),
    suggestedResponses: z.array(z.string())
  })
  .strict();

export const humanQuestionAnsweredPayloadSchema = z
  .object({
    interruptId: identifierSchema,
    answer: z.string()
  })
  .strict();

const backgroundTaskCreatedPayloadSchema = z
  .object({
    taskId: identifierSchema,
    goal: z.string(),
    status: identifierSchema
  })
  .strict();

const backgroundTaskStatusPayloadSchema = z
  .object({
    taskId: identifierSchema,
    status: identifierSchema
  })
  .strict();

export const toolCallTaskEventPayloadSchema = z
  .object({
    name: identifierSchema,
    status: z.enum(['start', 'progress', 'end', 'error']),
    input: z.json().optional(),
    output: z.json().optional(),
    error: z.json().optional()
  })
  .strict();

const taskEventBaseShape = {
  id: identifierSchema,
  threadId: identifierSchema,
  runId: identifierSchema,
  createdAt: timestampSchema,
  sequence: z.number().int().positive().optional()
} as const;

function taskEvent<const TType extends string, TPayload extends z.ZodType>(type: TType, payload: TPayload) {
  return z.object({ ...taskEventBaseShape, type: z.literal(type), payload }).strict();
}

const structuredTaskEventSchemas = [
  taskEvent('message', messageTaskEventPayloadSchema),
  taskEvent('assistant_block', chatAssistantBlockSchema),
  taskEvent('tool_call', toolCallTaskEventPayloadSchema),
  taskEvent('subagent_event', subagentTaskEventPayloadSchema),
  taskEvent('hook_started', hookRunSummarySchema),
  taskEvent('hook_completed', hookRunSummarySchema),
  taskEvent('guardrail_nudge', guardrailTaskEventPayloadSchema),
  taskEvent('approval_requested', approvalRequestedPayloadSchema),
  taskEvent('approval_decision', approvalDecisionPayloadSchema),
  taskEvent('human_question_requested', humanQuestionRequestedPayloadSchema),
  taskEvent('human_question_answered', humanQuestionAnsweredPayloadSchema),
  taskEvent('background_task_created', backgroundTaskCreatedPayloadSchema),
  taskEvent('background_task_paused', backgroundTaskStatusPayloadSchema),
  taskEvent('background_task_resumed', backgroundTaskStatusPayloadSchema),
  taskEvent('background_task_cancelled', backgroundTaskStatusPayloadSchema)
] as const;

const genericTaskEventTypes = [
  'agent_update',
  'plan',
  'mcp_call',
  'skill_loaded',
  'agent_execute',
  'file_change',
  'git_operation',
  'memory_operation',
  'recovery_point',
  'context_manifest',
  'long_running_promoted',
  'diagnostic',
  'verification',
  'error',
  'summary'
] as const;

const genericTaskEventSchemas = genericTaskEventTypes.map((type) => taskEvent(type, jsonObjectSchema));

export const taskEventSchema = z.discriminatedUnion('type', [
  ...structuredTaskEventSchemas,
  ...genericTaskEventSchemas
]);

function agentTaskEventPayload<const TType extends string, TPayload extends z.ZodType>(type: TType, payload: TPayload) {
  return z
    .object({
      runId: identifierSchema,
      threadId: identifierSchema,
      type: z.literal(type),
      payload
    })
    .strict();
}

export const agentTaskEventPayloadSchema = z.discriminatedUnion('type', [
  agentTaskEventPayload('assistant_block', chatAssistantBlockSchema),
  agentTaskEventPayload('tool_call', toolCallTaskEventPayloadSchema),
  agentTaskEventPayload('guardrail_nudge', guardrailTaskEventPayloadSchema),
  agentTaskEventPayload('subagent_event', subagentTaskEventPayloadSchema),
  agentTaskEventPayload('hook_started', hookRunSummarySchema),
  agentTaskEventPayload('hook_completed', hookRunSummarySchema),
  agentTaskEventPayload('approval_requested', approvalRequestedPayloadSchema),
  agentTaskEventPayload('approval_decision', approvalDecisionPayloadSchema)
]);

export const persistedTaskEventSchema = taskEventSchema.and(
  z.object({ sequence: z.number().int().positive() })
);

export type TaskEventContract = z.infer<typeof taskEventSchema>;
export type ChatPersistedAttachment = z.infer<typeof chatPersistedAttachmentSchema>;
export type ChatAssistantBlock = z.infer<typeof chatAssistantBlockSchema>;
export type ToolCallAssistantBlock = z.infer<typeof toolCallAssistantBlockSchema>;
export type HookRunSummaryContract = z.infer<typeof hookRunSummarySchema>;
export type SubagentIdentity = z.infer<typeof subagentIdentitySchema>;
export type SubagentEventPayload = z.infer<typeof subagentEventPayloadSchema>;
export type MessageTaskEvent = Extract<TaskEventContract, { type: 'message' }>;
export type SubagentTaskEventPayload = z.infer<typeof subagentTaskEventPayloadSchema>;
export type GuardrailTaskEventPayload = z.infer<typeof guardrailTaskEventPayloadSchema>;
