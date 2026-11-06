import {z} from 'zod';
import {researchExportFileSchema} from './research-export-file';
import {researchPublicTextSchema} from './research-ro-crate';

const id = z.string().min(1).max(128);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const filename = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
export const zenodoMetadataSchema = z.strictObject({
  upload_type: z.literal('publication'), publication_type: z.enum(['article', 'preprint', 'report']),
  title: researchPublicTextSchema.max(256), description: researchPublicTextSchema.max(10000),
  publication_date: z.iso.date(), access_right: z.literal('open'),
  license: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9.-]*$/u),
  creators: z.array(z.strictObject({name: researchPublicTextSchema.max(200),
    affiliation: researchPublicTextSchema.max(200).optional(),
    orcid: z.string().regex(/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/u).optional()})).min(1).max(100),
  version: researchPublicTextSchema.max(100)
});
export const zenodoSelectionSchema = z.strictObject({
  area: z.enum(['archive', 'bundle']), path: researchExportFileSchema.shape.path, name: filename
});
const selections = z.array(zenodoSelectionSchema).min(1).max(20).superRefine((files, context) => {
  if (new Set(files.map(file => file.name.toLowerCase())).size !== files.length ||
    new Set(files.map(file => `${file.area}:${file.path}`)).size !== files.length) {
    context.addIssue({code: 'custom', message: 'Upload file names and selected sources must be unique.'});
  }
});
export const zenodoInputsRequestSchema = z.strictObject({projectId: id, exportId: id, files: selections});
export const zenodoUploadFileSchema = zenodoSelectionSchema.extend({
  sha256: digest, md5: z.string().regex(/^[a-f0-9]{32}$/u), size: z.number().int().nonnegative().max(512 * 1024 * 1024)
});
export const zenodoInputsSchema = z.strictObject({
  projectId: id, exportId: id, artifactId: id, exportHash: digest, sourceHash: digest,
  files: z.array(zenodoUploadFileSchema).min(1).max(20), contentHash: digest
});
export const zenodoPrepareSchema = z.strictObject({
  projectId: id, requestId: id, exportId: id, files: selections,
  expectedInputsHash: digest, environment: z.enum(['sandbox', 'production']),
  metadata: zenodoMetadataSchema,
  review: z.strictObject({privacy: z.literal(true), fileLicenses: z.literal(true), authors: z.literal(true)})
});
export const zenodoPreparedSchema = z.strictObject({
  schemaVersion: z.literal(1), id, projectId: id, request: zenodoPrepareSchema, inputs: zenodoInputsSchema,
  actor: z.strictObject({kind: z.literal('user'), id}), createdAt: z.iso.datetime(), contentHash: digest
});
export const zenodoReadSchema = z.strictObject({projectId: id, preparationId: id});
export const zenodoListSchema = z.strictObject({
  projectId: id, offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(20)
});
export const zenodoListResultSchema = z.strictObject({
  records: z.array(zenodoPreparedSchema).max(20), total: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative().nullable()
});
export type ZenodoMetadata = z.infer<typeof zenodoMetadataSchema>;
export type ZenodoInputsRequest = z.infer<typeof zenodoInputsRequestSchema>;
export type ZenodoInputs = z.infer<typeof zenodoInputsSchema>;
export type ZenodoPrepare = z.infer<typeof zenodoPrepareSchema>;
export type ZenodoPrepared = z.infer<typeof zenodoPreparedSchema>;
