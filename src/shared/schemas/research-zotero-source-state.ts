import {z} from 'zod';
import {zoteroScopeSchema, zoteroItemKeySchema, zoteroItemSchema} from './research-zotero';

const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const zoteroObjectReadSchema = z.discriminatedUnion('status', [
  z.object({status: z.enum(['present', 'trashed']), scope: zoteroScopeSchema, item: zoteroItemSchema,
    objectVersion: version, responseHash: hash, checkedAt: z.string()}).strict(),
  z.object({status: z.literal('not_found'), scope: zoteroScopeSchema, item: z.null(), objectVersion: z.null(),
    responseHash: hash, checkedAt: z.string()}).strict()
]);
export const zoteroSourceStateRequestSchema = zoteroScopeSchema.extend({
  operationId: z.string().min(1), itemKey: zoteroItemKeySchema, collectionKey: zoteroItemKeySchema.nullable()
});
export const zoteroSourceStateIpcSchema = zoteroSourceStateRequestSchema.extend({
  projectId: z.string().min(1).nullable()
});
export const zoteroSourceStateBodySchema = z.object({
  stateId: z.string().min(1), source: zoteroSourceStateRequestSchema,
  libraryItemId: z.string().min(1), importedObjectVersion: version, remote: zoteroObjectReadSchema,
  membership: z.enum(['not_requested', 'listed', 'not_listed', 'unknown']),
  versionState: z.enum(['missing', 'regressed', 'unchanged', 'newer', 'version_conflict']),
  recordedAt: z.string()
}).strict();
export const zoteroSourceStateSchema = zoteroSourceStateBodySchema.extend({contentHash: hash});
export type ZoteroObjectRead = z.infer<typeof zoteroObjectReadSchema>;
export type ZoteroSourceState = z.infer<typeof zoteroSourceStateSchema>;
