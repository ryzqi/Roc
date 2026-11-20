import {z} from 'zod';
import {researchReviewCorpusHitSchema} from './research-review-corpus';
import {researchReviewScreeningReviewerSchema} from './research-review-screening';
import {researchRelationReviewerSchema} from './research-evidence-relations';
const id=z.string().trim().min(1).max(300),hash=z.string().regex(/^[a-f0-9]{64}$/u),note=z.string().trim().min(1).max(10000);
export const researchReviewStudiesGetSchema=z.object({projectId:id,corpusId:id}).strict();
const group=z.object({
  studyId:id,label:id,reason:note,
  reports:z.array(z.object({hitId:id,expectedBindingHash:hash,sourceNote:note}).strict()).min(1).max(1620)
}).strict().refine(value=>new Set(value.reports.map(report=>report.hitId)).size===value.reports.length,'review_study_report_duplicate');
export const researchReviewStudiesSaveSchema=researchReviewStudiesGetSchema.extend({
  requestId:id,expectedFullFreezeHash:hash,groups:z.array(group).max(1620),reviewerId:id,reviewNote:note,
  parentGroupingId:id.nullable(),expectedParentHash:hash.nullable(),revisionReason:note.nullable()
}).strict().refine(value=>new Set(value.groups.map(group=>group.studyId)).size===value.groups.length,'review_study_id_duplicate')
  .refine(value=>value.parentGroupingId===null?value.expectedParentHash===null&&value.revisionReason===null:
    value.expectedParentHash!==null&&value.revisionReason!==null,'review_study_revision_requires_parent');
export const researchReviewStudiesSnapshotSchema=z.object({
  id,version:z.number().int().positive(),request:researchReviewStudiesSaveSchema,requestHash:hash,
  reports:z.array(z.object({hit:researchReviewCorpusHitSchema,binding:z.object({id,expectedHash:hash}).strict()}).strict()).max(1620),
  reviewer:researchReviewScreeningReviewerSchema,actor:researchRelationReviewerSchema,recordedAt:z.iso.datetime()
}).strict();
export const researchReviewStudiesInspectionSchema=z.object({
  snapshot:researchReviewStudiesSnapshotSchema,snapshotHash:hash,isLatest:z.boolean(),currentProtocol:z.boolean(),sourcesCurrent:z.boolean(),
  includedReports:z.number().int().nonnegative(),includedStudies:z.number().int().nonnegative()
}).strict().refine(value=>value.includedReports===value.snapshot.reports.length&&value.includedStudies===value.snapshot.request.groups.length,
  'review_study_counts_invalid');
export type ResearchReviewStudiesSave=z.infer<typeof researchReviewStudiesSaveSchema>;
export type ResearchReviewStudiesInspection=z.infer<typeof researchReviewStudiesInspectionSchema>;
