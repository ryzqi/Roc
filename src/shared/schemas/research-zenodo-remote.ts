import {z} from 'zod';
import {zenodoSelectionSchema} from './research-zenodo';
const id = z.string().min(1).max(128);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const environment = z.enum(['sandbox', 'production']);
const actor = z.strictObject({kind: z.literal('user'), id});
export const zenodoCredentialSchema = z.strictObject({projectId: id, environment,
  plaintext: z.string().min(1).max(4096).regex(/^[^\s]+$/u)});
export const zenodoCredentialStatusSchema = z.strictObject({stored: z.boolean()});
export const zenodoCredentialReadSchema = z.strictObject({projectId: id, environment});
export const zenodoRemoteFileSchema = z.strictObject({id: z.string().min(1).max(128), name: zenodoSelectionSchema.shape.name,
  md5: z.string().regex(/^[a-f0-9]{32}$/u), size: z.number().int().nonnegative().max(512 * 1024 * 1024)});
export const zenodoRemoteSnapshotSchema = z.strictObject({id: z.number().int().positive(), owner: z.number().int().positive(),
  modified: z.iso.datetime({offset: true}), state: z.enum(['inprogress', 'done', 'error']), submitted: z.boolean(),
  metadata: z.record(z.string(), z.json()), files: z.array(zenodoRemoteFileSchema).max(20),
  bucket: z.string().max(2048).nullable(), doi: z.string().max(256).regex(/^10\.\d{4,9}\/\S+$/u).nullable(),
  recordId: z.number().int().positive().nullable(), recordUrl: z.string().max(2048).nullable(), contentHash: hash});
export const zenodoStartSchema = z.strictObject({projectId: id, preparationId: id, requestId: id, expectedPreparationHash: hash});
export const zenodoOperationReadSchema = z.strictObject({projectId: id, operationId: id});
export const zenodoOperationForPreparationSchema = z.strictObject({projectId: id, preparationId: id});
export const zenodoOperationActionSchema = zenodoOperationReadSchema.extend({expectedRevision: z.number().int().positive()});
export const zenodoPublicationApproveSchema = zenodoOperationActionSchema.extend({requestId: id, expectedRemoteHash: hash,
  expectedPreparationHash: hash, confirmPublic: z.literal(true)});
export const zenodoPublicationApprovalSchema = z.strictObject({id, request: zenodoPublicationApproveSchema,
  actor, createdAt: z.iso.datetime(), contentHash: hash});
export const zenodoPublishSchema = zenodoOperationActionSchema.extend({approvalId: id});
export const zenodoOperationSchema = z.strictObject({schemaVersion: z.literal(1), id, projectId: id, preparationId: id,
  request: zenodoStartSchema, environment, marker: z.string().max(200), actor,
  revision: z.number().int().positive(), status: z.enum(['creating', 'create_unknown', 'draft', 'uploading',
    'upload_unknown', 'ready', 'publish_requested', 'publish_unknown', 'published', 'remote_error']),
  remoteId: z.number().int().positive().nullable(), remote: zenodoRemoteSnapshotSchema.nullable(),
  approval: zenodoPublicationApprovalSchema.nullable(), error: z.string().max(128).nullable(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), contentHash: hash});
export const zenodoOperationListSchema = z.strictObject({projectId: id, offset: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(20)});
export const zenodoOperationListResultSchema = z.strictObject({records: z.array(zenodoOperationSchema).max(20),
  total: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative().nullable()});
export type ZenodoRemoteSnapshot = z.infer<typeof zenodoRemoteSnapshotSchema>;
export type ZenodoOperation = z.infer<typeof zenodoOperationSchema>;
export type ZenodoPublicationApproval = z.infer<typeof zenodoPublicationApprovalSchema>;
