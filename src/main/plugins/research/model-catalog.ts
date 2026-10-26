import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import modelLock from '../../../../resources/research-models/models.lock.json';
import { type ResearchModelPack } from '../../../shared/schemas/research-production';

export const researchModelAssetIds = [
  'ocr-det', 'ocr-rec', 'ocr-dictionary', 'layout', 'table', 'formula', 'formula-tokenizer'
] as const;
export type ResearchModelAssetId = (typeof researchModelAssetIds)[number];

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const revisionSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const modelAssetSchema = z.object({
  id: z.enum(researchModelAssetIds),
  name: z.string().min(1),
  kind: z.enum(['onnx', 'dictionary', 'tokenizer']),
  file: z.string().min(1),
  bytes: z.number().int().positive(),
  sha256: sha256Schema,
  url: z.string().url().refine((value) => value.startsWith('https://')),
  license: z.literal('Apache-2.0'),
  sourceRevision: revisionSchema
}).strict();

const packEntrySchema = z.object({ assetIds: z.array(z.enum(researchModelAssetIds)).min(1), bytes: z.number().int().positive() }).strict();
const modelLockSchema = z.object({
  schemaVersion: z.literal(1),
  engine: z.literal('paddleocr.js'),
  runtime: z.object({ paddleocr: z.string(), onnxruntimeNode: z.string() }).strict(),
  packs: z.object({ compact: packEntrySchema, complete: packEntrySchema }).strict(),
  assets: z.array(modelAssetSchema).min(1)
}).strict();

export const researchModelLock = modelLockSchema.parse(modelLock);
export type ResearchModelAsset = z.infer<typeof modelAssetSchema>;

const assetsById = new Map<ResearchModelAssetId, ResearchModelAsset>(researchModelLock.assets.map((asset) => [asset.id, asset]));
if (assetsById.size !== researchModelLock.assets.length) throw new Error('research_model_lock_duplicate_asset');

for (const asset of researchModelLock.assets) {
  const segments = asset.file.split('/');
  if (isAbsolute(asset.file) || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('research_model_lock_path_invalid');
  }
  const immutablePath = `/${asset.sourceRevision}/`;
  if (!asset.url.includes(immutablePath)) throw new Error('research_model_lock_revision_mismatch');
}

for (const pack of ['compact', 'complete'] as const) {
  const ids = researchModelLock.packs[pack].assetIds;
  if (new Set(ids).size !== ids.length || ids.some((id) => !assetsById.has(id))) {
    throw new Error('research_model_lock_pack_invalid');
  }
  const total = ids.reduce((sum, id) => sum + (assetsById.get(id)?.bytes ?? 0), 0);
  if (total !== researchModelLock.packs[pack].bytes) throw new Error('research_model_lock_pack_size_mismatch');
}

export function getModelAsset(id: ResearchModelAssetId): ResearchModelAsset {
  const asset = assetsById.get(id);
  if (asset === undefined) throw new Error('research_model_asset_unknown');
  return asset;
}

export function getModelPackAssets(pack: ResearchModelPack): readonly ResearchModelAsset[] {
  return researchModelLock.packs[pack].assetIds.map((id) => getModelAsset(id));
}

export function modelPackBytes(pack: ResearchModelPack): number {
  return researchModelLock.packs[pack].bytes;
}

export function modelPackManifest(pack: ResearchModelPack): string {
  const assets = getModelPackAssets(pack).map(({ id, bytes, sha256, sourceRevision }) => ({ id, bytes, sha256, sourceRevision }));
  return createHash('sha256').update(JSON.stringify({ engine: researchModelLock.engine, runtime: researchModelLock.runtime, pack, assets })).digest('hex');
}

export function modelAssetPath(root: string, id: ResearchModelAssetId): string {
  return join(root, ...getModelAsset(id).file.split('/'));
}
