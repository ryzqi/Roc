import { z } from 'zod';

const id = z.string().trim().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const researchExecutionKindSchema = z.enum(['chat', 'stage', 'experiment', 'figure', 'export', 'review_search']);
export const researchTaskRequestSchema = z.object({ taskId: id, projectId: id }).strict();
export const researchTaskContinueRequestSchema = researchTaskRequestSchema.extend({
  runId: id, requestId: id
}).strict();
export const researchTaskStatusSchema = z.enum([
  'active', 'paused', 'waiting_approval', 'interrupted', 'completed', 'cancelled', 'failed'
]);
export const researchTaskSchema = z.object({
  schemaVersion: z.literal(2),
  id,
  projectId: id,
  goal: z.string().trim().min(1).max(10000),
  rootAgentRunId: id.nullable(),
  status: researchTaskStatusSchema,
  statusReason: z.string().min(1).max(256).nullable(),
  deadlineClock: z.literal('continuous'),
  budgetPolicyVersion: z.literal(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
}).strict();
export const researchTaskExecutionSchema = z.object({
  schemaVersion: z.literal(1),
  taskId: id,
  projectId: id,
  kind: researchExecutionKindSchema,
  executionId: id,
  parentKind: researchExecutionKindSchema.nullable(),
  parentExecutionId: id.nullable(),
  associationSource: z.enum(['direct', 'chat_dispatch', 'owned', 'retry', 'review']),
  manifestHash: hash,
  createdAt: z.iso.datetime()
}).strict().refine((value) => (value.parentKind === null) === (value.parentExecutionId === null),
  { message: 'research_task_parent_incomplete' });

export type ResearchTask = z.infer<typeof researchTaskSchema>;
export type ResearchTaskExecution = z.infer<typeof researchTaskExecutionSchema>;

export const researchTaskListRequestSchema = z.object({
  projectId: id, afterTaskId: id.nullable(), limit: z.number().int().min(1).max(100)
}).strict();
export const researchTaskListPageSchema = z.object({
  tasks: z.array(researchTaskSchema), nextTaskId: id.nullable(), hasMore: z.boolean()
}).strict();

export const researchTaskEventSchema = z.object({
  sequence: z.number().int().positive(),
  taskId: id,
  eventType: z.enum(['task_created', 'task_status', 'execution_linked', 'call_linked', 'call_reserved', 'call_settled', 'call_unknown']),
  executionKind: researchExecutionKindSchema.nullable(),
  executionId: id.nullable(),
  callId: id.nullable(),
  state: z.string().nullable(),
  reason: z.string().nullable(),
  createdAt: z.iso.datetime()
}).strict();
export const researchTaskEventsRequestSchema = researchTaskRequestSchema.extend({
  afterSequence: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(200)
}).strict();
export const researchTaskEventsPageSchema = z.object({
  events: z.array(researchTaskEventSchema),
  nextSequence: z.number().int().nonnegative(),
  hasMore: z.boolean()
}).strict();
export type ResearchTaskEvent = z.infer<typeof researchTaskEventSchema>;
export const researchTaskUpdatedSchema = researchTaskRequestSchema;
export type ResearchTaskUpdated = z.infer<typeof researchTaskUpdatedSchema>;
