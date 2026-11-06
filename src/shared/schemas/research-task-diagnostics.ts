import { z } from 'zod';
import {taskTelemetrySchema} from './research-task-observability';
import { runBudgetStatusSchema } from './agent';
import { researchTaskSchema, researchTaskExecutionSchema } from './research-tasks';
import { researchStageSchema } from './research';
import { taskStatusSchema } from './ipc-core';

const id = z.string().min(1).max(256);
export const researchTaskForChatRequestSchema = z.object({ projectId: id, threadId: id, runId: id }).strict();
export const researchTaskExecutionDiagnosticsSchema = z.object({
  association: researchTaskExecutionSchema,
  status: z.enum([...taskStatusSchema.options, 'queued', 'preparing', 'ready', 'complete', 'partial', 'cancelling']),
  stage: researchStageSchema.nullable(),
  providerId: id.nullable(),
  modelId: id.nullable(),
  error: z.string().nullable(),
  artifacts: z.strictObject({id, version: z.string().regex(/^[a-f0-9]{64}$/u).nullable(), versionSource: z.literal('current_inspector'), state: z.enum(['present','missing'])}).array(),
  telemetry: taskTelemetrySchema.nullable(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable()
}).strict();
export const researchTaskDiagnosticsSchema = z.object({
  task: researchTaskSchema,
  budget: runBudgetStatusSchema,
  executions: z.array(researchTaskExecutionDiagnosticsSchema),
  continuationRunId: id.nullable(),
  canRestoreApproval: z.boolean(),
  recoveryIssues: z.array(z.enum(['historical_execution_not_resumable', 'research_execution_intent_uncommitted', 'agent_tool_effect_receipt_missing', 'research_stage_inputs_stale', 'research_stage_snapshot_invalid'])),
  eventDelivery: z.object({pending: z.number().int().nonnegative(), failed: z.number().int().nonnegative()}).strict(),
  externalCost: z.literal('unknown')
}).strict();
export type ResearchTaskDiagnostics = z.infer<typeof researchTaskDiagnosticsSchema>;
export type ResearchTaskExecutionDiagnostics = z.infer<typeof researchTaskExecutionDiagnosticsSchema>;
