import { z } from 'zod';
import type {
  ChatRunActivityBlock,
  ChatRunState,
  ChatRunSubagentBlock,
  ChatRunSubagentNode
} from '../chat-run-state';
import { chatImageAttachmentMediaTypes } from '../constants/chat';
import { taskCriterionSchema, taskAcceptanceSchema } from './task-acceptance';

import {
  enabledCapabilitiesSchema,
  runExecutionModeSchema,
  runBudgetStatusSchema,
  workflowHintSchema
} from './agent';
import {
  hitlRequestSchema,
  hitlResumeDecisionSchema
} from './hitl';
import {
  asyncTaskStatusSchema,
  chatAssistantBlockSchema,
  chatPersistedAttachmentSchema,
  hookRunSummarySchema,
  subagentEventPayloadSchema,
  subagentIdentitySchema,
  toolCallAssistantBlockSchema
} from './task-event';

const identifierSchema = z.string().trim().min(1);

export const chatRunModeSchema = z.enum(['chat', 'task', 'plan']);

export const chatImageAttachmentMediaTypeSchema = z.enum(chatImageAttachmentMediaTypes);

export const chatImageAttachmentSchema = z
  .object({
    kind: z.literal('image'),
    source: z.enum(['file', 'clipboard', 'drop']),
    name: identifierSchema,
    mediaType: chatImageAttachmentMediaTypeSchema,
    sizeBytes: z.number().int().positive(),
    path: identifierSchema.optional(),
    data: identifierSchema.optional()
  })
  .strict()
  .refine(
    (value) => (value.path === undefined) !== (value.data === undefined),
    'Image attachment must provide exactly one source.'
  );

export const chatValidatedImageAttachmentSchema = chatPersistedAttachmentSchema.extend({
  base64: z.string()
});

export const chatTodoItemSchema = z
  .object({
    content: z.string(),
    status: z.enum(['pending', 'in_progress', 'completed'])
  })
  .strict();

export const chatApprovalInterruptPayloadSchema = z
  .object({
    kind: z.literal('approval'),
    request: hitlRequestSchema
  })
  .strict();

export const chatQuestionInterruptPayloadSchema = z
  .object({
    kind: z.literal('question'),
    question: z.string(),
    context: z.string().optional(),
    suggestedResponses: z.array(z.string()).optional()
  })
  .strict();

export const chatInterruptPayloadSchema = z.discriminatedUnion('kind', [
  chatApprovalInterruptPayloadSchema,
  chatQuestionInterruptPayloadSchema
]);

export const chatPendingApprovalSchema = hitlRequestSchema.extend({
  kind: z.literal('approval'),
  interruptId: identifierSchema
});

export const chatPendingQuestionSchema = chatQuestionInterruptPayloadSchema.extend({
  interruptId: identifierSchema
});

export const chatPendingInterruptSchema = z.discriminatedUnion('kind', [
  chatPendingApprovalSchema,
  chatPendingQuestionSchema
]);

const approvalResumeRunRequestSchema = z
  .object({
    kind: z.literal('approval'),
    runId: identifierSchema,
    threadId: identifierSchema,
    interruptId: identifierSchema,
    decisions: z.array(hitlResumeDecisionSchema).min(1)
  })
  .strict();

const questionResumeRunRequestSchema = z
  .object({
    kind: z.literal('question'),
    runId: identifierSchema,
    threadId: identifierSchema,
    interruptId: identifierSchema,
    answer: identifierSchema
  })
  .strict();

export const chatResumeRunRequestSchema = z.discriminatedUnion('kind', [
  approvalResumeRunRequestSchema,
  questionResumeRunRequestSchema,
  z.object({ kind: z.literal('checkpoint'), runId: identifierSchema, threadId: identifierSchema }).strict()
]);

export const chatResumeRunResultSchema = z
  .object({
    runId: z.string(),
    threadId: z.string(),
    resumedAt: z.string()
  })
  .strict();

const rocHookRunEventSchemas = [
  z.object({ type: z.literal('hook_started'), runId: z.string(), hook: hookRunSummarySchema }).strict(),
  z.object({ type: z.literal('hook_completed'), runId: z.string(), hook: hookRunSummarySchema }).strict()
] as const;

export const chatRunEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('run_started'),
      runId: z.string(),
      mode: runExecutionModeSchema,
      threadId: z.string().nullable(),
      providerId: z.string(),
      modelId: z.string(),
      createdAt: z.string()
    })
    .strict(),
  z.object({
    type: z.literal('run_budget'),
    runId: z.string(),
    threadId: z.string().nullable(),
    budget: runBudgetStatusSchema
  }).strict(),
  z.object({ type: z.literal('assistant_block'), runId: z.string(), block: chatAssistantBlockSchema }).strict(),
  z
    .object({
      type: z.literal('run_interrupted'),
      runId: z.string(),
      threadId: z.string().nullable(),
      interruptId: z.string(),
      payload: chatInterruptPayloadSchema
    })
    .strict(),
  z
    .object({
      type: z.literal('run_resumed'),
      runId: z.string(),
      threadId: z.string().nullable(),
      interruptId: z.string()
    })
    .strict(),
  z.object({ type: z.literal('run_continued'), runId: z.string(), threadId: z.string(), continuedAt: z.string() }).strict(),
  z
    .object({
      type: z.literal('run_recovering'),
      runId: z.string(),
      threadId: z.string().nullable(),
      code: z.string(),
      message: z.string(),
      attempt: z.number().int().nonnegative(),
      nextRetryAt: z.string(),
      resetOutput: z.boolean().optional()
    })
    .strict(),
  z
    .object({
      type: z.literal('run_recovered'),
      runId: z.string(),
      threadId: z.string().nullable(),
      attempt: z.number().int().nonnegative(),
      recoveredAt: z.string()
    })
    .strict(),
  z.object({ type: z.literal('todo_event'), runId: z.string(), todos: z.array(chatTodoItemSchema) }).strict(),
  z
    .object({
      type: z.literal('subagent_event'),
      runId: z.string(),
      sequence: z.number().int().nonnegative(),
      identity: subagentIdentitySchema,
      event: subagentEventPayloadSchema
    })
    .strict(),
  z
    .object({
      type: z.literal('context_maintenance'),
      runId: z.string(),
      threadId: z.string().nullable(),
      event: z.enum([
        'context_compaction_started',
        'context_tool_result_persisted',
        'context_deterministic_compacted',
        'context_summary_started',
        'context_summary_completed',
        'context_summary_skipped',
        'context_compaction_failed'
      ]),
      mode: runExecutionModeSchema,
      stage: z.enum(['persist', 'deterministic', 'summary']),
      persistedChars: z.number().optional(),
      removedChars: z.number().optional(),
      inputTokens: z.number().optional(),
      budgetTokens: z.number().optional(),
      estimated: z.boolean().optional()
    })
    .strict(),
  z.object({ type: z.literal('task_acceptance'), runId: z.string(), report: taskAcceptanceSchema }).strict(),
  ...rocHookRunEventSchemas,
  z
    .object({
      type: z.literal('run_completed'),
      runId: z.string(),
      threadId: z.string().nullable(),
      providerId: z.string(),
      modelId: z.string(),
      createdAt: z.string(),
      durationMs: z.number(),
      summary: z.string(),
      assistantMessage: z.string()
    })
    .strict(),
  z
    .object({
      type: z.literal('run_cancelled'),
      runId: z.string(),
      threadId: z.string().nullable(),
      reason: z.literal('user_cancelled')
    })
    .strict(),
  z
    .object({
      type: z.literal('run_failed'),
      runId: z.string(),
      threadId: z.string().nullable(),
      code: z.string(),
      diagnostic: z
        .object({
          badKeys: z.array(z.string()).optional(),
          schemaPath: z.string().optional(),
          toolName: z.string().optional()
        })
        .strict()
        .optional(),
      message: z.string(),
      retryable: z.boolean(),
      suggestion: z.string().optional()
    })
    .strict()
]);

export const sequencedChatRunEventSchema = z
  .object({
    runId: z.string(),
    sequence: z.number().int().nonnegative(),
    event: chatRunEventSchema,
    createdAt: z.string()
  })
  .strict();

export const chatRunEventsReplayRequestSchema = z
  .object({
    runId: identifierSchema,
    afterSequence: z.number().int().min(0),
    limit: z.number().int().min(1).max(1_000).optional()
  })
  .strict();

export const chatRunEventsReplayResultSchema = z
  .object({
    runId: z.string(),
    events: z.array(sequencedChatRunEventSchema)
  })
  .strict();

const chatRunActivityBlockSchema: z.ZodType<ChatRunActivityBlock> = z.discriminatedUnion('kind', [
  z.object({ id: z.string(), kind: z.literal('reasoning'), content: z.string() }).strict(),
  z
    .object({
      id: z.string(),
      kind: z.literal('tool_call'),
      callId: z.string(),
      name: z.string(),
      status: z.enum(['start', 'progress', 'end', 'error']),
      input: z.json(),
      output: z.json(),
      error: z.json()
    })
    .strict(),
  z
    .object({
      id: z.string(),
      kind: z.literal('hook_call'),
      event: hookRunSummarySchema.shape.event,
      handlerId: z.string(),
      status: hookRunSummarySchema.shape.status,
      durationMs: z.number().nullable(),
      message: z.string().nullable(),
      additionalContext: z.string().nullable(),
      requestContinue: z.string().nullable(),
      commandDisplay: z.string()
    })
    .strict(),
  z.object({ id: z.string(), kind: z.literal('task_acceptance'), report: taskAcceptanceSchema }).strict()
]);

const chatRunSubagentBlockSchema: z.ZodType<ChatRunSubagentBlock> = z.discriminatedUnion('kind', [
  z.object({ id: z.string(), kind: z.literal('text'), content: z.string() }).strict(),
  z.object({ id: z.string(), kind: z.literal('reasoning'), content: z.string() }).strict(),
  z
    .object({
      id: z.string(),
      kind: z.literal('tool_call'),
      callId: z.string(),
      name: z.string(),
      status: z.enum(['start', 'progress', 'end', 'error']),
      input: z.json(),
      output: z.json(),
      error: z.json()
    })
    .strict()
]);

const chatRunSubagentNodeSchema: z.ZodType<ChatRunSubagentNode> = z.lazy(() =>
  z
    .object({
      identity: subagentIdentitySchema,
      status: z.enum(['started', 'running', 'completed', 'failed', 'cancelled']),
      summary: z.string().nullable(),
      error: z.string().nullable(),
      blocks: z.array(chatRunSubagentBlockSchema),
      children: z.array(chatRunSubagentNodeSchema)
    })
    .strict()
);

export const chatRunStateSnapshotSchema: z.ZodType<ChatRunState> = z
  .object({
    runId: z.string().nullable(),
    mode: runExecutionModeSchema.nullable(),
    threadId: z.string().nullable(),
    providerId: z.string().nullable(),
    modelId: z.string().nullable(),
    createdAt: z.string().nullable(),
    status: z.enum(['idle', 'running', 'recovering', 'waiting_user', 'completed', 'cancelled', 'failed']),
    historyComplete: z.boolean(),
    assistantMessage: z.string(),
    activityBlocks: z.array(chatRunActivityBlockSchema),
    durationMs: z.number().nullable(),
    summary: z.string().nullable(),
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
    recoveryAttempt: z.number().int().nonnegative().nullable(),
    retryable: z.boolean(),
    budget: runBudgetStatusSchema.nullable(),
    pendingInterrupts: z.array(chatPendingInterruptSchema),
    resumeBusy: z.boolean(),
    todos: z.array(chatTodoItemSchema),
    subagents: z.array(chatRunSubagentNodeSchema)
  })
  .strict();

export const chatRunEventsSnapshotSchema = z
  .object({
    version: z.literal(1),
    runId: identifierSchema,
    throughSequence: z.number().int().nonnegative(),
    historyComplete: z.boolean(),
    state: chatRunStateSnapshotSchema
  })
  .strict()
  .refine((snapshot) => snapshot.state.runId === snapshot.runId, 'Snapshot run id must match its state.')
  .refine((snapshot) => snapshot.state.historyComplete === snapshot.historyComplete, 'Snapshot completeness must match state.');

const chatRunEventsReplayEventsPageSchema = z
  .object({
    kind: z.literal('events'),
    runId: z.string(),
    events: z.array(sequencedChatRunEventSchema)
  })
  .strict();

const chatRunEventsReplayGapPageSchema = z
  .object({
    kind: z.literal('replay_gap'),
    runId: z.string(),
    requestedAfterSequence: z.number().int().nonnegative(),
    firstAvailableSequence: z.number().int().positive(),
    snapshot: chatRunEventsSnapshotSchema,
    events: z.array(sequencedChatRunEventSchema)
  })
  .strict();

export const chatRunEventsReplayPageSchema = z.discriminatedUnion('kind', [
  chatRunEventsReplayEventsPageSchema,
  chatRunEventsReplayGapPageSchema
]);

export const activeChatRunSchema = z
  .object({
    runId: z.string(),
    threadId: z.string(),
    status: z.enum(['running', 'recovering', 'waiting_user'])
  })
  .strict();

export const chatCorrectRunRequestSchema = z.object({
  runId: identifierSchema,
  submissionId: identifierSchema,
  content: z.string().trim().min(1).max(32000)
}).strict();

export const chatCorrectRunResultSchema = z.object({ sequence: z.number().int().positive() }).strict();

export const chatActiveRunRequestSchema = z
  .object({
    threadId: identifierSchema
  })
  .strict();

export const chatStartRunRequestSchema = z
  .object({
    input: z.string(),
    acceptanceCriteria: z.array(taskCriterionSchema).min(1).max(20).optional(),
    mode: chatRunModeSchema,
    enabledCapabilities: enabledCapabilitiesSchema,
    threadId: z.string().nullable().optional(),
    workflowHint: workflowHintSchema.optional(),
    taskSource: z.enum(['background_schedule', 'workbench']).nullable().optional(),
    workspacePath: z.string().nullable().optional(),
    researchProjectId: identifierSchema.optional(),
    shellAllowedCommands: z.array(identifierSchema).optional(),
    attachments: z.array(chatImageAttachmentSchema).max(4).optional(),
    dispatchKey: identifierSchema.optional(),
    explicitSkillIds: z.array(identifierSchema).optional()
  })
  .strict();

export const chatStartRunIpcRequestSchema = chatStartRunRequestSchema.omit({
  shellAllowedCommands: true,
  taskSource: true,
  workspacePath: true
});

export const chatStartRunResultSchema = z
  .object({
    runId: z.string(),
    mode: chatRunModeSchema,
    threadId: z.string().nullable(),
    providerId: z.string(),
    modelId: z.string(),
    createdAt: z.string()
  })
  .strict();

export const chatCancelRunRequestSchema = z.object({ runId: identifierSchema }).strict();

export const chatCancelRunResultSchema = z
  .object({
    runId: z.string(),
    cancelled: z.boolean()
  })
  .strict();

export type ChatRunMode = z.infer<typeof chatRunModeSchema>;
export type WorkflowHint = z.infer<typeof workflowHintSchema>;
export type ChatImageAttachmentMediaType = z.infer<typeof chatImageAttachmentMediaTypeSchema>;
export type ChatImageAttachment = z.infer<typeof chatImageAttachmentSchema>;
export type ChatValidatedImageAttachment = z.infer<typeof chatValidatedImageAttachmentSchema>;
export type ChatTodoItem = z.infer<typeof chatTodoItemSchema>;
export type ChatToolEventStatus = z.infer<typeof toolCallAssistantBlockSchema>['phase'];
export type SubagentExecution = z.infer<typeof subagentIdentitySchema>['execution'];
export type SubagentStatus = 'started' | 'running' | 'completed' | 'failed' | 'cancelled';
export type ChatApprovalInterruptPayload = z.infer<typeof chatApprovalInterruptPayloadSchema>;
export type ChatQuestionInterruptPayload = z.infer<typeof chatQuestionInterruptPayloadSchema>;
export type ChatInterruptPayload = z.infer<typeof chatInterruptPayloadSchema>;
export type ChatPendingApproval = z.infer<typeof chatPendingApprovalSchema>;
export type ChatPendingQuestion = z.infer<typeof chatPendingQuestionSchema>;
export type ChatPendingInterrupt = z.infer<typeof chatPendingInterruptSchema>;
export type ChatResumeDecision = z.infer<typeof hitlResumeDecisionSchema>;
export type ChatResumeRunRequest = z.infer<typeof chatResumeRunRequestSchema>;
export type ChatResumeRunResult = z.infer<typeof chatResumeRunResultSchema>;
export type ChatRunEvent = z.infer<typeof chatRunEventSchema>;
export type SequencedChatRunEvent = z.infer<typeof sequencedChatRunEventSchema>;
export type ChatRunEventsReplayRequest = z.infer<typeof chatRunEventsReplayRequestSchema>;
export type ChatRunEventsReplayResult = z.infer<typeof chatRunEventsReplayResultSchema>;
export type ChatRunStateSnapshot = z.infer<typeof chatRunStateSnapshotSchema>;
export type ChatRunEventsSnapshot = z.infer<typeof chatRunEventsSnapshotSchema>;
export type ChatRunEventsReplayPage = z.infer<typeof chatRunEventsReplayPageSchema>;
export type ActiveChatRun = z.infer<typeof activeChatRunSchema>;
export type ChatStartRunRequest = z.infer<typeof chatStartRunRequestSchema>;
export type ChatStartRunIpcRequest = z.infer<typeof chatStartRunIpcRequestSchema>;
export type ChatStartRunResult = z.infer<typeof chatStartRunResultSchema>;
export type ChatCancelRunRequest = z.infer<typeof chatCancelRunRequestSchema>;
export type ChatCancelRunResult = z.infer<typeof chatCancelRunResultSchema>;
export { asyncTaskStatusSchema };
