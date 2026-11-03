import { z } from 'zod';

const id = z.string().trim().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const researchExecutionKindSchema = z.enum(['chat', 'stage', 'experiment', 'figure', 'export']);
export const researchTaskRequestSchema = z.object({ taskId: id, projectId: id }).strict();
export const researchTaskSchema = z.object({
  schemaVersion: z.literal(1),
  id,
  projectId: id,
  goal: z.string().trim().min(1).max(10000),
  rootAgentRunId: id.nullable(),
  status: z.enum(['active', 'completed', 'cancelled', 'failed']),
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
