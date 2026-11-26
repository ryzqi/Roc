import {z} from 'zod';
import {scientificSearchRequestSchema, scientificSearchResultSchema, scientificCandidateSchema} from './research-scientific-search';
import {scientificQueryIntentSchema} from './research-scientific-query-plan';
import {scientificSourceRefSchema} from './research-scientific-source-ref';
import {researchKnowledgeSearchResultSchema} from './research';

export const scientificQueryRequestSchema = scientificSearchRequestSchema;
/** Each round is an untouched router receipt, suitable for context/evidence reconstruction. */
export const scientificQueryResultSchema = z.object({
  version: z.literal('roc-scientific-query/1'), query: z.string(), projectId: z.string().min(1),
  intent: z.array(scientificQueryIntentSchema), searchSnapshotId: z.string(), retrievalReceiptId: z.string(),
  hits: z.array(scientificCandidateSchema).max(100), sourceRefs: z.array(scientificSourceRefSchema).max(300),
  sourceTargets: z.array(z.object({documentId: z.string(), path: z.string()}).strict()).default([]),
  rounds: z.array(scientificSearchResultSchema).max(3),
  legacy: researchKnowledgeSearchResultSchema.nullable(), degradation: z.array(z.string()),
  stopReason: z.enum(['complete', 'no_gain', 'round_budget', 'candidate_budget', 'time_budget']),
  elapsedMs: z.number().nonnegative()
}).strict();
export type ScientificQueryResult = z.infer<typeof scientificQueryResultSchema>;
