import { z } from 'zod';
import { runBudgetStatusSchema } from './agent';
import { researchTaskSchema, researchTaskExecutionSchema } from './research-tasks';
import { researchStageSchema } from './research';
import { taskStatusSchema } from './ipc-core';

const id = z.string().min(1).max(256);
export const researchTaskForChatRequestSchema = z.object({ projectId: id, threadId: id, runId: id }).strict();
export const researchTaskExecutionDiagnosticsSchema = z.object({
  association: researchTaskExecutionSchema,
  status: z.enum([...taskStatusSchema.options, 'queued', 'preparing', 'ready']),
  stage: researchStageSchema.nullable(),
  providerId: id.nullable(),
  modelId: id.nullable(),
  error: z.string().nullable(),
  artifactIds: z.array(id),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable()
}).strict();
export const researchTaskDiagnosticsSchema = z.object({
  task: researchTaskSchema,
  budget: runBudgetStatusSchema,
  executions: z.array(researchTaskExecutionDiagnosticsSchema),
  continuationRunId: id.nullable(),
  canRestoreApproval: z.boolean(),
  externalCost: z.literal('unknown')
}).strict();
export type ResearchTaskDiagnostics = z.infer<typeof researchTaskDiagnosticsSchema>;
export type ResearchTaskExecutionDiagnostics = z.infer<typeof researchTaskExecutionDiagnosticsSchema>;
