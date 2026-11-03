import {z} from 'zod';
import {zoteroScopeSchema, zoteroItemKeySchema, zoteroPreviewPageSchema} from './research-zotero';

const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identity = {syncId: z.string().min(1)};
const action = {...identity, expectedRevision: version};
const ipcScope = {projectId: z.string().min(1).nullable()};
export const zoteroSyncStartSchema = zoteroScopeSchema.extend({
  collectionKey: zoteroItemKeySchema.nullable(), mode: z.enum(['full', 'incremental', 'rebaseline']),
  limit: z.number().int().min(1).max(50)
});
export const zoteroSyncReadSchema = z.object(identity).strict();
export const zoteroSyncFindSchema = zoteroScopeSchema.extend({collectionKey: zoteroItemKeySchema.nullable()});
export const zoteroSyncPageSchema = z.object({
  ...action, replacePreviewId: z.string().min(1).nullable()
}).strict();
export const zoteroSyncControlSchema = z.object({
  ...action, action: z.enum(['pause', 'resume', 'abandon'])
}).strict();
export const zoteroSyncAcknowledgeSchema = z.object({
  ...action, previewId: z.string().min(1),
  importedKeys: z.array(zoteroItemKeySchema).max(50),
  skipped: z.array(z.object({
    itemKey: zoteroItemKeySchema, reason: z.string().trim().min(1).max(500)
  }).strict()).max(50)
}).strict().refine(input => {
  const keys = [...input.importedKeys, ...input.skipped.map(item => item.itemKey)];
  return keys.length === new Set(keys).size;
}, 'zotero_sync_duplicate_decision');
export const zoteroSyncSchema = z.object({
  syncId: z.string().min(1), scope: zoteroScopeSchema, collectionKey: zoteroItemKeySchema.nullable(),
  mode: z.enum(['full', 'incremental', 'rebaseline']), limit: z.number().int().min(1).max(50),
  revision: version, status: z.enum(['active', 'paused', 'completed', 'reset_required']),
  checkpointVersion: version.nullable(), since: version.nullable(),
  targetVersion: version.nullable(), total: version.nullable(), nextOffset: version,
  pendingPreviewId: z.string().min(1).nullable(), errorCode: z.string().min(1).nullable(),
  createdAt: z.string(), updatedAt: z.string()
}).strict();
export const zoteroSyncCapturedPageSchema = z.object({
  sync: zoteroSyncSchema, preview: zoteroPreviewPageSchema,
  importedKeys: z.array(zoteroItemKeySchema).max(50)
}).strict();
export const zoteroSyncFindIpcSchema = zoteroSyncFindSchema.extend(ipcScope);
export const zoteroSyncStartIpcSchema = zoteroSyncStartSchema.extend(ipcScope);
export const zoteroSyncReadIpcSchema = zoteroSyncReadSchema.extend(ipcScope);
export const zoteroSyncPageIpcSchema = zoteroSyncPageSchema.extend(ipcScope);
export const zoteroSyncControlIpcSchema = zoteroSyncControlSchema.extend(ipcScope);
export const zoteroSyncAcknowledgeIpcSchema = zoteroSyncAcknowledgeSchema.safeExtend(ipcScope);
export type ZoteroSync = z.infer<typeof zoteroSyncSchema>;
export type ZoteroSyncCapturedPage = z.infer<typeof zoteroSyncCapturedPageSchema>;
