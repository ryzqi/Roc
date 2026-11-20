import {z} from 'zod';
import {literatureProviderRequestSchema, literatureProviderGovernanceSchema} from './literature-import';

const id = z.string().trim().min(1).max(2048);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const scholarlyProviderSchema = z.enum(['openalex', 'crossref', 'semantic_scholar']);
export const scholarlyCaptureSchema = z.strictObject({
  projectId: id, itemId: id, expectedRevision: z.number().int().positive(), requestId: id,
  sources: z.array(scholarlyProviderSchema).min(1).max(3).refine(values => new Set(values).size === values.length),
  offset: z.number().int().min(0).max(9900), limit: z.number().int().min(1).max(100)
}).refine(value => value.offset === 0 || value.sources.length === 1 && value.sources[0] === 'semantic_scholar',
  'Only Semantic Scholar reference pages accept an offset.');
export const scholarlyCancelSchema = z.strictObject({projectId: id, itemId: id, requestId: id});
export const scholarlyCancelResultSchema = z.strictObject({cancelled: z.boolean()});
export const scholarlyIdentitySchema = z.strictObject({
  scheme: z.enum(['doi', 'openalex', 'semantic_scholar', 'external']), value: id
});
export const scholarlyRelationSchema = z.strictObject({
  subject: scholarlyIdentitySchema, object: scholarlyIdentitySchema,
  kind: z.enum(['cites', 'version', 'correction', 'retraction', 'provider_relation']),
  providerType: id, field: id, assertedBy: z.enum(['subject', 'object']).nullable()
});
const sourceSummary = z.strictObject({
  source: scholarlyProviderSchema, status: z.enum(['ok', 'error']),
  endpoint: z.string().url(), fetchedAt: z.string().datetime().nullable(), responseHash: hash.nullable(),
  cache: z.enum(['hit', 'miss']), errorCode: id.nullable(), retryAfterMs: z.number().nonnegative().nullable(),
  requests: z.array(literatureProviderRequestSchema).max(3),
  governance: literatureProviderGovernanceSchema,
  relationCount: z.number().int().nonnegative(), unmappedReferences: z.number().int().nonnegative().nullable(),
  referencesReported: z.boolean().nullable(), relationsReported: z.boolean().nullable(), updatesReported: z.boolean().nullable(),
  retraction: z.enum(['retracted', 'not_reported', 'unknown']),
  nextOffset: z.number().int().nonnegative().nullable()
});
export const scholarlySnapshotSummarySchema = z.strictObject({
  id, projectId: id, itemId: id, doi: id, itemRevision: z.number().int().positive(),
  request: scholarlyCaptureSchema, queriedAt: z.string().datetime(),
  status: z.enum(['complete', 'partial', 'failed']), sources: z.array(sourceSummary).min(1).max(3),
  contentHash: hash
});
export const scholarlySnapshotSchema = scholarlySnapshotSummarySchema.extend({
  relations: z.array(z.strictObject({source: scholarlyProviderSchema, relation: scholarlyRelationSchema})).max(30000)
});
export const scholarlyHistorySchema = z.strictObject({
  projectId: id, itemId: id, offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(50)
});
export const scholarlyHistoryResultSchema = z.strictObject({
  records: z.array(scholarlySnapshotSummarySchema).max(50), total: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable()
});
export const scholarlyReadSchema = z.strictObject({
  projectId: id, itemId: id, snapshotId: id, source: scholarlyProviderSchema,
  offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100)
});
export const scholarlyReadResultSchema = z.strictObject({
  snapshot: scholarlySnapshotSummarySchema, source: scholarlyProviderSchema,
  relations: z.array(scholarlyRelationSchema).max(100),
  total: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative().nullable()
});
export type ScholarlyCapture = z.infer<typeof scholarlyCaptureSchema>;
export type ScholarlyProvider = z.infer<typeof scholarlyProviderSchema>;
export type ScholarlyRelation = z.infer<typeof scholarlyRelationSchema>;
export type ScholarlySourceSummary = z.infer<typeof sourceSummary>;
export type ScholarlySnapshot = z.infer<typeof scholarlySnapshotSchema>;
export type ScholarlySnapshotSummary = z.infer<typeof scholarlySnapshotSummarySchema>;
