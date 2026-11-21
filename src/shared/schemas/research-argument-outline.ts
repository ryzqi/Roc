import {z} from 'zod';
import {researchClaimSchema} from './research-evidence';
import {researchInspectedEvidenceSchema} from './research-evidence-source';
import {researchEvidenceRelationSchema, researchRelationReviewerSchema} from './research-evidence-relations';

const id = z.string().trim().min(1).max(300), hash = z.string().regex(/^[a-f0-9]{64}$/u);
const text = z.string().trim().min(1).max(12000);
const scope = z.strictObject({projectId: id, artifactId: id});
export const researchArgumentOutlineSectionSchema = z.strictObject({
  id, title: z.string().trim().min(1).max(300), question: text,
  claimIds: id.array().min(1).max(200), conditions: text.array().max(100), gaps: text.array().max(100)
});
export const researchArgumentOutlineSaveSchema = scope.extend({
  expectedArtifactVersion: hash, expectedMatrixHash: hash, requestId: id,
  parent: z.strictObject({outlineId: id, outlineHash: hash}).nullable(),
  sections: researchArgumentOutlineSectionSchema.array().min(1).max(100), rationale: text
}).superRefine((value, ctx) => {
  const ids = value.sections.flatMap(section => section.claimIds);
  if (new Set(ids).size !== ids.length || new Set(value.sections.map(section => section.id)).size !== value.sections.length) {
    ctx.addIssue({code: 'custom', message: 'research_argument_outline_duplicate'});
  }
});
export const researchArgumentOutlineReceiptSchema = z.strictObject({
  snapshot: z.strictObject({schemaVersion: z.literal(1), id, version: z.number().int().positive(),
    request: researchArgumentOutlineSaveSchema, requestHash: hash,
    claims: z.strictObject({claimId: id, expectedClaimHash: hash}).array().min(1).max(20000), materialHash: hash,
    actor: researchRelationReviewerSchema, recordedAt: z.string().datetime()}), snapshotHash: hash
});
export const researchArgumentOutlineInspectSchema = scope;
export const researchArgumentOutlineInspectionSchema = scope.extend({
  artifactVersion: hash, matrixHash: hash,
  matrix: z.strictObject({claim: researchClaimSchema, claimHash: hash,
    sources: researchInspectedEvidenceSchema.array(), relations: researchEvidenceRelationSchema.safeExtend({current: z.boolean()}).array(),
    gaps: z.string().min(1).array()}).array(),
  latest: researchArgumentOutlineReceiptSchema.nullable(), latestCurrent: z.boolean()
});
export const researchArgumentOutlineHistorySchema = scope.extend({offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100)});
export const researchArgumentOutlineHistoryResultSchema = z.strictObject({verification: z.literal('stored_receipt'),
  items: researchArgumentOutlineReceiptSchema.array(), total: z.number().int().nonnegative()});
export const researchArgumentOutlineMaterializeSchema = z.strictObject({
  projectId: id, outlineId: id, expectedOutlineHash: hash, expectedMatrixHash: hash, requestId: id,
  target: z.discriminatedUnion('kind', [z.strictObject({kind: z.literal('new'), title: z.string().trim().min(1).max(300)}),
    z.strictObject({kind: z.literal('existing'), artifactId: id, expectedVersion: hash})])
});
export const researchArgumentOutlineMaterializedSchema = z.strictObject({
  materializationId: id, artifactId: id, artifactVersion: hash, manuscriptHash: hash, outlineId: id, outlineHash: hash,
  claims: z.strictObject({sourceClaimId: id, claimId: id}).array().min(1)
});
export type ResearchArgumentOutlineSave = z.infer<typeof researchArgumentOutlineSaveSchema>;
export type ResearchArgumentOutlineReceipt = z.infer<typeof researchArgumentOutlineReceiptSchema>;
export type ResearchArgumentOutlineInspect = z.infer<typeof researchArgumentOutlineInspectSchema>;
export type ResearchArgumentOutlineInspection = z.infer<typeof researchArgumentOutlineInspectionSchema>;
export type ResearchArgumentOutlineHistory = z.infer<typeof researchArgumentOutlineHistorySchema>;
export type ResearchArgumentOutlineHistoryResult = z.infer<typeof researchArgumentOutlineHistoryResultSchema>;
export type ResearchArgumentOutlineMaterialize = z.infer<typeof researchArgumentOutlineMaterializeSchema>;
export type ResearchArgumentOutlineMaterialized = z.infer<typeof researchArgumentOutlineMaterializedSchema>;
