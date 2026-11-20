import {z} from 'zod';
import {literatureProviderRequestSchema, literatureProviderGovernanceSchema} from './literature-import';

const id = z.string().trim().min(1).max(2048);
const text = z.string().min(1).max(8192);
export const hfRevisionSchema = z.string().regex(/^[a-f0-9]{40}$/u);
export const hfRepoSchema = z.string().min(1).max(193).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)?$/u)
  .refine(value => !value.includes('..') && !value.includes('--') && !value.endsWith('.git'));
export const hfIdentitySchema = z.strictObject({kind: z.enum(['model', 'dataset']), repo: hfRepoSchema, revision: hfRevisionSchema});
export const hfCaptureSchema = z.strictObject({projectId: id, requestId: id, ...hfIdentitySchema.shape});
export const hfCancelSchema = hfCaptureSchema.pick({projectId: true, requestId: true});
export const hfCancelResultSchema = z.strictObject({cancelled: z.boolean()});
export const hfFilePathSchema = z.string().min(1).max(1024).refine(value =>
  !/[\u0000-\u001f\u007f\\]/u.test(value) && value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..'));
const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
export const hfFileSchema = z.strictObject({
  path: hfFilePathSchema, size: bytes, blobId: hfRevisionSchema,
  lfs: z.strictObject({size: bytes, sha256, pointerSize: bytes}).nullable()
}).refine(value => value.lfs === null || value.size === value.lfs.size);
const metadataFields = z.strictObject({
  ...hfIdentitySchema.shape,
  private: z.boolean().nullable(), gated: z.union([z.literal(false), z.enum(['auto', 'manual'])]).nullable(),
  disabled: z.boolean().nullable(), lastModified: z.string().datetime().nullable(),
  license: z.union([text, z.array(text).max(64)]).nullable(), licenseName: text.nullable(), licenseLink: text.nullable(),
  files: z.array(hfFileSchema).max(10000)
});
export const hfMetadataSchema = metadataFields.refine(value => new Set(value.files.map(file => file.path)).size === value.files.length);
const body = {
  id, projectId: id, request: hfCaptureSchema, provider: z.literal('huggingface'),
  contract: z.literal('hf-revision-info-blobs-v1'), queriedAt: z.string().datetime(), endpoint: z.string().url(),
  fetchedAt: z.string().datetime().nullable(), responseHash: sha256.nullable(), cache: z.enum(['hit', 'miss']),
  requests: z.array(literatureProviderRequestSchema).max(3), governance: literatureProviderGovernanceSchema,
  retryAfterMs: z.number().nonnegative().nullable(), contentHash: sha256
};
export const hfObservationSchema = z.discriminatedUnion('status', [
  z.strictObject({...body, status: z.literal('ok'), metadata: hfMetadataSchema, errorCode: z.null()}),
  z.strictObject({...body, status: z.literal('error'), metadata: z.null(), errorCode: text})
]);
export const hfSummarySchema = z.strictObject({
  ...body, status: z.enum(['ok', 'error']), metadata: metadataFields.omit({files: true}).nullable(),
  errorCode: text.nullable(), fileCount: z.number().int().nonnegative().nullable()
});
export const hfHistorySchema = z.strictObject({
  projectId: id, identity: hfIdentitySchema.nullable(),
  offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(50)
});
export const hfHistoryResultSchema = z.strictObject({
  records: z.array(hfSummarySchema).max(50), total: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable()
});
export const hfReadSchema = z.strictObject({
  projectId: id, observationId: id, offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100)
});
export const hfReadResultSchema = z.strictObject({
  observation: hfSummarySchema, files: z.array(hfFileSchema).max(100),
  total: z.number().int().nonnegative().nullable(), nextOffset: z.number().int().nonnegative().nullable()
});
export type HfIdentity = z.infer<typeof hfIdentitySchema>;
export type HfCapture = z.infer<typeof hfCaptureSchema>;
export type HfMetadata = z.infer<typeof hfMetadataSchema>;
export type HfObservation = z.infer<typeof hfObservationSchema>;
export type HfSummary = z.infer<typeof hfSummarySchema>;
