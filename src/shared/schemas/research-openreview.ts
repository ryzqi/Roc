import {z} from 'zod';
import {literatureProviderRequestSchema, literatureProviderGovernanceSchema} from './literature-import';

const id = z.string().trim().min(1).max(2048);
const text = z.string().max(8192);
export const openReviewIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);
const invitation = z.string().min(1).max(512).regex(/^[A-Za-z0-9_.~/-]+$/u);
const page = {after: openReviewIdSchema.nullable(), limit: z.number().int().min(1).max(50)};
export const openReviewQuerySchema = z.discriminatedUnion('kind', [
  z.strictObject({kind: z.literal('note'), target: openReviewIdSchema, after: z.null(), limit: z.literal(1)}),
  z.strictObject({kind: z.literal('forum'), target: openReviewIdSchema, ...page}),
  z.strictObject({kind: z.literal('invitation'), target: invitation, ...page}),
  z.strictObject({kind: z.literal('edits'), target: openReviewIdSchema, ...page})
]);
export const openReviewCaptureSchema = z.strictObject({projectId: id, requestId: id, query: openReviewQuerySchema});
export const openReviewCancelSchema = openReviewCaptureSchema.pick({projectId: true, requestId: true});
export const openReviewCancelResultSchema = z.strictObject({cancelled: z.boolean()});
const groups = z.array(id).max(256);
const date = z.number().int().min(0).max(9999999999999).nullable();
const publicFields = {
  readers: groups.refine(value => value.includes('everyone')), nonreaders: groups.refine(value => !value.includes('everyone')),
  signatures: groups, domain: id.nullable(), tcdate: date, tmdate: date, cdate: date, mdate: date, ddate: date
};
const json = z.json().refine(value => JSON.stringify(value).length <= 1024 * 1024);
export const openReviewContentSchema = z.record(z.string().regex(/^[A-Za-z0-9_-]{1,80}$/u),
  z.strictObject({value: json, readers: groups.nullable()})).refine(value => Object.keys(value).length <= 128 &&
    Object.values(value).every(field => field.readers === null || field.readers.includes('everyone')));
export const openReviewNoteSchema = z.strictObject({
  id: openReviewIdSchema, forum: openReviewIdSchema, replyto: openReviewIdSchema.nullable(),
  invitations: groups, ...publicFields, pdate: date, odate: date, license: text.nullable(), content: openReviewContentSchema
});
export const openReviewEditSchema = z.strictObject({
  id: openReviewIdSchema, invitation, ...publicFields, replacement: z.boolean().nullable(),
  content: z.record(z.string(), json).nullable(),
  note: z.record(z.string(), json).refine(value =>
    openReviewIdSchema.safeParse(value.id).success && JSON.stringify(value).length <= 1024 * 1024)
});
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
export const openReviewEntrySchema = z.discriminatedUnion('kind', [
  z.strictObject({kind: z.literal('note'), note: openReviewNoteSchema, sourceHash: sha256}),
  z.strictObject({kind: z.literal('edit'), edit: openReviewEditSchema, sourceHash: sha256})
]);
export const openReviewPageSchema = z.strictObject({
  entries: z.array(openReviewEntrySchema).max(50), providerTotal: z.number().int().nonnegative().nullable(),
  nextAfter: openReviewIdSchema.nullable()
});
const body = {
  id, projectId: id, request: openReviewCaptureSchema, provider: z.literal('openreview'),
  contract: z.literal('openreview-api2-public-notes-edits-v1'), queriedAt: z.string().datetime(), endpoint: z.string().url(),
  fetchedAt: z.string().datetime().nullable(), responseHash: sha256.nullable(), cache: z.enum(['hit', 'miss']),
  requests: z.array(literatureProviderRequestSchema).max(3), governance: literatureProviderGovernanceSchema,
  retryAfterMs: z.number().nonnegative().nullable(), contentHash: sha256
};
export const openReviewObservationSchema = z.discriminatedUnion('status', [
  z.strictObject({...body, status: z.literal('ok'), page: openReviewPageSchema, errorCode: z.null()}),
  z.strictObject({...body, status: z.literal('error'), page: z.null(), errorCode: id})
]);
export const openReviewSummarySchema = z.strictObject({
  ...body, status: z.enum(['ok', 'error']), errorCode: id.nullable(), entryCount: z.number().int().nonnegative().nullable(),
  providerTotal: z.number().int().nonnegative().nullable(), nextAfter: openReviewIdSchema.nullable()
});
export const openReviewHistorySchema = z.strictObject({
  projectId: id, offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(50)
});
export const openReviewHistoryResultSchema = z.strictObject({
  records: z.array(openReviewSummarySchema).max(50), total: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable()
});
export const openReviewReadSchema = z.strictObject({
  projectId: id, observationId: id, offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(50)
});
export const openReviewReadResultSchema = z.strictObject({
  observation: openReviewSummarySchema, entries: z.array(openReviewEntrySchema).max(50),
  total: z.number().int().nonnegative().nullable(), nextOffset: z.number().int().nonnegative().nullable()
});
export type OpenReviewQuery = z.infer<typeof openReviewQuerySchema>;
export type OpenReviewCapture = z.infer<typeof openReviewCaptureSchema>;
export type OpenReviewEntry = z.infer<typeof openReviewEntrySchema>;
export type OpenReviewPage = z.infer<typeof openReviewPageSchema>;
export type OpenReviewObservation = z.infer<typeof openReviewObservationSchema>;
export type OpenReviewSummary = z.infer<typeof openReviewSummarySchema>;
