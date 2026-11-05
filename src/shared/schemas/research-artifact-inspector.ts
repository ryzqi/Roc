import {z} from 'zod';
import {researchArtifactSchema, researchStageStateSchema, researchProvenanceSchema, researchProjectSchema} from './research';
import {researchArtifactContentSchema, researchStageRunSchema} from './research-runs';
import {researchClaimSchema} from './research-evidence';
import {researchProductionInputSchema} from './research-production-inputs';
import {researchInspectedEvidenceSchema} from './research-evidence-source';
import {researchEvidenceRelationSchema} from './research-evidence-relations';
import {researchIdeaCanvasSchema} from './research-ideas';
import {researchIdeaPlanInspectionSchema} from './research-idea-plans';
import {researchIdeaOutcomeHeadSchema} from './research-idea-outcomes';
import {researchCitationReviewHeadSchema} from './research-citation-reviews';
import {researchConsistencyHeadSchema} from './research-consistency';
import {researchResponseMatrixHeadSchema} from './research-response-matrix';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const researchArtifactInspectRequestSchema = z.object({
  projectId: z.string().min(1), artifactId: z.string().min(1), expectedVersion: hash.nullable()
}).strict();
export const researchArtifactLinkSchema = researchArtifactInspectRequestSchema.extend({
  expectedVersion: hash, title: z.string().min(1), kind: researchArtifactSchema.shape.kind
});
export const researchArtifactLinksSchema = researchArtifactLinkSchema.array().min(1).refine(
  links => new Set(links.map(link => link.artifactId)).size === links.length, 'Artifact links must be unique.');
export const researchArtifactOriginSchema = researchStageRunSchema.pick({
  id: true, taskId: true, stage: true, status: true, providerId: true, modelId: true,
  modelVersion: true, skillHash: true, inputArtifactIds: true
});
export const researchArtifactInspectionBodySchema = z.object({
  artifact: researchArtifactSchema, projectStatus: researchProjectSchema.shape.status,
  currentStage: researchStageStateSchema.shape.stage, stage: researchStageStateSchema,
  content: researchArtifactContentSchema.nullable(), origin: researchArtifactOriginSchema.nullable(),
  claims: researchClaimSchema.array(), evidence: researchInspectedEvidenceSchema.array(),
  relations: researchEvidenceRelationSchema.array(),
  ideaCanvas: researchIdeaCanvasSchema.nullable(), ideaPlan: researchIdeaPlanInspectionSchema.nullable(),
  ideaOutcomes: researchIdeaOutcomeHeadSchema.array(),
  citationReviews: researchCitationReviewHeadSchema.array(),
  consistencyReviews: researchConsistencyHeadSchema.array(),
  responseMatrix: researchResponseMatrixHeadSchema.nullable(),
  production: researchProductionInputSchema.shape.source.nullable(),
  provenance: researchProvenanceSchema.array(), availableActions: z.enum(['return_to_task', 'review_gate']).array().max(2)
}).strict();
export const researchArtifactInspectionSchema = researchArtifactInspectionBodySchema.extend({version: hash});
export const researchArtifactInspectResultSchema = z.object({
  status: z.enum(['current', 'stale']), snapshot: researchArtifactInspectionSchema, readAt: z.string()
}).strict();
export type ResearchArtifactInspectRequest = z.infer<typeof researchArtifactInspectRequestSchema>;
export type ResearchArtifactInspectResult = z.infer<typeof researchArtifactInspectResultSchema>;
