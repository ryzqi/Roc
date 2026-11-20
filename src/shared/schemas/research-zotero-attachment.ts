import {z} from 'zod';
import {zoteroItemKeySchema, zoteroItemsPageSchema, zoteroImportedObjectSchema} from './research-zotero';
import {zoteroObjectReadSchema, zoteroSourceStateRequestSchema} from './research-zotero-source-state';
import {researchDocumentSchema} from './research-documents';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const zoteroAttachmentFileIdentitySchema = z.object({device: z.number().int().nonnegative(), inode: z.number().int().nonnegative(),
  size: z.number().int().nonnegative(), modifiedMs: z.number(), changedMs: z.number()}).strict();
export const zoteroAttachmentRequestSchema = zoteroSourceStateRequestSchema.omit({collectionKey: true}).extend({
  attachmentKey: zoteroItemKeySchema
});
export const zoteroAttachmentIpcSchema = zoteroAttachmentRequestSchema.extend({projectId: z.string().min(1).nullable()});
export const zoteroAttachmentReadIpcSchema = z.object({projectId: z.string().min(1).nullable(), inspectionId: z.string().min(1)}).strict();
export const zoteroAttachmentFileSchema = z.discriminatedUnion('status', [
  z.object({status: z.literal('not_requested'), reason: z.enum(['source_not_found', 'trashed', 'linked_url', 'embedded_image'])}).strict(),
  z.object({status: z.literal('ready'), referencePath: z.string().min(1), resolvedPath: z.string().min(1), identity: zoteroAttachmentFileIdentitySchema}).strict(),
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
export const zoteroAttachmentGrantRequestSchema = z.object({inspectionId: z.string().min(1), requestId: z.string().min(1)}).strict();
export const zoteroAttachmentGrantIpcSchema = zoteroAttachmentGrantRequestSchema.extend({projectId: z.string().min(1).nullable()});
export const zoteroAttachmentGrantReadIpcSchema = z.object({projectId: z.string().min(1).nullable(), grantId: z.string().min(1)}).strict();
export const zoteroAttachmentGrantBodySchema = z.object({
  grantId: z.string().min(1), inspectionId: z.string().min(1), requestId: z.string().min(1),
  permission: z.literal('read_one_file'), selectedPath: z.string().min(1), identity: zoteroAttachmentFileIdentitySchema,
  inspectionHash: hash, grantedAt: z.string()
}).strict();
export const zoteroAttachmentGrantSchema = zoteroAttachmentGrantBodySchema.extend({contentHash: hash});
export const zoteroAttachmentGrantOutcomeSchema = z.discriminatedUnion('status', [
  z.object({status: z.literal('granted'), grant: zoteroAttachmentGrantSchema}).strict(),
  z.object({status: z.literal('cancelled'), grant: z.null()}).strict()
]);
export type ZoteroAttachmentGrant = z.infer<typeof zoteroAttachmentGrantSchema>;
export type ZoteroAttachmentGrantOutcome = z.infer<typeof zoteroAttachmentGrantOutcomeSchema>;
export const zoteroAttachmentImportRequestSchema = z.object({grantId: z.string().min(1), requestId: z.string().min(1),
  destination: z.enum(['library_only', 'current_project'])}).strict();
export const zoteroAttachmentImportIpcSchema = zoteroAttachmentImportRequestSchema.extend({projectId: z.string().min(1).nullable()});
export const zoteroAttachmentImportReadIpcSchema = z.object({projectId: z.string().min(1).nullable(), requestId: z.string().min(1)}).strict();
export const zoteroAttachmentImportBodySchema = z.object({
  operationId: z.string().min(1), requestId: z.string().min(1), grantId: z.string().min(1), grantHash: hash,
  inspectionId: z.string().min(1), source: zoteroAttachmentRequestSchema, libraryItemId: z.string().min(1),
  destinationProjectId: z.string().min(1).nullable(), document: researchDocumentSchema, importedAt: z.string()
}).strict();
export const zoteroAttachmentImportSchema = zoteroAttachmentImportBodySchema.extend({contentHash: hash});
export const zoteroAttachmentImportCancelSchema = z.object({requestId: z.string().min(1), cancelRequested: z.boolean()}).strict();
export type ZoteroAttachmentImport = z.infer<typeof zoteroAttachmentImportSchema>;
export const zoteroChildrenRequestSchema = zoteroAttachmentRequestSchema.omit({attachmentKey: true}).extend({
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  limit: z.number().int().min(1).max(50), expectedLibraryVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable()
});
export const zoteroChildrenIpcSchema = zoteroChildrenRequestSchema.extend({projectId: z.string().min(1).nullable()});
export const zoteroChildrenPageSchema = z.object({
  parent: zoteroImportedObjectSchema, request: zoteroChildrenRequestSchema, page: zoteroItemsPageSchema
}).strict();
export type ZoteroChildrenPage = z.infer<typeof zoteroChildrenPageSchema>;
