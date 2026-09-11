import { z } from 'zod';
import { researchCitationKeySchema } from './research-library';
import { researchParsedDocumentSchema } from './research-production';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const researchDocumentSchema = z.object({
  id: z.string(), libraryItemId: z.string(), filename: z.string(), mediaType: z.string(), sourceHash: hash,
  size: z.number().int().nonnegative(), status: z.enum(['imported', 'parsing', 'ready', 'failed', 'cancelled']),
  currentParseId: z.string().nullable(), activeParseId: z.string().nullable(), error: z.string().nullable(),
  createdAt: z.string(), updatedAt: z.string()
}).strict();
export const researchDocumentImportRequestSchema = z.discriminatedUnion('target', [
  z.object({ target: z.literal('new-item'), sourcePath: z.string().min(1), title: z.string().trim().min(1).max(1000),
    citationKey: researchCitationKeySchema, projectId: z.string().min(1).nullable() }).strict(),
  z.object({ target: z.literal('library-item'), sourcePath: z.string().min(1), libraryItemId: z.string().min(1),
    projectId: z.string().min(1).nullable() }).strict()
]);
export const researchDocumentIdRequestSchema = z.object({ documentId: z.string().min(1) }).strict();
export const researchDocumentListRequestSchema = z.object({ libraryItemId: z.string().min(1) }).strict();
export const researchDocumentRunSchema = z.object({
  id: z.string(), documentId: z.string(), status: z.enum(['running', 'ready', 'failed', 'cancelled']),
  error: z.string().nullable(), createdAt: z.string(), finishedAt: z.string().nullable()
}).strict();
export const researchDocumentAssetSchema = z.object({
  id: z.string(), kind: z.enum(['page', 'figure', 'table']), page: z.number().int().positive().nullable(),
  sha256: hash, size: z.number().int().nonnegative()
}).strict();
export const researchDocumentContentSchema = researchParsedDocumentSchema.omit({ blocks: true, assets: true }).extend({
  blocks: z.array(researchParsedDocumentSchema.shape.blocks.element.omit({ imagePath: true }).extend({ imageAssetId: z.string().nullable() }).strict()),
  assets: z.array(researchDocumentAssetSchema)
}).strict();
export const researchDocumentParseSchema = z.object({ run: researchDocumentRunSchema, content: researchDocumentContentSchema }).strict();
export const researchDocumentParseRequestSchema = researchDocumentIdRequestSchema.extend({ parseId: z.string().min(1) }).strict();
export const researchDocumentSourceRequestSchema = researchDocumentIdRequestSchema.extend({ sourceHash: hash }).strict();
export const researchDocumentAssetRequestSchema = researchDocumentParseRequestSchema.extend({ assetId: z.string().min(1), sha256: hash }).strict();
