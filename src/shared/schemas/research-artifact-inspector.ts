import {z} from 'zod';
import {researchArtifactSchema, researchStageStateSchema, researchProvenanceSchema, researchProjectSchema} from './research';
import {researchArtifactContentSchema, researchStageRunSchema} from './research-runs';
import {researchClaimSchema, researchEvidenceSchema} from './research-evidence';
import {researchProductionInputSchema} from './research-production-inputs';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const researchArtifactInspectRequestSchema = z.object({
  projectId: z.string().min(1), artifactId: z.string().min(1), expectedVersion: hash.nullable()
}).strict();
export const researchArtifactLinkSchema = researchArtifactInspectRequestSchema.extend({
  expectedVersion: hash, title: z.string().min(1), kind: researchArtifactSchema.shape.kind
});
export const researchArtifactLinksSchema = researchArtifactLinkSchema.array().min(1).refine(
  links => new Set(links.map(link => link.artifactId)).size === links.length, 'Artifact links must be unique.');
export const researchInspectedEvidenceSchema = z.object({
  evidence: researchEvidenceSchema, referenceStatus: z.enum(['recorded', 'superseded']),
  invalidatedAt: z.string().nullable()
}).strict();
export const researchArtifactOriginSchema = researchStageRunSchema.pick({
  id: true, taskId: true, stage: true, status: true, providerId: true, modelId: true,
  modelVersion: true, skillHash: true, inputArtifactIds: true
});
export const researchArtifactInspectionBodySchema = z.object({
  artifact: researchArtifactSchema, projectStatus: researchProjectSchema.shape.status,
  currentStage: researchStageStateSchema.shape.stage, stage: researchStageStateSchema,
  content: researchArtifactContentSchema.nullable(), origin: researchArtifactOriginSchema.nullable(),
  claims: researchClaimSchema.array(), evidence: researchInspectedEvidenceSchema.array(),
  production: researchProductionInputSchema.shape.source.nullable(),
  provenance: researchProvenanceSchema.array(), availableActions: z.enum(['return_to_task', 'review_gate']).array().max(2)
}).strict();
export const researchArtifactInspectionSchema = researchArtifactInspectionBodySchema.extend({version: hash});
export const researchArtifactInspectResultSchema = z.object({
  status: z.enum(['current', 'stale']), snapshot: researchArtifactInspectionSchema, readAt: z.string()
}).strict();
export type ResearchArtifactInspectRequest = z.infer<typeof researchArtifactInspectRequestSchema>;
export type ResearchArtifactInspectResult = z.infer<typeof researchArtifactInspectResultSchema>;
export type ResearchInspectedEvidence = z.infer<typeof researchInspectedEvidenceSchema>;
