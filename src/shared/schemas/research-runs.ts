import { z } from 'zod';
import { researchArtifactKindSchema, researchStageSchema } from './research';

const id = z.string().trim().min(1);
export const researchModelSelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('app_default') }).strict(),
  z.object({ kind: z.literal('model'), providerId: id, modelId: id }).strict()
]);

export const researchStagePolicySchema = z.object({
  projectId: id,
  stage: researchStageSchema,
  tier: z.enum(['fast', 'balanced', 'deep']),
  model: researchModelSelectionSchema,
  maxSteps: z.number().int().min(2).max(100),
  timeoutMs: z.number().int().min(1000).max(600000)
}).strict();

export const researchStagePoliciesRequestSchema = z.object({ projectId: id }).strict();
export const researchStageRunStartRequestSchema = z.object({
  projectId: id,
  expectedStage: researchStageSchema,
  instruction: z.string().trim().min(1).max(10000),
  requestId: id
}).strict();
export const researchStageRunIdRequestSchema = z.object({ projectId: id, runId: id }).strict();
export const researchStageRunRetryRequestSchema = researchStageRunIdRequestSchema.extend({ requestId: id }).strict();
export const researchStageRunsRequestSchema = z.object({ projectId: id, limit: z.number().int().positive().max(200) }).strict();

export const researchStageOutputSchema = z.object({
  title: z.string().trim().min(1).max(300),
  markdown: z.string().trim().min(1).max(60000),
  claims: z.array(z.object({
    subjectType: z.enum(['claim', 'paragraph', 'figure']),
    content: z.string().trim().min(1).max(20000),
    status: z.enum(['supported', 'hypothesis', 'pending']),
    evidenceIds: z.array(id).max(100)
  }).strict()).max(200),
  sections: z.array(z.object({
    title: z.string().trim().min(1).max(300),
    claimIndexes: z.array(z.number().int().nonnegative()).min(1).max(200)
  }).strict()).max(100),
  verdict: z.enum(['ready', 'revise', 'uncertain'])
}).strict();

export const researchStageRunSchema = z.object({
  id,
  projectId: id,
  stage: researchStageSchema,
  requestId: id,
  parentRunId: id.nullable(),
  retryOfRunId: id.nullable(),
  reviewCycleId: id.nullable(),
  revisionRound: z.number().int().min(0).max(2),
  role: id,
  outputKind: researchArtifactKindSchema,
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']),
  instruction: z.string(),
  skillIds: z.array(id),
  skillHash: id,
  toolNames: z.array(id),
  inputArtifactIds: z.array(id),
  outputArtifactIds: z.array(id),
  policy: researchStagePolicySchema,
  providerId: id.nullable(),
  modelId: id.nullable(),
  modelVersion: id.nullable(),
  error: z.string().nullable(),
  createdAt: id,
  startedAt: id.nullable(),
  endedAt: id.nullable()
}).strict();

export const researchArtifactContentRequestSchema = z.object({ projectId: id, artifactId: id }).strict();
export const researchArtifactContentSchema = z.object({
  artifactId: id,
  projectId: id,
  runId: id,
  output: researchStageOutputSchema,
  createdAt: id
}).strict();

export const researchReviewCycleSchema = z.object({
  projectId: id,
  originArtifactId: id,
  manuscriptArtifactId: id,
  revisionRound: z.number().int().min(0).max(2),
  status: z.enum(['reviewing', 'revision_required', 'accepted']),
  reportArtifactIds: z.array(id),
  updatedAt: id
}).strict();
