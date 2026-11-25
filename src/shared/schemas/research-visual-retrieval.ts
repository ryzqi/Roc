import {z} from 'zod';
import {scientificGenerationReceiptSchema} from './research-scientific-search';
import {scientificContextImageSchema} from './research-scientific-context';

const id = z.string().min(1).max(2048);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const visualRetrievalVersion = 'roc-visual-retrieval/1';
export const visualModelSchema = z.strictObject({
  family: z.enum(['colpali', 'colqwen2']),
  path: z.string().startsWith('/').max(4096).regex(/^[^\u0000-\u001f]+$/u),
  // environmentHash is PythonEnvironmentReceipt.snapshotHash, not the probed metadataHash.
  sha256: hash, environmentId: id, environmentHash: hash
});
export const visualConfigSchema = z.strictObject({
  enabled: z.boolean().default(false), model: visualModelSchema.nullable().default(null)
}).refine(value => !value.enabled || value.model !== null, 'research_visual_model_required');
export const visualProjectSchema = z.strictObject({projectId: id});
export const visualInspectModelSchema = visualProjectSchema.extend({model: visualModelSchema.omit({sha256: true})});
export const visualSaveConfigSchema = visualProjectSchema.extend({config: visualConfigSchema});
export const visualSelectionSchema = z.strictObject({documentId: id, objectId: id});
export const visualIndexRequestSchema = visualProjectSchema.extend({
  assets: z.array(visualSelectionSchema).min(1).max(32)
}).refine(value => new Set(value.assets.map(a => JSON.stringify(a))).size === value.assets.length,
  'research_visual_duplicate_asset');
export const visualSearchRequestSchema = visualProjectSchema.extend({
  query: z.string().trim().min(1).max(2048), intent: z.enum(['figure', 'table', 'text']),
  documentIds: z.array(id).max(32).default([]), limit: z.number().int().min(1).max(20).default(5)
});
export const visualAssetSchema = visualSelectionSchema.extend({
  source: scientificGenerationReceiptSchema, image: scientificContextImageSchema,
  kind: z.enum(['figure', 'table'])
});
export const visualIndexEntrySchema = visualAssetSchema.extend({
  matrix: z.strictObject({sha256: hash, tokens: z.number().int().min(1).max(4096),
    dimensions: z.number().int().min(1).max(512)})
});
export const visualManifestSchema = z.strictObject({
  version: z.literal(visualRetrievalVersion), projectId: id, configHash: hash,
  model: visualModelSchema, createdAt: z.iso.datetime(), entries: z.array(visualIndexEntrySchema).min(1).max(32)
}).refine(value => new Set(value.entries.map(e => JSON.stringify([e.documentId, e.objectId]))).size === value.entries.length,
  'research_visual_duplicate_asset');
export const visualIndexResultSchema = z.strictObject({generation: hash, assets: z.number().int().min(1).max(32)});
export const visualSearchResultSchema = z.strictObject({
  version: z.literal(visualRetrievalVersion), projectId: id,
  status: z.enum(['disabled', 'not_applicable', 'unindexed', 'ready']), generation: hash.nullable(),
  candidates: z.array(visualAssetSchema.extend({score: z.number(),
    verification: z.literal('verify_original_pdf'), exactValues: z.literal('requires_table_or_text')})).max(20)
});
export type VisualConfig = z.infer<typeof visualConfigSchema>;
export type VisualModel = z.infer<typeof visualModelSchema>;
export type VisualAsset = z.infer<typeof visualAssetSchema>;
export type VisualManifest = z.infer<typeof visualManifestSchema>;
export type VisualIndexRequest = z.infer<typeof visualIndexRequestSchema>;
export type VisualSearchRequest = z.infer<typeof visualSearchRequestSchema>;
export type VisualSearchResult = z.infer<typeof visualSearchResultSchema>;
