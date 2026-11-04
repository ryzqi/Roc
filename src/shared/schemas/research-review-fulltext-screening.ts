import {z} from 'zod';
import {researchRelationReviewerSchema} from './research-evidence-relations';
import {researchReviewCorpusHitSchema} from './research-review-corpus';
import {researchReviewFullTextBindingInspectionSchema} from './research-review-fulltext';
import {
  researchReviewScreeningPlanGetSchema, researchReviewScreeningPlanInspectionSchema,
  researchReviewScreeningOutcomeSchema, researchReviewScreeningReviewerSchema,
  researchReviewScreeningSuggestionOriginSchema
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
