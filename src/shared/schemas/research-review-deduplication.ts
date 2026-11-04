import {z} from 'zod';
import {researchReviewCorpusHitSchema, researchReviewCorpusSourceSchema} from './research-review-corpus';
import {researchRelationReviewerSchema} from './research-evidence-relations';

const id = z.string().trim().min(1).max(300);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const note = z.string().trim().min(1).max(10000);
export const researchReviewDuplicateSaveSchema = z.object({
  projectId: id, corpusId: id, expectedCorpusHash: hash, requestId: id,
  leftHitId: id, rightHitId: id, decision: z.enum(['duplicate', 'distinct']),
  rule: z.object({name: id, version: id}).strict(), reason: note,
  parentDecisionId: id.nullable(), expectedParentHash: hash.nullable(), revisionReason: note.nullable()
}).strict().refine(value => value.leftHitId !== value.rightHitId, 'review_duplicate_same_hit')
  .refine(value => value.parentDecisionId === null ?
    value.expectedParentHash === null && value.revisionReason === null :
    value.expectedParentHash !== null && value.revisionReason !== null, 'review_duplicate_revision_requires_parent');
const endpoint = z.object({hit: researchReviewCorpusHitSchema, source: researchReviewCorpusSourceSchema}).strict();
export const researchReviewDuplicateSnapshotSchema = z.object({
  id, pairKey: hash, version: z.number().int().positive(),
  request: researchReviewDuplicateSaveSchema, requestHash: hash,
  left: endpoint, right: endpoint, actor: researchRelationReviewerSchema, recordedAt: z.iso.datetime()
}).strict();
export const researchReviewDuplicateInspectionSchema = z.object({
  snapshot: researchReviewDuplicateSnapshotSchema, snapshotHash: hash, isLatest: z.boolean()
}).strict();
export const researchReviewDeduplicationGetSchema = z.object({projectId: id, corpusId: id}).strict();
export const researchReviewDuplicateHistorySchema = researchReviewDeduplicationGetSchema.extend({decisionId: id});
export const researchReviewDuplicateReferenceSchema = z.object({decisionId: id, expectedHash: hash}).strict();
export const researchReviewDeduplicationFreezeSchema = researchReviewDeduplicationGetSchema.extend({
  requestId: id, expectedCorpusHash: hash, decisions: z.array(researchReviewDuplicateReferenceSchema), reviewNote: note
}).refine(value => new Set(value.decisions.map(decision => decision.decisionId)).size === value.decisions.length,
  'review_duplicate_freeze_repeated_decision');
export const researchReviewDeduplicationReceiptSchema = z.object({
  request: researchReviewDeduplicationFreezeSchema, requestHash: hash,
  decisions: z.array(researchReviewDuplicateReferenceSchema),
  removed: z.array(z.object({hitId: id, retainedHitId: id}).strict()),
  screenableHitIds: z.array(id), identifiedRecords: z.number().int().nonnegative(),
  removedDuplicates: z.number().int().nonnegative(), recordsToScreen: z.number().int().nonnegative(),
  actor: researchRelationReviewerSchema, frozenAt: z.iso.datetime()
}).strict().refine(value => value.identifiedRecords === value.removedDuplicates + value.recordsToScreen &&
  value.removed.length === value.removedDuplicates && value.screenableHitIds.length === value.recordsToScreen,
  'review_duplicate_counts_not_conserved');
export const researchReviewDeduplicationInspectionSchema = z.object({
  corpusId: id, corpusHash: hash, currentProtocol: z.boolean(),
  decisions: z.array(researchReviewDuplicateInspectionSchema),
  freeze: researchReviewDeduplicationReceiptSchema.nullable(), freezeHash: hash.nullable()
}).strict().refine(value => (value.freeze === null) === (value.freezeHash === null), 'review_duplicate_freeze_receipt_required');

export type ResearchReviewDuplicateSave = z.infer<typeof researchReviewDuplicateSaveSchema>;
export type ResearchReviewDuplicateSnapshot = z.infer<typeof researchReviewDuplicateSnapshotSchema>;
export type ResearchReviewDuplicateInspection = z.infer<typeof researchReviewDuplicateInspectionSchema>;
export type ResearchReviewDeduplicationFreeze = z.infer<typeof researchReviewDeduplicationFreezeSchema>;
export type ResearchReviewDeduplicationInspection = z.infer<typeof researchReviewDeduplicationInspectionSchema>;
