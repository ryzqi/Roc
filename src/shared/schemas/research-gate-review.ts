import {z} from 'zod';
import {researchStageSchema} from './research';
import {researchArtifactLinksSchema} from './research-artifact-inspector';
import {researchSearchPlanSchema} from './research-search-plan';

export const researchGateReviewRequestSchema = z.object({
  projectId: z.string().min(1), expectedStage: researchStageSchema, artifactId: z.string().min(1).nullable()
}).strict();
export const researchGateReviewContextSchema = z.object({
  projectId: z.string().min(1), stage: researchStageSchema, artifactLinks: researchArtifactLinksSchema,
  searchPlan: researchSearchPlanSchema.nullable(),
  searchPlanHash: z.string().regex(/^[a-f0-9]{64}$/u).nullable(), readAt: z.string()
}).strict().refine(value => value.artifactLinks.every(link => link.projectId === value.projectId),
  'Gate artifacts must belong to the reviewed project.').refine(value => value.stage === 'discovery'
  ? value.searchPlan !== null && value.searchPlanHash !== null && value.artifactLinks.length === 1
  : value.searchPlan === null && value.searchPlanHash === null, 'Gate search plan scope is invalid.');
export type ResearchGateReviewRequest = z.infer<typeof researchGateReviewRequestSchema>;
export type ResearchGateReviewContext = z.infer<typeof researchGateReviewContextSchema>;
