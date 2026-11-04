import {z} from 'zod';
import {researchRelationReviewerSchema} from './research-evidence-relations';
import {researchReviewCorpusHitSchema} from './research-review-corpus';
import {researchReviewFullTextBindingInspectionSchema} from './research-review-fulltext';
import {
  researchReviewScreeningPlanGetSchema, researchReviewScreeningPlanInspectionSchema,
  researchReviewScreeningOutcomeSchema, researchReviewScreeningReviewerSchema,
  researchReviewScreeningSuggestionOriginSchema, researchReviewScreeningFinalOutcomeSchema
} from './research-review-screening';

const id=z.string().trim().min(1).max(300), hash=z.string().regex(/^[a-f0-9]{64}$/u);
const note=z.string().trim().min(1).max(10000);
const reference=z.object({id,expectedHash:hash}).strict();
const target=researchReviewScreeningPlanGetSchema.extend({
  phase:z.literal('full_text'),expectedPlanHash:hash,expectedTitleFreezeHash:hash,
  hitId:id,bindingId:id,expectedBindingHash:hash,requestId:id
});
export const researchReviewFullTextDecisionSaveSchema=target.extend({
  reviewerId:id,outcome:researchReviewScreeningOutcomeSchema,consideredSuggestion:reference.nullable(),
  parentDecisionId:id.nullable(),expectedParentHash:hash.nullable(),revisionReason:note.nullable()
}).refine(value=>value.parentDecisionId===null?
  value.expectedParentHash===null&&value.revisionReason===null:
  value.expectedParentHash!==null&&value.revisionReason!==null,'review_screening_revision_requires_parent');
export const researchReviewFullTextSuggestionCreateSchema=target.extend({outcome:researchReviewScreeningOutcomeSchema});
export const researchReviewFullTextSuggestionOriginSchema=researchReviewScreeningSuggestionOriginSchema.extend({
  capabilityName:z.literal('research.reviewFullTextScreening.suggest')
});
const material=z.object({hit:researchReviewCorpusHitSchema,binding:reference}).strict();
export const researchReviewFullTextDecisionSnapshotSchema=z.object({
  id,version:z.number().int().positive(),request:researchReviewFullTextDecisionSaveSchema,requestHash:hash,
  reviewer:researchReviewScreeningReviewerSchema,material,actor:researchRelationReviewerSchema,recordedAt:z.iso.datetime()
}).strict();
export const researchReviewFullTextDecisionInspectionSchema=z.object({
  snapshot:researchReviewFullTextDecisionSnapshotSchema,snapshotHash:hash,isLatest:z.boolean(),sourceCurrent:z.boolean()
}).strict();
export const researchReviewFullTextSuggestionSnapshotSchema=z.object({
  id,request:researchReviewFullTextSuggestionCreateSchema,requestHash:hash,material,
  origin:researchReviewFullTextSuggestionOriginSchema,recordedAt:z.iso.datetime()
}).strict();
export const researchReviewFullTextSuggestionInspectionSchema=z.object({
  snapshot:researchReviewFullTextSuggestionSnapshotSchema,snapshotHash:hash,sourceCurrent:z.boolean()
}).strict();
export const researchReviewFullTextDecisionHistorySchema=researchReviewScreeningPlanGetSchema.extend({decisionId:id});
export const researchReviewFullTextSuggestionListSchema=researchReviewScreeningPlanGetSchema.extend({
  phase:z.literal('full_text'),hitId:id,offset:z.number().int().nonnegative(),limit:z.number().int().min(1).max(30)
});
export const researchReviewFullTextPhaseGetSchema=researchReviewScreeningPlanGetSchema.extend({phase:z.literal('full_text')});
export const researchReviewFullTextPhaseInspectionSchema=z.object({
  plan:researchReviewScreeningPlanInspectionSchema,phase:z.literal('full_text'),titleFreezeHash:hash,
  items:z.array(z.object({
    hit:researchReviewCorpusHitSchema,binding:researchReviewFullTextBindingInspectionSchema.nullable(),
    decisions:z.array(researchReviewFullTextDecisionInspectionSchema).max(2),suggestionCount:z.number().int().nonnegative(),
    status:z.enum(['retrieval_pending','not_retrieved','source_changed','pending','uncertain','conflict','included','excluded'])
  }).strict()),
  counts:z.object({
    reportsToSeek:z.number().int().nonnegative(),retrieval_pending:z.number().int().nonnegative(),
    not_retrieved:z.number().int().nonnegative(),source_changed:z.number().int().nonnegative(),
    pending:z.number().int().nonnegative(),uncertain:z.number().int().nonnegative(),conflict:z.number().int().nonnegative(),
    included:z.number().int().nonnegative(),excluded:z.number().int().nonnegative()
  }).strict()
}).strict().refine(value=>value.counts.reportsToSeek===value.items.length&&value.counts.reportsToSeek===
  value.counts.retrieval_pending+value.counts.not_retrieved+value.counts.source_changed+value.counts.pending+
  value.counts.uncertain+value.counts.conflict+value.counts.included+value.counts.excluded,'review_fulltext_counts_not_conserved');
export type ResearchReviewFullTextDecisionSave=z.infer<typeof researchReviewFullTextDecisionSaveSchema>;
export type ResearchReviewFullTextDecisionInspection=z.infer<typeof researchReviewFullTextDecisionInspectionSchema>;
export type ResearchReviewFullTextSuggestionCreate=z.infer<typeof researchReviewFullTextSuggestionCreateSchema>;
export type ResearchReviewFullTextSuggestionOrigin=z.infer<typeof researchReviewFullTextSuggestionOriginSchema>;
export type ResearchReviewFullTextSuggestionInspection=z.infer<typeof researchReviewFullTextSuggestionInspectionSchema>;
export type ResearchReviewFullTextPhaseInspection=z.infer<typeof researchReviewFullTextPhaseInspectionSchema>;

export const researchReviewFullTextArbitrationSaveSchema=target.extend({
  reviewerId:id,outcome:researchReviewScreeningFinalOutcomeSchema,decisions:z.array(reference).min(1).max(2),
  parentArbitrationId:id.nullable(),expectedParentHash:hash.nullable(),revisionReason:note.nullable()
}).refine(value=>new Set(value.decisions.map(decision=>decision.id)).size===value.decisions.length,
  'review_screening_arbitration_decision_duplicate')
  .refine(value=>value.parentArbitrationId===null?
    value.expectedParentHash===null&&value.revisionReason===null:
    value.expectedParentHash!==null&&value.revisionReason!==null,'review_screening_arbitration_revision_requires_parent');
export const researchReviewFullTextArbitrationSnapshotSchema=z.object({
  id,version:z.number().int().positive(),request:researchReviewFullTextArbitrationSaveSchema,requestHash:hash,
  adjudicator:researchReviewScreeningReviewerSchema,material,actor:researchRelationReviewerSchema,recordedAt:z.iso.datetime()
}).strict();
export const researchReviewFullTextArbitrationInspectionSchema=z.object({
  snapshot:researchReviewFullTextArbitrationSnapshotSchema,snapshotHash:hash,isLatest:z.boolean(),currentDecisionSet:z.boolean()
}).strict();
export const researchReviewFullTextArbitrationHistorySchema=researchReviewScreeningPlanGetSchema.extend({arbitrationId:id});
export const researchReviewFullTextResolvedPhaseSchema=researchReviewFullTextPhaseInspectionSchema.safeExtend({
  items:z.array(researchReviewFullTextPhaseInspectionSchema.shape.items.element.extend({
    arbitration:researchReviewFullTextArbitrationInspectionSchema.nullable()
  }))
});
export type ResearchReviewFullTextArbitrationSave=z.infer<typeof researchReviewFullTextArbitrationSaveSchema>;
export type ResearchReviewFullTextArbitrationInspection=z.infer<typeof researchReviewFullTextArbitrationInspectionSchema>;
export type ResearchReviewFullTextResolvedPhase=z.infer<typeof researchReviewFullTextResolvedPhaseSchema>;

export const researchReviewFullTextAuthoritySchema=z.object({
  corpusId:id,corpusHash:hash,planId:id,planHash:hash,titleFreezeHash:hash,phase:z.literal('full_text'),
  items:z.array(z.object({
    hit:researchReviewCorpusHitSchema,binding:reference.nullable(),
    status:researchReviewFullTextPhaseInspectionSchema.shape.items.element.shape.status,
    decisions:z.array(reference).max(2),arbitration:reference.nullable(),primaryExclusionCriterionId:id.nullable()
  }).strict()),
  counts:researchReviewFullTextPhaseInspectionSchema.shape.counts
}).strict();
export const researchReviewFullTextFreezeRequestSchema=researchReviewFullTextPhaseGetSchema.extend({
  requestId:id,expectedReviewHash:hash,reviewNote:note
});
export const researchReviewFullTextFreezeReceiptSchema=z.object({
  request:researchReviewFullTextFreezeRequestSchema,requestHash:hash,authority:researchReviewFullTextAuthoritySchema,
  reviewHash:hash,actor:researchRelationReviewerSchema,frozenAt:z.iso.datetime()
}).strict().refine(value=>value.authority.counts.retrieval_pending===0&&value.authority.counts.source_changed===0&&
  value.authority.counts.pending===0&&value.authority.counts.uncertain===0&&value.authority.counts.conflict===0&&
  value.authority.items.every(item=>item.binding!==null&&
    (item.status==='not_retrieved'||item.status==='included'||item.status==='excluded')&&
    (item.status==='excluded')===(item.primaryExclusionCriterionId!==null))&&
  value.authority.counts.reportsToSeek===value.authority.items.length&&value.authority.counts.reportsToSeek===
    value.authority.counts.not_retrieved+value.authority.counts.included+value.authority.counts.excluded,
  'review_fulltext_freeze_requires_complete_set');
export const researchReviewFullTextFrozenPhaseSchema=researchReviewFullTextResolvedPhaseSchema.safeExtend({
  reviewHash:hash,freeze:researchReviewFullTextFreezeReceiptSchema.nullable(),freezeHash:hash.nullable(),sourcesCurrent:z.boolean()
}).refine(value=>(value.freeze===null)===(value.freezeHash===null),'review_screening_freeze_receipt_required');
export type ResearchReviewFullTextAuthority=z.infer<typeof researchReviewFullTextAuthoritySchema>;
export type ResearchReviewFullTextFreezeRequest=z.infer<typeof researchReviewFullTextFreezeRequestSchema>;
export type ResearchReviewFullTextFreezeReceipt=z.infer<typeof researchReviewFullTextFreezeReceiptSchema>;
export type ResearchReviewFullTextFrozenPhase=z.infer<typeof researchReviewFullTextFrozenPhaseSchema>;
