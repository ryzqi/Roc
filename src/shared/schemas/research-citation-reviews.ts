import {z} from 'zod';
import {researchClaimSchema} from './research-evidence';
import {researchInspectedEvidenceSchema} from './research-evidence-source';
import {researchRelationReviewerSchema} from './research-evidence-relations';

const id = z.string().trim().min(1);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const researchCitationReviewSaveSchema = z.strictObject({
  projectId: id, artifactId: id, claimId: id, evidenceId: id, requestId: id,
  expectedReportHash: hash,
  parent: z.strictObject({reviewId: id, reviewHash: hash}).nullable(),
  directness: z.enum(['direct', 'indirect', 'unsupported']),
  rationale: z.string().trim().min(1).max(12000)
});
export const researchCitationReviewSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1), id, version: z.number().int().positive(),
  request: researchCitationReviewSaveSchema, requestHash: hash,
  actor: researchRelationReviewerSchema, recordedAt: z.string().datetime(),
  material: z.strictObject({
    manuscriptHash: hash, artifactVersion: hash, claim: researchClaimSchema,
    claimHash: hash, source: researchInspectedEvidenceSchema, sourceDigest: hash
  })
});
export const researchCitationReviewReceiptSchema = z.strictObject({
  snapshot: researchCitationReviewSnapshotSchema, snapshotHash: hash
});
export const researchCitationReviewHeadSchema = z.strictObject({
  reviewId: id, reviewHash: hash, claimId: id, evidenceId: id, version: z.number().int().positive(),
  directness: researchCitationReviewSaveSchema.shape.directness, recordedAt: z.string().datetime()
});
export const researchCitationReviewHistorySchema = z.strictObject({
  projectId: id, artifactId: id, claimId: id, evidenceId: id,
  limit: z.number().int().min(1).max(50), offset: z.number().int().nonnegative()
});
export const researchCitationReviewHistoryResultSchema = z.strictObject({
  verification: z.literal('stored_receipt'),
  items: z.array(researchCitationReviewReceiptSchema), total: z.number().int().nonnegative()
});
export type ResearchCitationReviewSave = z.infer<typeof researchCitationReviewSaveSchema>;
export type ResearchCitationReviewReceipt = z.infer<typeof researchCitationReviewReceiptSchema>;
export type ResearchCitationReviewHistory = z.infer<typeof researchCitationReviewHistorySchema>;
export type ResearchCitationReviewHistoryResult = z.infer<typeof researchCitationReviewHistoryResultSchema>;
