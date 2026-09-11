import { z } from 'zod';

const identifier = z.string().min(1);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const pattern = z.string().min(1).max(1000).refine((value) => !value.startsWith('/') && !/[\\\u0000-\u001f]/u.test(value) && !value.split('/').includes('..'), 'Index patterns must be relative.');
export const researchIndexKindSchema = z.enum(['markdown', 'latex', 'bibliography', 'csv', 'pdf', 'image', 'html']);
export const researchIndexOptionsSchema = z.object({
  kinds: z.array(researchIndexKindSchema).min(1).refine((values) => new Set(values).size === values.length),
  include: z.array(pattern).min(1).max(100), exclude: z.array(pattern).max(100),
  watch: z.boolean(), paused: z.boolean(), embeddingConfigId: identifier.nullable()
}).strict();
export const defaultResearchIndexOptions: z.infer<typeof researchIndexOptionsSchema> = {
  kinds: ['markdown', 'latex', 'bibliography', 'csv', 'pdf', 'image'], include: ['**/*'],
  exclude: ['**/.*', '**/.*/**', '**/node_modules/**', '**/dist/**', '**/build/**', '**/out/**', '**/coverage/**', '**/release/**', '**/*.aux', '**/*.log'],
  watch: true, paused: false, embeddingConfigId: null
};
export const researchIndexSettingsSchema = researchIndexOptionsSchema.extend({ projectId: identifier, revision: z.number().int().positive() }).strict();
export const researchIndexSettingsSaveSchema = researchIndexOptionsSchema.extend({ projectId: identifier, expectedRevision: z.number().int().positive() }).strict();
export const researchIndexProjectRequestSchema = z.object({ projectId: identifier }).strict();
export const researchIndexControlRequestSchema = z.discriminatedUnion('action', [
  researchIndexProjectRequestSchema.extend({ action: z.enum(['scan', 'rebuild', 'pause', 'resume']), expectedRevision: z.number().int().positive() }).strict(),
  researchIndexProjectRequestSchema.extend({ action: z.literal('retry'), expectedRevision: z.number().int().positive(), fileId: identifier.nullable() }).strict()
]);
export const researchIndexedFileSchema = z.object({
  id: identifier, projectId: identifier, path: z.string(), kind: researchIndexKindSchema, size: z.number().int().nonnegative(),
  status: z.enum(['queued', 'running', 'ready', 'failed', 'missing']), sourceHash: hash.nullable(), indexedHash: hash.nullable(),
  textIndexed: z.boolean(), error: z.string().nullable(), activeJobId: identifier.nullable(), updatedAt: z.string()
}).strict();
export const researchIndexJobSchema = z.object({
  id: identifier, projectId: identifier, fileId: identifier, path: z.string(), generation: z.number().int().positive(),
  status: z.enum(['queued', 'running', 'ready', 'failed', 'cancelled']), error: z.string().nullable(),
  createdAt: z.string(), startedAt: z.string().nullable(), finishedAt: z.string().nullable()
}).strict();
export const researchIndexStatusSchema = z.object({
  settings: researchIndexSettingsSchema, generation: z.number().int().positive(), workspacePath: z.string().nullable(),
  phase: z.enum(['unavailable', 'idle', 'queued', 'scanning', 'indexing', 'paused', 'failed']), error: z.string().nullable(), lastScanAt: z.string().nullable(),
  counts: z.object({ total: z.number().int().nonnegative(), queued: z.number().int().nonnegative(), running: z.number().int().nonnegative(), ready: z.number().int().nonnegative(), failed: z.number().int().nonnegative() }).strict()
}).strict();
export const researchIndexFilesRequestSchema = researchIndexProjectRequestSchema.extend({ query: z.string().max(1000), includeMissing: z.boolean(), limit: z.number().int().min(1).max(1000) }).strict();
export const researchIndexJobsRequestSchema = researchIndexProjectRequestSchema.extend({ limit: z.number().int().min(1).max(1000) }).strict();
export const researchIndexedSourceSchema = z.object({
  projectId: identifier, fileId: identifier, path: z.string(), kind: researchIndexKindSchema, sourceHash: hash, size: z.number().int().nonnegative()
}).strict();
export const researchIndexSourceRequestSchema = researchIndexProjectRequestSchema.extend({ fileId: identifier, sourceHash: hash }).strict();
export const researchIndexEvidenceSourceRequestSchema = researchIndexProjectRequestSchema.extend({ evidenceId: identifier }).strict();
export const researchIndexSourceMetadataSchema = z.object({ type: z.literal('project-index'), fileId: identifier, sourceHash: hash, parserKey: identifier }).strict();
