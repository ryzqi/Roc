import {z} from 'zod';
import {researchDocumentAssetSchema} from './research-documents';
import {researchDocumentCoordinatePagesSchema} from './research-document-coordinates';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const researchDocumentResolveParseRequestSchema = z.object({
  projectId: z.string().min(1), parseId: z.string().min(1)
}).strict();
export const researchDocumentPreviewRequestSchema = z.object({
  projectId: z.string().min(1), documentId: z.string().min(1), parseId: z.string().min(1),
  sourceHash: digest, parseHash: digest.nullable()
}).strict();
export const researchDocumentPreviewSchema = z.object({
  projectId: z.string(), documentId: z.string(), parseId: z.string(), sourceHash: digest, parseHash: digest,
  filename: z.string(), mediaType: z.string(), size: z.number().int().nonnegative(), pageCount: z.number().int().nonnegative(),
  sourceUrl: z.string().startsWith('roc-preview://research/projects/'),
  assets: z.array(researchDocumentAssetSchema.extend({
    resourceUrl: z.string().startsWith('roc-preview://research/projects/')
  }).strict()),
  coordinates: z.object({snapshotHash: digest, pages: researchDocumentCoordinatePagesSchema}).strict().nullable()
}).strict();
export type ResearchDocumentPreview = z.infer<typeof researchDocumentPreviewSchema>;
export type ResearchDocumentPreviewRequest = z.infer<typeof researchDocumentPreviewRequestSchema>;
