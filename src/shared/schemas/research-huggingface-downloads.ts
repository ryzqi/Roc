import {z} from 'zod';
import {hfFilePathSchema, hfFileSchema, hfSummarySchema} from './research-huggingface';
import {researchRelationReviewerSchema} from './research-evidence-relations';

const id = z.string().trim().min(1).max(2048);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const bytes = z.number().int().nonnegative().max(512 * 1024 * 1024);
export const hfDownloadStartSchema = z.strictObject({
  projectId: id, requestId: id, observationId: id, expectedContentHash: hash,
  paths: z.array(hfFilePathSchema).min(1).max(20).refine(paths => new Set(paths).size === paths.length),
  maxBytes: bytes, timeoutMs: z.number().int().min(1000).max(120000),
  licenseReview: z.string().trim().min(1).max(8192)
});
export const hfDownloadReadSchema = z.strictObject({projectId: id, downloadId: id});
export const hfDownloadCancelSchema = hfDownloadReadSchema;
export const hfDownloadCancelResultSchema = z.strictObject({cancelled: z.boolean()});
export const hfDownloadedFileSchema = z.strictObject({
  source: hfFileSchema, storageName: z.string().regex(/^file-\d{1,2}$/u), sha256: hash,
  verifiedAt: z.string().datetime()
});
export const hfDownloadRequestReceiptSchema = z.strictObject({
  filePath: hfFilePathSchema, host: z.string().min(1).max(253),
  startedAt: z.string().datetime(), endedAt: z.string().datetime().nullable(),
  status: z.number().int().min(100).max(599).nullable(), retryAfterMs: z.number().nonnegative().nullable(),
  errorCode: z.string().min(1).max(256).nullable()
});
export const hfDownloadReceiptSchema = z.strictObject({
  id: z.string().regex(/^hfdownload_[a-f0-9-]{36}$/u), projectId: id, request: hfDownloadStartSchema,
  observation: hfSummarySchema, selectedFiles: z.array(hfFileSchema).min(1).max(20),
  authorization: z.literal('human_reviewed_download'), actor: researchRelationReviewerSchema,
  state: z.enum(['running', 'completed', 'failed', 'cancelled', 'interrupted']),
  revision: z.number().int().positive(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(), errorCode: z.string().min(1).max(256).nullable(),
  lastRecordedTransferredBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), verifiedBytes: bytes,
  files: z.array(hfDownloadedFileSchema).max(20), requests: z.array(hfDownloadRequestReceiptSchema).max(360),
  contentHash: hash
});
export const hfDownloadHistorySchema = z.strictObject({
  projectId: id, observationId: id.nullable(),
  offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(50)
});
export const hfDownloadHistoryResultSchema = z.strictObject({
  records: z.array(hfDownloadReceiptSchema).max(50), total: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable()
});
export type HfDownloadStart = z.infer<typeof hfDownloadStartSchema>;
export type HfDownloadReceipt = z.infer<typeof hfDownloadReceiptSchema>;
export type HfDownloadRequestReceipt = z.infer<typeof hfDownloadRequestReceiptSchema>;
