import {z} from 'zod';
import {researchDocumentSchema} from './research-documents';

const id = z.string().min(1).max(2048);
export const researchDocumentStatusRequestSchema = z.object({
  projectId: id.nullable(),
  libraryItemIds: z.array(id).min(1).max(1000).refine(ids => new Set(ids).size === ids.length, 'research_document_status_duplicate_item')
}).strict();

/** Parse readiness and verified vector-index readiness are separate, transient observations. */
export const researchDocumentStatusResultSchema = z.object({
  items: z.array(z.object({
    libraryItemId: id,
    documents: z.array(z.object({
      id,
      status: researchDocumentSchema.shape.status,
      currentParseId: id.nullable(),
      indexStatus: z.enum(['unavailable', 'queued', 'running', 'ready', 'failed']),
      error: z.string().nullable()
    }).strict())
  }).strict()).max(1000)
}).strict();

export type ResearchDocumentStatusRequest = z.infer<typeof researchDocumentStatusRequestSchema>;
export type ResearchDocumentStatusResult = z.infer<typeof researchDocumentStatusResultSchema>;
