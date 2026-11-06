import {z} from 'zod';
import {literatureProviderRequestSchema, literatureProviderGovernanceSchema} from './literature-import';

const id = z.string().trim().min(1).max(2048);
const text = z.string().min(1).max(8192);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const resourceCaptureSchema = z.strictObject({projectId: id, requestId: id, doi: id});
export const resourceCancelSchema = resourceCaptureSchema.omit({doi: true});
export const resourceCancelResultSchema = z.strictObject({cancelled: z.boolean()});
export const resourceRightsSchema = z.strictObject({
  rights: text.nullable(), rightsUri: text.nullable(), rightsIdentifier: text.nullable(),
  rightsIdentifierScheme: text.nullable(), schemeUri: text.nullable(), lang: text.nullable()
});
export const resourceRelationSchema = z.strictObject({
  relatedIdentifier: text, relatedIdentifierType: id, relationType: id,
  resourceTypeGeneral: id.nullable(), relationTypeInformation: text.nullable(),
  relatedMetadataScheme: text.nullable(), schemeUri: text.nullable(), schemeType: text.nullable()
});
export const resourceMetadataSchema = z.strictObject({
  doi: id, providerIdentifier: id, kind: z.enum(['dataset', 'software']), resourceType: text.nullable(),
  version: text.nullable(), reportedSchemaVersion: text.nullable(), landingPage: text.nullable(),
  titles: z.array(z.strictObject({title: text, titleType: id.nullable(), lang: id.nullable()})).min(1).max(32),
  rights: z.array(resourceRightsSchema).max(64).nullable(),
  relatedIdentifiers: z.array(resourceRelationSchema).max(10000).nullable()
});
const receipt = {
  fetchedAt: z.string().datetime().nullable(), responseHash: hash.nullable(), cache: z.enum(['hit', 'miss']),
  requests: z.array(literatureProviderRequestSchema).max(3), governance: literatureProviderGovernanceSchema
};
const body = {
  id, projectId: id, request: resourceCaptureSchema, provider: z.literal('datacite'),
  contract: z.literal('datacite-jsonapi-v2/schema-4.7'), queriedAt: z.string().datetime(), endpoint: z.string().url(),
  ...receipt, retryAfterMs: z.number().nonnegative().nullable(), contentHash: hash
};
export const resourceObservationSchema = z.discriminatedUnion('status', [
  z.strictObject({...body, status: z.literal('ok'), metadata: resourceMetadataSchema, errorCode: z.null()}),
  z.strictObject({...body, status: z.literal('error'), metadata: z.null(), errorCode: text})
]);
export const resourceSummarySchema = z.strictObject({
  ...body, status: z.enum(['ok', 'error']), metadata: resourceMetadataSchema.omit({relatedIdentifiers: true}).nullable(),
  errorCode: text.nullable(), relatedCount: z.number().int().nonnegative().nullable()
});
export const resourceHistorySchema = z.strictObject({
  projectId: id, doi: id.nullable(), offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(50)
});
export const resourceHistoryResultSchema = z.strictObject({
  records: z.array(resourceSummarySchema).max(50), total: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable()
});
export const resourceReadSchema = z.strictObject({
  projectId: id, resourceId: id, offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100)
});
export const resourceReadResultSchema = z.strictObject({
  resource: resourceSummarySchema, relatedIdentifiers: z.array(resourceRelationSchema).max(100),
  total: z.number().int().nonnegative().nullable(), nextOffset: z.number().int().nonnegative().nullable()
});
export type ResourceCapture = z.infer<typeof resourceCaptureSchema>;
export type ResourceMetadata = z.infer<typeof resourceMetadataSchema>;
export type ResourceObservation = z.infer<typeof resourceObservationSchema>;
export type ResourceSummary = z.infer<typeof resourceSummarySchema>;
