import {z} from 'zod';

const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const zoteroServerIdSchema = z.string().min(1).max(256).regex(/^[\x21-\x7e]+$/u);
export const zoteroItemKeySchema = z.string().regex(/^[A-Z0-9]{8}$/u);
export const zoteroLibrarySchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('user'), id: z.literal(0)}).strict(),
  z.object({kind: z.literal('group'), id: version.refine(value => value > 0)}).strict()
]);
export const zoteroScopeSchema = z.object({serverId: zoteroServerIdSchema, library: zoteroLibrarySchema}).strict();
export const zoteroProbeRequestSchema = z.object({}).strict();
export const zoteroProbeSchema = z.discriminatedUnion('status', [
  z.object({status: z.literal('connected'), serverId: zoteroServerIdSchema, apiVersion: z.literal(3),
    schemaVersion: version, checkedAt: z.string()}).strict(),
  z.object({status: z.enum(['disabled', 'unreachable', 'unsupported', 'invalid_response']),
    errorCode: z.string().min(1), checkedAt: z.string()}).strict()
]);
export const zoteroPageRequestSchema = zoteroScopeSchema.extend({
  offset: version.default(0), limit: z.number().int().min(1).max(50).default(20),
  expectedLibraryVersion: version.nullable()
});
export const zoteroItemsRequestSchema = zoteroPageRequestSchema.extend({
  collectionKey: zoteroItemKeySchema.nullable(), since: version.nullable()
});
export const zoteroGroupsRequestSchema = z.object({
  serverId: zoteroServerIdSchema, offset: version.default(0), limit: z.number().int().min(1).max(50).default(20)
}).strict();
const raw = z.json();
export const zoteroItemSchema = z.object({
  key: zoteroItemKeySchema, version,
  data: z.object({key: zoteroItemKeySchema, version, itemType: z.string().min(1)}).catchall(raw)
}).catchall(raw).refine(item => item.key === item.data.key && item.version === item.data.version);
export const zoteroCollectionSchema = z.object({
  key: zoteroItemKeySchema, version,
  data: z.object({key: zoteroItemKeySchema, version, name: z.string(),
    parentCollection: z.union([z.literal(false), zoteroItemKeySchema])}).catchall(raw)
}).catchall(raw).refine(item => item.key === item.data.key && item.version === item.data.version);
export const zoteroGroupSchema = z.object({
  id: version.refine(value => value > 0), version,
  data: z.object({id: version.refine(value => value > 0), name: z.string()}).catchall(raw)
}).catchall(raw).refine(group => group.id === group.data.id);
const page = z.object({
  serverId: zoteroServerIdSchema, library: zoteroLibrarySchema, libraryVersion: version,
  offset: version, total: version, nextOffset: version.nullable(),
  responseHash: z.string().regex(/^[a-f0-9]{64}$/u), fetchedAt: z.string()
}).strict();
export const zoteroItemsPageSchema = page.extend({records: z.array(zoteroItemSchema)});
export const zoteroCollectionsPageSchema = page.extend({records: z.array(zoteroCollectionSchema)});
export const zoteroGroupsPageSchema = page.omit({library: true, libraryVersion: true}).extend({
  records: z.array(zoteroGroupSchema)
});
export const zoteroPreviewBodySchema = z.object({
  schemaVersion: z.literal(1), previewId: z.string().min(1),
  request: zoteroItemsRequestSchema, sourcePage: zoteroItemsPageSchema,
  createdAt: z.string(), expiresAt: z.string()
}).strict();
export const zoteroPreviewSchema = zoteroPreviewBodySchema.extend({
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u)
});
export const zoteroPreviewReadSchema = z.object({
  previewId: z.string().min(1), offset: version.default(0),
  limit: z.number().int().min(1).max(30).default(20)
}).strict();
export const zoteroPreviewPageSchema = zoteroPreviewSchema.extend({
  capturedTotal: version, nextPreviewOffset: version.nullable()
});
export type ZoteroPreview = z.infer<typeof zoteroPreviewSchema>;
export type ZoteroPreviewPage = z.infer<typeof zoteroPreviewPageSchema>;
export type ZoteroScope = z.infer<typeof zoteroScopeSchema>;
export type ZoteroPageRequest = z.infer<typeof zoteroPageRequestSchema>;
export type ZoteroItemsRequest = z.infer<typeof zoteroItemsRequestSchema>;
export type ZoteroItem = z.infer<typeof zoteroItemSchema>;
