import {z} from 'zod';

export const literatureIdentifierObservationSchema = z.object({
  kind: z.enum(['doi', 'arxiv', 'pmid']), value: z.string().min(1),
  identity: z.string().min(1), field: z.enum(['ids.doi', 'ids.pmid', 'externalIds.DOI', 'externalIds.ArXiv'])
}).strict();
export const literatureRawIdentifiersSchema = z.record(z.string(), z.json());
export const literatureProviderIdentifierRecordSchema = z.object({
  metadataHash: z.string().regex(/^[a-f0-9]{64}$/u), executionId: z.string().min(1),
  source: z.string().min(1), externalId: z.string().min(1),
  rank: z.number().int().positive(), retrievedAt: z.string(),
  raw: literatureRawIdentifiersSchema, identifiers: z.array(literatureIdentifierObservationSchema)
}).strict();
export const literatureReadIdentifiersSchema = z.object({
  id: z.string().min(1), offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(50).default(20)
}).strict();
export const literatureIdentifierRecordsResultSchema = z.object({
  itemId: z.string().min(1), records: z.array(literatureProviderIdentifierRecordSchema),
  total: z.number().int().nonnegative(), nextOffset: z.number().int().nullable()
}).strict();
export type LiteratureIdentifierObservation = z.infer<typeof literatureIdentifierObservationSchema>;
export type LiteratureProviderIdentifierRecord = z.infer<typeof literatureProviderIdentifierRecordSchema>;
export type LiteratureRawIdentifiers = z.infer<typeof literatureRawIdentifiersSchema>;
