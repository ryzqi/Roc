import {z} from 'zod';
import {literatureCandidateSchema, literatureSearchInputSchema, literatureSearchResultSchema,
  literatureSearchStrategyReceiptSchema} from './literature-import';

export const literatureRankedRecordSchema = literatureCandidateSchema.shape.origins.element.pick({
  record: true, rank: true, identifiers: true, rawIdentifiers: true, review: true
});
export const literatureSearchPoolBodySchema = z.object({
  schemaVersion: z.literal(1), executionId: z.string().min(1), createdAt: z.string(),
  request: literatureSearchInputSchema, strategy: literatureSearchStrategyReceiptSchema.nullable(),
  status: z.enum(['complete', 'partial', 'failed']),
  sources: literatureSearchResultSchema.shape.sources, records: z.array(literatureRankedRecordSchema)
}).strict();
export const literatureSearchPoolSchema = literatureSearchPoolBodySchema.extend({
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u)
});
export const literatureSearchPoolPageSchema = literatureSearchPoolSchema.extend({
  total: z.number().int().nonnegative(), nextOffset: z.number().int().nullable()
});
export const literatureReadPoolSchema = z.object({
  executionId: z.string().min(1), offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(30).default(20), projectId: z.string().min(1).nullable().optional()
}).strict();
export type LiteratureSearchPool = z.infer<typeof literatureSearchPoolSchema>;
export type RankedLiteratureRecord = z.infer<typeof literatureRankedRecordSchema>;
