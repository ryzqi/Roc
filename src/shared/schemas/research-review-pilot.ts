import {z} from 'zod';
import {researchReviewProtocolBodySchema} from './research-systematic-review';
import {researchReviewExtractionSaveSchema} from './research-review-extraction';

const id = z.string().trim().min(1).max(300), hash = z.string().regex(/^[a-f0-9]{64}$/u);
const ref = z.strictObject({id, hash});
export const researchReviewPilotRequestSchema = z.strictObject({
  projectId: id, corpusId: id, expectedFullFreezeHash: hash, expectedProtocolVersionHash: hash,
  hitIds: id.array().min(1).max(5).refine(ids => new Set(ids).size === ids.length), expectedReportHash: hash.nullable()
});
export const researchReviewPilotCellSchema = z.strictObject({
  fieldId: id, label: z.string(), unit: id.nullable(), required: z.boolean(),
  status: z.enum(['recorded', 'missing', 'unjudgeable', 'unextracted', 'stale']),
  value: researchReviewExtractionSaveSchema.shape.fields.element.shape.value.nullable(), evidenceIds: id.array(), reason: z.string().nullable()
});
export const researchReviewPilotIssueSchema = z.strictObject({
  code: id, hitId: id.nullable(), fieldId: id.nullable(), detail: z.string()
});
export const researchReviewPilotReportSchema = z.strictObject({
  projectId: id, corpusId: id, reportHash: hash, status: z.enum(['current', 'stale']), attentionRequired: z.boolean(),
  protocolVersionId: id, protocolVersionHash: hash, fullFreezeHash: hash,
  fieldDefinitions: researchReviewProtocolBodySchema.shape.extractionFields,
  samples: z.strictObject({hitId: id, title: z.string(), binding: ref.nullable(), extraction: ref.nullable(),
    sourceStatus: z.enum(['byte_checked', 'stale', 'unavailable']),
    studyDesign: researchReviewPilotCellSchema, fields: researchReviewPilotCellSchema.array()
  }).array().min(1).max(5),
  issues: researchReviewPilotIssueSchema.array().max(300),
  nextActions: z.strictObject({actor: z.literal('human'), action: z.enum(['reread_protocol', 'review_binding', 'extract_sample', 'review_field']),
    hitId: id.nullable(), fieldId: id.nullable(), detail: z.string()}).array().max(20)
});
export type ResearchReviewPilotRequest = z.infer<typeof researchReviewPilotRequestSchema>;
export type ResearchReviewPilotReport = z.infer<typeof researchReviewPilotReportSchema>;
export type ResearchReviewPilotCell = z.infer<typeof researchReviewPilotCellSchema>;
