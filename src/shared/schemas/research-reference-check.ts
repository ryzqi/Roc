import {z} from 'zod';
import {literatureReviewSchema} from './literature-review';

export const referenceCheckRequestSchema = z.object({
  projectId: z.string().min(1), titleSearch: z.boolean().optional(), ids: z.array(z.string().min(1)).min(1).max(10)
    .refine(ids => new Set(ids).size === ids.length, 'research_library_selection_duplicate')
}).strict();
export const referenceMetadataSchema = z.object({doi: z.string().nullable(), title: z.string(),
  authors: z.array(z.string()), year: z.number().int().nullable()}).strict();
const field = z.enum(['match', 'different', 'unknown']);
export const referenceCheckReportSchema = z.object({
  projectId: z.string(), checkedAt: z.string(), algorithm: z.literal('roc-reference-check-v1'),
  results: z.array(z.object({
    id: z.string(), revision: z.number().int(), citationKey: z.string(), inputHash: z.string(),
    input: referenceMetadataSchema,
    observations: z.array(z.object({
      source: z.enum(['crossref', 'openalex']), lookup: z.enum(['doi', 'title_candidate']).optional(), url: z.string().nullable(),
      status: z.enum(['checked', 'unknown', 'error']), errorCode: z.string().nullable(),
      fetchedAt: z.string().nullable(), responseHash: z.string().nullable(), cache: z.enum(['hit', 'miss']).nullable(),
      metadata: referenceMetadataSchema.nullable(), review: literatureReviewSchema,
      identity: z.enum(['doi_match', 'doi_mismatch', 'unresolved']),
      fields: z.object({title: field, authors: field, year: field}).strict(),
      titleSimilarity: z.number().min(0).max(1).nullable(),
      verdict: z.enum(['consistent', 'needs_review', 'unknown'])
    }).strict())
  }).strict())
}).strict();
export type ReferenceMetadata = z.infer<typeof referenceMetadataSchema>;
export type ReferenceCheckReport = z.infer<typeof referenceCheckReportSchema>;
