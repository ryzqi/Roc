import {z} from 'zod';

export const literatureAcquisitionSettingsSchema = z.object({
  versionPreference: z.enum(['balanced', 'preprint', 'published']).default('balanced'),
  unpaywallEmail: z.email().max(254).nullable().default(null)
}).strict();
export type LiteratureAcquisitionSettings = z.infer<typeof literatureAcquisitionSettingsSchema>;
export const paperAcquisitionFailureSchema = z.object({
  provider: z.string().regex(/^[a-z_]{1,40}$/u),
  code: z.string().regex(/^[a-z][a-z0-9_]{2,100}$/u),
  category: z.enum(['rate_limited', 'temporary', 'permanent', 'restricted', 'invalid_content']),
  retryAfterMs: z.number().nonnegative().max(86400000).nullable()
}).strict();

export const literatureIngestionPolicySchema = z.enum(['fulltext_auto', 'metadata_only']);
export const paperAcquisitionStageSchema = z.enum(['resolve', 'download', 'import', 'parse', 'index', 'wiki']);
export const paperAcquisitionStatusSchema = z.enum(['queued', 'running', 'ready', 'blocked', 'failed', 'unavailable', 'cancelled']);
export const paperAcquisitionReceiptSchema = z.object({
  id: z.string(), generation: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/u), bytes: z.number().int().positive(),
  sourceUrl: z.string().nullable(), provider: z.string(), version: z.enum(['published', 'accepted', 'preprint', 'unknown']),
  license: z.string().nullable(), doi: z.string().nullable(), arxivId: z.string().nullable(),
  relativePath: z.string().nullable(), acquiredAt: z.string()
}).strict();
export const paperAcquisitionJobSchema = z.object({
  id: z.string(), projectId: z.string().nullable(), libraryItemId: z.string(), title: z.string(),
  generation: z.string(), stage: paperAcquisitionStageSchema, status: paperAcquisitionStatusSchema,
  attempts: z.number().int().nonnegative(), nextRetryAt: z.string().nullable(), documentId: z.string().nullable(),
  receipt: paperAcquisitionReceiptSchema.nullable(), errorCode: z.string().nullable(), updatedAt: z.string(),
  lastFailure: paperAcquisitionFailureSchema.optional()
}).strict();
const scope = {destination: z.enum(['current_project', 'library_only']).optional()};
const project = {projectId: z.string().min(1).nullable().optional()};
export const listPaperAcquisitionToolSchema = z.object({
  ...scope, operationId: z.string().min(1).max(200).optional(), libraryItemId: z.string().min(1).max(200).optional(),
  offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(50).default(20)
}).strict();
export const listPaperAcquisitionSchema = listPaperAcquisitionToolSchema.extend(project);
export const changePaperAcquisitionToolSchema = z.object({
  ...scope, jobId: z.string().min(1).max(200), generation: z.string().min(1).max(200)
}).strict();
// Only a local, already-imported document may be selected by the trusted attachment UI.
export const changePaperAcquisitionSchema = changePaperAcquisitionToolSchema.extend({
  ...project, replacementDocumentId: z.string().min(1).max(200).optional()
});
export const listPaperAcquisitionResultSchema = z.object({
  jobs: z.array(paperAcquisitionJobSchema), total: z.number().int().nonnegative(), nextOffset: z.number().int().nullable()
}).strict();

export type PaperAcquisitionStage = z.infer<typeof paperAcquisitionStageSchema>;
export type PaperAcquisitionStatus = z.infer<typeof paperAcquisitionStatusSchema>;
export type PaperAcquisitionJob = z.infer<typeof paperAcquisitionJobSchema>;
export type PaperAcquisitionReceipt = z.infer<typeof paperAcquisitionReceiptSchema>;
export type ListPaperAcquisition = z.infer<typeof listPaperAcquisitionSchema>;
export type ListPaperAcquisitionResult = z.infer<typeof listPaperAcquisitionResultSchema>;
export type ChangePaperAcquisition = z.infer<typeof changePaperAcquisitionSchema>;
