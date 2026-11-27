import {z} from 'zod';

const projectId = z.string().min(1).nullable();
const id = z.uuid();
export const researchDocumentImportBatchStartSchema = z.object({
  projectId, requestId: id, libraryItemId: z.string().min(1).nullable(),
  sourcePaths: z.array(z.string().min(1).max(4096)).min(1).max(500)
}).strict();

export const researchDocumentImportBatchRefSchema = z.object({projectId, batchId: id}).strict();
export const researchDocumentImportBatchListSchema = z.object({projectId, offset: z.number().int().nonnegative()}).strict();
export const researchDocumentImportBatchSummarySchema = z.object({
  id, createdAt: z.string(), total: z.number().int().positive(), pending: z.number().int().nonnegative(), failed: z.number().int().nonnegative()
}).strict();
export const researchDocumentImportBatchResultSchema = z.object({
  id, createdAt: z.string(),
  entries: z.array(z.object({
    id: z.string(), filename: z.string(),
    status: z.enum(['queued', 'receiving', 'saved', 'importing', 'waiting_parse', 'parsing', 'parsed', 'duplicate', 'failed']),
    documentId: z.string().nullable(), error: z.string().nullable()
  }).strict())
}).strict();

export type DocumentImportBatch = z.infer<typeof researchDocumentImportBatchResultSchema>;
export type DocumentImportBatchStart = z.infer<typeof researchDocumentImportBatchStartSchema>;
export type DocumentImportBatchRef = z.infer<typeof researchDocumentImportBatchRefSchema>;
