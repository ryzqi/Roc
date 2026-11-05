import {z} from 'zod';
import {researchClaimSchema, researchManuscriptSchema} from './research-evidence';
import {researchInspectedEvidenceSchema} from './research-evidence-source';
import {researchRelationReviewerSchema} from './research-evidence-relations';

const id = z.string().trim().min(1).max(300);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const note = z.string().trim().min(1).max(12000);
export const researchResponseLocationSchema = z.strictObject({
  claimId: id, claimHash: hash, start: z.number().int().nonnegative(),
  end: z.number().int().positive(), text: z.string().min(1).max(12000)
}).refine(location => location.end > location.start, 'research_response_location_invalid');
export const researchResponseRowSchema = z.strictObject({
  commentId: id, reviewer: id, comment: note, status: z.enum(['open', 'addressed', 'declined']),
  response: z.string().trim().max(12000),
  locations: researchResponseLocationSchema.array().max(50), evidenceIds: id.array().max(50)
}).superRefine((row, ctx) => {
  if (row.status !== 'open' && row.response.length === 0) {
    ctx.addIssue({code: 'custom', path: ['response'], message: 'research_response_reply_required'});
  }
  if (row.status === 'addressed' && row.locations.length === 0) {
    ctx.addIssue({code: 'custom', path: ['locations'], message: 'research_response_location_required'});
  }
  if (new Set(row.evidenceIds).size !== row.evidenceIds.length ||
    new Set(row.locations.map(location => `${location.claimId}:${location.start}:${location.end}`)).size !== row.locations.length) {
    ctx.addIssue({code: 'custom', message: 'research_response_duplicate_reference'});
  }
});
export const researchResponseMatrixSaveSchema = z.strictObject({
  projectId: id, artifactId: id, requestId: id, expectedArtifactVersion: hash,
  parent: z.strictObject({reviewId: id, reviewHash: hash}).nullable(),
  rationale: note, rows: researchResponseRowSchema.array().min(1).max(200)
}).refine(value => new Set(value.rows.map(row => row.commentId)).size === value.rows.length,
  'research_response_duplicate_comment');
export const researchResponseMatrixMaterialSchema = z.strictObject({
  manuscript: researchManuscriptSchema, claims: researchClaimSchema.array(),
  evidence: researchInspectedEvidenceSchema.array()
});
export const researchResponseMatrixReceiptSchema = z.strictObject({
  snapshot: z.strictObject({
    schemaVersion: z.literal(1), id, version: z.number().int().positive(),
    request: researchResponseMatrixSaveSchema, actor: researchRelationReviewerSchema,
    recordedAt: z.string().datetime(), material: researchResponseMatrixMaterialSchema
  }),
  snapshotHash: hash
});
export const researchResponseMatrixInspectSchema = z.strictObject({
  projectId: id, artifactId: id, expectedHash: hash.nullable()
});
export const researchResponseMatrixReportSchema = z.strictObject({
  schemaVersion: z.literal(1), projectId: id, artifactId: id, artifactVersion: hash,
  material: researchResponseMatrixMaterialSchema,
  review: researchResponseMatrixReceiptSchema.nullable(), reviewCurrent: z.boolean(),
  openCommentIds: id.array(), addressedCommentIds: id.array(), declinedCommentIds: id.array()
});
export const researchResponseMatrixInspectionSchema = z.strictObject({
  status: z.enum(['current', 'stale']), reportHash: hash, report: researchResponseMatrixReportSchema
});
export const researchResponseMatrixHistorySchema = z.strictObject({
  projectId: id, artifactId: id, offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100)
});
export const researchResponseMatrixHistoryResultSchema = z.strictObject({
  verification: z.literal('stored_receipt'), items: researchResponseMatrixReceiptSchema.array(),
  total: z.number().int().nonnegative()
});
export type ResearchResponseMatrixSave = z.infer<typeof researchResponseMatrixSaveSchema>;
export type ResearchResponseMatrixReceipt = z.infer<typeof researchResponseMatrixReceiptSchema>;
export type ResearchResponseMatrixMaterial = z.infer<typeof researchResponseMatrixMaterialSchema>;
export type ResearchResponseMatrixInspect = z.infer<typeof researchResponseMatrixInspectSchema>;
export type ResearchResponseMatrixInspection = z.infer<typeof researchResponseMatrixInspectionSchema>;
export type ResearchResponseMatrixHistory = z.infer<typeof researchResponseMatrixHistorySchema>;
