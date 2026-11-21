import {z} from 'zod';
import {researchExperimentPathSchema} from './research-experiments';
import {researchRelationReviewerSchema} from './research-evidence-relations';

const id = z.string().trim().min(1).max(300), hash = z.string().regex(/^[a-f0-9]{64}$/u);
const location = z.strictObject({claimId: id, claimHash: hash, start: z.number().int().nonnegative(), end: z.number().int().positive(), text: z.string().min(1).max(12000)});
export const researchFeedbackImportSchema = z.strictObject({
  projectId: id, artifactId: id, expectedArtifactVersion: hash, requestId: id,
  path: researchExperimentPathSchema.refine(path => /\.(docx|pdf)$/iu.test(path)), expectedFileHash: hash.nullable()
});
export const researchFeedbackItemSchema = z.strictObject({
  id, originalId: id, kind: z.enum(['comment', 'insertion', 'deletion']), author: z.string().max(1000), date: z.string().max(100).nullable(),
  text: z.string().min(1).max(12000), quote: z.string().max(12000),
  sourceStart: z.number().int().nonnegative().nullable(), sourceEnd: z.number().int().nonnegative().nullable(),
  page: z.number().int().positive().nullable(), rect: z.number().finite().array().length(4).nullable(), quadPoints: z.number().finite().array().max(800).nullable(),
  mapping: z.strictObject({status: z.enum(['exact', 'ambiguous', 'unmatched']), location: location.nullable()})
    .refine(value => (value.status === 'exact') === (value.location !== null))
});
export const researchFeedbackSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1), id, projectId: id, artifactId: id, artifactVersion: hash, manuscriptHash: hash, claimsHash: hash,
  request: researchFeedbackImportSchema, actor: researchRelationReviewerSchema, recordedAt: z.string().datetime(),
  source: z.strictObject({path: researchExperimentPathSchema, kind: z.enum(['docx', 'pdf']), sha256: hash, size: z.number().int().positive()}),
  items: researchFeedbackItemSchema.array().max(500), issues: z.string().array().max(100)
});
export const researchFeedbackInspectionSchema = z.strictObject({
  snapshot: researchFeedbackSnapshotSchema, snapshotHash: hash, currentArtifact: z.boolean(), sourceCurrent: z.boolean()
});
export const researchFeedbackGetSchema = z.strictObject({projectId: id, feedbackId: id});
export const researchFeedbackListSchema = z.strictObject({projectId: id, artifactId: id,
  offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(20)});
export const researchFeedbackListResultSchema = z.strictObject({items: researchFeedbackInspectionSchema.array(), total: z.number().int().nonnegative()});
export const researchFeedbackMergeSchema = researchFeedbackGetSchema.extend({
  expectedHash: hash, expectedArtifactVersion: hash, requestId: id, itemIds: id.array().min(1).max(200)
    .refine(ids => new Set(ids).size === ids.length)
});
export const researchFeedbackMergeReceiptSchema = z.strictObject({feedbackId: id, commentIds: id.array(), artifactVersion: hash});
export const researchExternalCommentSchema = z.strictObject({
  commentId: id, reviewer: z.string().min(1).max(300), comment: z.string().min(1).max(12000),
  feedbackId: id, feedbackHash: hash, itemId: id, kind: researchFeedbackItemSchema.shape.kind,
  location: location.nullable()
});
export type ResearchFeedbackImport = z.infer<typeof researchFeedbackImportSchema>;
export type ResearchFeedbackItem = z.infer<typeof researchFeedbackItemSchema>;
export type ResearchFeedbackInspection = z.infer<typeof researchFeedbackInspectionSchema>;
export type ResearchFeedbackGet = z.infer<typeof researchFeedbackGetSchema>;
export type ResearchFeedbackList = z.infer<typeof researchFeedbackListSchema>;
export type ResearchFeedbackMerge = z.infer<typeof researchFeedbackMergeSchema>;
export type ResearchExternalComment = z.infer<typeof researchExternalCommentSchema>;
