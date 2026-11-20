import {z} from 'zod';

const fact = z.string().trim().min(1).max(1000);
/** Unknown is explicit; extraction must never fill missing experimental facts. */
export const scientificExperimentSchema = z.object({
  method: fact, dataset: fact, metric: fact,
  value: z.union([z.number().finite(), z.literal('unknown')]),
  unit: fact, baseline: fact, conditions: fact,
  finding: z.enum(['improves', 'no_improvement', 'worsens', 'unknown'])
}).strict();
export const unknownExperiment: z.infer<typeof scientificExperimentSchema> = {
  method: 'unknown', dataset: 'unknown', metric: 'unknown', value: 'unknown',
  unit: 'unknown', baseline: 'unknown', conditions: 'unknown', finding: 'unknown'
};
const id = z.string().trim().min(1);
export const claimComparisonToolSchema = z.object({
  leftClaimId: id, rightClaimId: id,
  expectedLeftVersion: z.number().int().positive(), expectedRightVersion: z.number().int().positive()
}).strict().refine(value => value.leftClaimId !== value.rightClaimId, 'Two distinct claims required');
export const claimComparisonRequestSchema = claimComparisonToolSchema.safeExtend({projectId: id});
const boundClaim = z.object({
  claimId: id, version: z.number().int().positive(), claimHash: z.string(),
  evidenceIds: id.array(), experiment: scientificExperimentSchema
}).strict();
export const claimComparisonSchema = z.object({
  left: boundClaim, right: boundClaim,
  outcome: z.enum(['condition_difference', 'undetermined', 'comparable', 'conflict_candidate']),
  differences: z.string().array(), missing: z.string().array(),
  suggestedRelation: z.literal('contradicts').nullable(),
  reviewStatus: z.literal('unreviewed')
}).strict();
export type ScientificExperiment = z.infer<typeof scientificExperimentSchema>;
export type ClaimComparison = z.infer<typeof claimComparisonSchema>;
