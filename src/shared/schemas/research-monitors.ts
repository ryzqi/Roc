import {z} from 'zod';
import {literatureSearchToolSchema, literatureSearchResultSchema, literatureProviderRequestSchema,
  literatureProviderGovernanceSchema} from './literature-import';

const id = z.string().trim().min(1).max(200);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const date = z.iso.datetime();
const revision = z.number().int().positive();
const actor = z.strictObject({kind: z.literal('user'), id});
export const monitorQuerySchema = z.discriminatedUnion('kind', [
  z.strictObject({kind: z.literal('search'), search: literatureSearchToolSchema.refine(
    value => new Set(value.sources).size === value.sources.length, 'monitor_duplicate_source')}),
  z.strictObject({kind: z.literal('updates'), itemId: id, itemRevision: revision,
    doi: z.string().trim().min(1).max(512)})
]);
export const monitorSaveSchema = z.strictObject({
  projectId: id, requestId: id, monitorId: id.nullable(), expectedRevision: z.number().int().nonnegative(),
  title: z.string().trim().min(1).max(200), cadence: z.enum(['daily', 'weekly']), query: monitorQuerySchema
}).refine(value => (value.monitorId === null) === (value.expectedRevision === 0), 'monitor_revision_required');
export const monitorReadSchema = z.strictObject({projectId: id, monitorId: id});
export const monitorControlSchema = monitorReadSchema.extend({
  requestId: id, expectedRevision: revision, action: z.enum(['pause', 'resume'])
});
export const monitorCheckRequestSchema = monitorReadSchema.extend({requestId: id, expectedRevision: revision});
export const monitorCancelSchema = monitorReadSchema.extend({checkId: id});
export const monitorCancelResultSchema = z.strictObject({cancelled: z.boolean()});
export const monitorVersionSchema = z.strictObject({
  monitorId: id, projectId: id, version: revision, query: monitorQuerySchema,
  createdAt: date, actor, contentHash: hash
});
export const monitorSchema = z.strictObject({
  id, projectId: id, revision, title: z.string().min(1).max(200), cadence: z.enum(['daily', 'weekly']),
  status: z.enum(['active', 'paused']), queryVersion: revision, nextCheckAt: date,
  createdAt: date, updatedAt: date, actor, lastError: z.string().nullable(), contentHash: hash
});
export const monitorEventSchema = z.strictObject({
  identity: id.max(2048), kind: z.enum(['new_paper', 'retraction', 'correction', 'other_update']),
  title: z.string().min(1).max(4000), subjectDoi: z.string().nullable(), noticeDoi: z.string().nullable(),
  field: z.string().min(1).max(2048), providerType: z.string().nullable(),
  sourceHash: hash
});
export const monitorProviderMaterialSchema = z.strictObject({
  records: z.array(z.json()).max(100),
  providerTotal: z.number().int().nonnegative().nullable(),
  events: z.array(monitorEventSchema).max(1000), nextOffset: z.number().int().nonnegative(),
  coverage: z.enum(['reported_end', 'limited'])
});
export const monitorSourceSchema = z.strictObject({
  source: id, status: z.enum(['ok', 'partial', 'error']), errorCode: z.string().nullable(),
  retryAfterMs: z.number().nonnegative().nullable(),
  endpoint: z.string().url().nullable(), executionId: id.nullable(), fetchedAt: date.nullable(),
  responseHash: hash.nullable(), cache: z.enum(['hit', 'miss']).nullable(),
  requests: z.array(literatureProviderRequestSchema), governance: literatureProviderGovernanceSchema,
  search: literatureSearchResultSchema.nullable(), material: monitorProviderMaterialSchema.nullable()
});
export const monitorCheckSchema = z.strictObject({
  id, monitorId: id, projectId: id, queryVersion: revision, controlRevision: revision,
  key: id.max(500), trigger: z.enum(['manual', 'scheduled']), scheduledAt: date.nullable(),
  startedAt: date, finishedAt: date.nullable(),
  status: z.enum(['running', 'complete', 'partial', 'failed', 'cancelled', 'interrupted']),
  errorCode: z.string().nullable(), sources: z.array(monitorSourceSchema).max(6),
  alertCount: z.number().int().nonnegative(), contentHash: hash
}).refine(value => (value.status === 'running') === (value.finishedAt === null), 'monitor_check_dates_invalid');
export const monitorAlertSchema = monitorEventSchema.extend({
  id, projectId: id, monitorId: id, checkId: id, queryVersion: revision, source: id,
  observedAt: date, contentHash: hash, acknowledgement: z.strictObject({
    revision, actor, at: date
  }).nullable()
});
export const monitorAcknowledgeSchema = z.strictObject({
  projectId: id, monitorId: id, alertId: id, expectedRevision: z.literal(0)
});
const page = {offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(20)};
export const monitorListSchema = z.strictObject({projectId: id, ...page});
export const monitorHistorySchema = monitorReadSchema.extend(page);
const paged = <T extends z.ZodType>(schema: T) => z.strictObject({
  records: z.array(schema).max(20), total: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative().nullable()
});
export const monitorListResultSchema = paged(monitorSchema);
export const monitorVersionsResultSchema = paged(monitorVersionSchema);
export const monitorChecksResultSchema = paged(monitorCheckSchema);
export const monitorAlertsResultSchema = paged(monitorAlertSchema);
export const monitorCheckReadSchema = monitorReadSchema.extend({checkId: id});
export type MonitorQuery = z.infer<typeof monitorQuerySchema>;
export type MonitorSave = z.infer<typeof monitorSaveSchema>;
export type ResearchMonitor = z.infer<typeof monitorSchema>;
export type MonitorVersion = z.infer<typeof monitorVersionSchema>;
export type MonitorCheck = z.infer<typeof monitorCheckSchema>;
export type MonitorSource = z.infer<typeof monitorSourceSchema>;
export type MonitorEvent = z.infer<typeof monitorEventSchema>;
export type MonitorMaterial = z.infer<typeof monitorProviderMaterialSchema>;
export type MonitorAlert = z.infer<typeof monitorAlertSchema>;
