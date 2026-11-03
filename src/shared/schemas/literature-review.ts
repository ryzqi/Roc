import {z} from 'zod';

/** Provider declarations are observations, never a credibility score. */
export const literatureReviewSchema = z.object({
  publicationType: z.string().min(1).nullable(),
  copies: z.array(z.object({
    field: z.string().min(1), locationUrl: z.string().nullable(),
    version: z.string().nullable(), license: z.string().nullable()
  }).strict()),
  retraction: z.object({
    status: z.enum(['retracted', 'not_reported', 'unknown']), field: z.string().nullable()
  }).strict(),
  updates: z.array(z.object({type: z.string().min(1), doi: z.string().min(1),
    label: z.string(), source: z.string().min(1)}).strict())
}).strict();
export const literatureReviewRecordSchema = z.object({
  metadataHash: z.string().regex(/^[a-f0-9]{64}$/u), executionId: z.string().min(1),
  source: z.string().min(1), externalId: z.string().min(1), rank: z.number().int().positive(),
  retrievedAt: z.string(), review: literatureReviewSchema
}).strict();
export const literatureReadReviewsSchema = z.object({
  id: z.string().min(1), offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(50).default(20)
}).strict();
export const literatureReviewRecordsResultSchema = z.object({
  itemId: z.string().min(1), records: z.array(literatureReviewRecordSchema),
  total: z.number().int().nonnegative(), nextOffset: z.number().int().nullable()
}).strict();
export type LiteratureReview = z.infer<typeof literatureReviewSchema>;
export type LiteratureReviewRecord = z.infer<typeof literatureReviewRecordSchema>;
