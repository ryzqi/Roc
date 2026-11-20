import {z} from 'zod';
import {paperStructureSchema, scientificBlockRoleSchema} from './research-paper-structure';

export const paperSemanticModelVersion = 'roc-paper-semantic-model/1';
export const paperSemanticPolicy = {
  version: 'roc-paper-semantic-sampling/1',
  maxBlocks: 8, sampleFraction: .25, maxBlockTokens: 1000, maxInputTokens: 6000,
  maxOutputTokens: 1500, timeoutMs: 30_000, ruleThreshold: .8, modelThreshold: .75
} as const;
export const paperSemanticModelOutputSchema = z.object({
  blocks: z.array(z.object({
    blockId: z.string().min(1),
    roles: z.array(z.object({role: scientificBlockRoleSchema, confidence: z.number().min(0).max(1)}).strict()).max(9)
  }).strict()).max(paperSemanticPolicy.maxBlocks)
}).strict();
const tokenCount = z.number().int().nonnegative().nullable();
export const paperSemanticEnrichmentSchema = z.object({
  version: z.literal(1), classifierVersion: z.literal(paperSemanticModelVersion),
  policyVersion: z.literal(paperSemanticPolicy.version),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  structure: paperStructureSchema,
  observation: z.object({
    status: z.enum(['classified', 'no_candidates', 'unavailable', 'failed', 'timed_out']),
    eligibleBlocks: z.number().int().nonnegative(),
    selectedBlockIds: z.array(z.string().min(1)).max(paperSemanticPolicy.maxBlocks),
    calls: z.number().int().min(0).max(1),
    inputBudgetTokens: z.number().int().min(0).max(paperSemanticPolicy.maxInputTokens),
    inputTokens: tokenCount, outputTokens: tokenCount,
    providerId: z.string().min(1).max(300).nullable(), modelId: z.string().min(1).max(300).nullable(),
    durationMs: z.number().nonnegative(),
    failureCode: z.enum(['research_semantic_unavailable', 'research_semantic_model_failed',
      'research_semantic_output_invalid', 'research_semantic_timeout']).nullable()
  }).strict()
}).strict().superRefine((value, ctx) => {
  const o = value.observation;
  if (new Set(o.selectedBlockIds).size !== o.selectedBlockIds.length ||
      (['failed', 'timed_out', 'unavailable'].includes(o.status)) !== (o.failureCode !== null) ||
      o.selectedBlockIds.length > Math.min(paperSemanticPolicy.maxBlocks, Math.ceil(o.eligibleBlocks * paperSemanticPolicy.sampleFraction)) ||
      (o.status === 'classified' && (o.calls !== 1 || !o.providerId || !o.modelId || !o.selectedBlockIds.length)) ||
      (o.status === 'no_candidates' && (o.calls !== 0 || o.selectedBlockIds.length !== 0)) ||
      (o.status === 'unavailable' && (o.calls !== 0 || o.failureCode !== 'research_semantic_unavailable' || !o.selectedBlockIds.length)) ||
      (o.status === 'failed' && (o.calls !== 1 || !['research_semantic_model_failed', 'research_semantic_output_invalid'].includes(o.failureCode ?? ''))) ||
      (o.status === 'timed_out' && (o.calls !== 1 || o.failureCode !== 'research_semantic_timeout'))) {
    ctx.addIssue({code: 'custom', message: 'research_semantic_observation_invalid'});
  }
});
export type PaperSemanticEnrichment = z.infer<typeof paperSemanticEnrichmentSchema>;
