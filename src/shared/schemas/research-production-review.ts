import {z} from 'zod';
import {researchArtifactInspectRequestSchema} from './research-artifact-inspector';
import {researchProductionInputReadSchema} from './research-production-inputs';

export const researchProductionReviewRequestSchema = researchArtifactInspectRequestSchema.extend({
  expectedVersion: z.string().regex(/^[a-f0-9]{64}$/u)
}).strict();
export const researchProductionReviewReadSchema = researchProductionReviewRequestSchema.extend({
  ...researchProductionInputReadSchema.pick({area: true, path: true}).shape,
  expectedFileHash: z.string().regex(/^[a-f0-9]{64}$/u)
}).strict();
export type ResearchProductionReviewRequest = z.infer<typeof researchProductionReviewRequestSchema>;
export type ResearchProductionReviewRead = z.infer<typeof researchProductionReviewReadSchema>;
