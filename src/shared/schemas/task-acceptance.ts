import { z } from 'zod';
import { researchStageSchema } from './research';

export const taskCriterionSchema = z.object({
  id: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(2000),
  check: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('artifact_sha256'), path: z.string().min(1).max(1000), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    z.object({ kind: z.literal('research_stage'), stage: researchStageSchema }).strict(),
    z.object({ kind: z.literal('response') }).strict(),
    z.object({ kind: z.literal('unverified') }).strict()
  ])
}).strict();
export const taskContractSchema = z.object({
  contractVersion: z.literal(1),
  objective: z.string(),
  constraints: z.array(z.string()),
  kind: z.enum(['reply', 'task']),
  criteria: z.array(taskCriterionSchema).min(1).max(20)
}).strict().superRefine((contract, context) => {
  const seen = new Set<string>();
  for (const [index, criterion] of contract.criteria.entries()) {
    if (seen.has(criterion.id)) {
      context.addIssue({ code: 'custom', path: ['criteria', index, 'id'], message: 'Task criterion IDs must be unique.' });
    }
    seen.add(criterion.id);
  }
});
export const taskArtifactRefSchema = z.object({ path: z.string().min(1).max(1000), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const taskAcceptanceSchema = z.object({
  taskId: z.string(), runId: z.string(), contractVersion: z.literal(1),
  status: z.enum(['satisfied', 'partial', 'blocked', 'unverified', 'stale']),
  checkpointResumeAvailable: z.boolean().default(false),
  criteria: z.array(z.object({
    id: z.string(), description: z.string(), verdict: z.enum(['passed', 'failed', 'unverified']),
    verifier: z.string(), artifactRefs: z.array(taskArtifactRefSchema),
    checkedAt: z.string(), detail: z.string()
  }).strict()),
  remainingItems: z.array(z.string()), blockedBy: z.array(z.string()), nextSafeAction: z.string()
}).strict();
export const taskHandoffSchema = z.object({
  schemaVersion: z.literal(1), runId: z.string(), threadId: z.string(), taskContractHash: z.string().regex(/^[a-f0-9]{64}$/),
  reason: z.enum(['approval_pending', 'cancelled', 'failed', 'restart']), createdAt: z.string().datetime(),
  acceptanceReport: taskAcceptanceSchema.nullable(),
  pendingEffects: z.array(z.object({ toolCallId: z.string(), status: z.enum(['reserved', 'in_progress', 'unknown']) }).strict()),
  childTasks: z.array(z.object({ childTaskId: z.string(), state: z.enum(['reserved', 'settled', 'unknown']),
    outcomeStatus: z.enum(['completed', 'failed']).nullable(), outcomeHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    failureCode: z.string().max(120).nullable() }).strict()),
  pendingApprovals: z.array(z.string()), checkpointPresent: z.boolean(), nextSafeAction: z.string()
}).strict();
export const childTaskEnvelopeSchema = z.object({
  schemaVersion: z.literal(1), childTaskId: z.string(), parentRunId: z.string(), subagentType: z.string().min(1).max(80),
  taskDescription: z.string().trim().min(1).max(10000), taskDescriptionHash: z.string().regex(/^[a-f0-9]{64}$/),
  permissions: z.array(z.enum(['workspace_read', 'research_read', 'web_read'])),
  maxChildTasks: z.number().int().positive(), maxConcurrentChildTasks: z.number().int().positive(),
  artifactRefs: z.array(taskArtifactRefSchema),
  acceptanceCriteria: z.array(z.object({ id: z.string(), description: z.string() }).strict())
}).strict();
export type TaskContract = z.infer<typeof taskContractSchema>;
export type TaskCriterion = z.infer<typeof taskCriterionSchema>;
export type TaskAcceptance = z.infer<typeof taskAcceptanceSchema>;
export type TaskHandoff = z.infer<typeof taskHandoffSchema>;
export type ChildTaskEnvelope = z.infer<typeof childTaskEnvelopeSchema>;
