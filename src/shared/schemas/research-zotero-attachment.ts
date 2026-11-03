import {z} from 'zod';
import {zoteroItemKeySchema} from './research-zotero';
import {zoteroObjectReadSchema, zoteroSourceStateRequestSchema} from './research-zotero-source-state';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const fileIdentity = z.object({device: z.number().int().nonnegative(), inode: z.number().int().nonnegative(),
  size: z.number().int().nonnegative(), modifiedMs: z.number(), changedMs: z.number()}).strict();
export const zoteroAttachmentRequestSchema = zoteroSourceStateRequestSchema.omit({collectionKey: true}).extend({
  attachmentKey: zoteroItemKeySchema
});
export const zoteroAttachmentIpcSchema = zoteroAttachmentRequestSchema.extend({projectId: z.string().min(1).nullable()});
export const zoteroAttachmentReadIpcSchema = z.object({projectId: z.string().min(1).nullable(), inspectionId: z.string().min(1)}).strict();
export const zoteroAttachmentFileSchema = z.discriminatedUnion('status', [
  z.object({status: z.literal('not_requested'), reason: z.enum(['source_not_found', 'trashed', 'linked_url', 'embedded_image'])}).strict(),
  z.object({status: z.literal('ready'), referencePath: z.string().min(1), resolvedPath: z.string().min(1), identity: fileIdentity}).strict(),
  z.object({status: z.enum(['missing', 'denied', 'invalid', 'unsupported_format']), referencePath: z.string().min(1),
    resolvedPath: z.string().min(1).nullable(), errorCode: z.string().min(1)}).strict()
]);
export const zoteroAttachmentBodySchema = z.object({
  inspectionId: z.string().min(1), source: zoteroAttachmentRequestSchema, libraryItemId: z.string().min(1),
  importedObjectVersion: z.number().int().nonnegative(), remote: zoteroObjectReadSchema,
  linkMode: z.enum(['imported_file', 'imported_url', 'linked_file', 'linked_url', 'embedded_image']).nullable(),
  file: zoteroAttachmentFileSchema, recordedAt: z.string()
}).strict();
export const zoteroAttachmentInspectionSchema = zoteroAttachmentBodySchema.extend({contentHash: hash});
export type ZoteroAttachmentInspection = z.infer<typeof zoteroAttachmentInspectionSchema>;
export type ZoteroAttachmentFile = z.infer<typeof zoteroAttachmentFileSchema>;
