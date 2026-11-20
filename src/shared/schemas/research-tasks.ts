import { z } from 'zod';
import { executionEventEnvelopeSchema } from './execution-events';
import { executionNodeBindingSchema, executionOriginSchema, frozenExecutionInputsSchema } from './execution';

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
  schemaVersion: z.literal(3),
  id,
  projectId: id,
  goal: z.string().trim().min(1).max(10000),
  rootAgentRunId: id.nullable(),
  status: researchTaskStatusSchema,
  statusReason: z.string().min(1).max(256).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
}).strict();
export const researchTaskExecutionSchema = z.object({
  schemaVersion: z.literal(3),
  nodeBinding: executionNodeBindingSchema,
  origin: executionOriginSchema,
  frozenInputs: frozenExecutionInputsSchema.nullable(),
  associationState: z.enum(['pending', 'confirmed', 'historical', 'failed']),
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

export const researchTaskEventSchema = executionEventEnvelopeSchema.extend({
  eventType: z.enum(['task_created', 'task_status', 'execution_linked', 'call_linked', 'call_reserved', 'call_settled', 'call_unknown',
    'plan_approved', 'source_invalidated', 'claim_reviewed', 'quality_gate', 'effect_committed', 'node_claimed', 'lease_expired', 'node_output', 'node_accepted']),
  payload: z.object({
  taskId: id,
  executionKind: researchExecutionKindSchema.nullable(),
  executionId: id.nullable(),
  callId: id.nullable(),
  state: z.string().nullable(),
  reason: z.string().nullable(),
  detail: z.record(z.string(), z.unknown()).optional()
  }).strict()
}).strict();
export const researchTaskEventsRequestSchema = researchTaskRequestSchema.extend({
  afterSequence: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(200)
}).strict();
export const researchTaskEventsPageSchema = z.object({
  events: z.array(researchTaskEventSchema),
  nextSequence: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  gap: z.object({afterSequence: z.number().int().nonnegative(), firstAvailableSequence: z.number().int().positive()}).strict().nullable()
}).strict();
export type ResearchTaskEvent = z.infer<typeof researchTaskEventSchema>;
export const researchTaskUpdatedSchema = researchTaskRequestSchema;
export type ResearchTaskUpdated = z.infer<typeof researchTaskUpdatedSchema>;
