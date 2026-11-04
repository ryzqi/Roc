import {z} from 'zod';
import {researchReviewProtocolBodySchema} from './research-systematic-review';
import {researchRelationReviewerSchema} from './research-evidence-relations';
import {researchReviewScreeningReviewerSchema} from './research-review-screening';
const id=z.string().trim().min(1).max(300),hash=z.string().regex(/^[a-f0-9]{64}$/u),note=z.string().trim().min(1).max(10000);
const choices=z.array(id).min(2).max(10).refine(values=>new Set(values).size===values.length,'review_quality_judgements_duplicate');
export const researchReviewQualityPlanCreateSchema=z.object({
  projectId:id,corpusId:id,hitId:id,requestId:id,extractionId:id,expectedExtractionHash:hash,
  framework:researchReviewProtocolBodySchema.shape.qualityAssessment.element,
  definition:z.object({
    origin:z.literal('user_declared'),documentationNote:note,
    domains:z.array(z.object({id,label:id,question:note,judgements:choices}).strict()).min(1).max(50),
    overallJudgements:choices
  }).strict(),
  reviewerId:id,reviewNote:note
}).strict().refine(value=>new Set(value.definition.domains.map(domain=>domain.id)).size===value.definition.domains.length,
  'review_quality_domains_duplicate');
export const researchReviewQualityPlanSnapshotSchema=z.object({
  id,request:researchReviewQualityPlanCreateSchema,requestHash:hash,protocolVersionId:id,protocolVersionHash:hash,
  reviewer:researchReviewScreeningReviewerSchema,actor:researchRelationReviewerSchema,recordedAt:z.iso.datetime()
}).strict();
export const researchReviewQualityPlanInspectionSchema=z.object({
  snapshot:researchReviewQualityPlanSnapshotSchema,snapshotHash:hash,currentExtraction:z.boolean(),currentProtocol:z.boolean(),
  referenceStatus:z.enum(['current','superseded'])
}).strict();
export const researchReviewQualityPlanGetSchema=z.object({projectId:id,corpusId:id,extractionId:id}).strict();
export const researchReviewQualityPlansListSchema=researchReviewQualityPlanGetSchema.omit({extractionId:true});
export type ResearchReviewQualityPlanCreate=z.infer<typeof researchReviewQualityPlanCreateSchema>;
export type ResearchReviewQualityPlanInspection=z.infer<typeof researchReviewQualityPlanInspectionSchema>;

const references=z.array(z.object({id,expectedHash:hash}).strict()).min(1).max(10)
  .refine(values=>new Set(values.map(value=>value.id)).size===values.length,'review_quality_evidence_duplicate');
const assessmentValue=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('judged'),judgement:id,reason:note}).strict(),
  z.object({kind:z.literal('unjudgeable'),reason:note}).strict()
]);
export const researchReviewQualityAssessmentGetSchema=z.object({projectId:id,corpusId:id,extractionId:id,qualityPlanId:id}).strict();
export const researchReviewQualityAssessmentSaveSchema=researchReviewQualityAssessmentGetSchema.extend({
  requestId:id,expectedPlanHash:hash,expectedExtractionHash:hash,
  domains:z.array(z.object({domainId:id,value:assessmentValue,evidence:references}).strict()).min(1).max(50),
  overall:z.object({value:assessmentValue,evidence:references}).strict(),
  reviewerId:id,reviewNote:note,parentAssessmentId:id.nullable(),expectedParentHash:hash.nullable(),revisionReason:note.nullable()
}).strict().refine(value=>new Set(value.domains.map(domain=>domain.domainId)).size===value.domains.length,
  'review_quality_domains_duplicate').refine(value=>value.parentAssessmentId===null?
  value.expectedParentHash===null&&value.revisionReason===null:
  value.expectedParentHash!==null&&value.revisionReason!==null,'review_quality_revision_requires_parent');
export const researchReviewQualityAssessmentSnapshotSchema=z.object({
  id,version:z.number().int().positive(),request:researchReviewQualityAssessmentSaveSchema,requestHash:hash,
  reviewer:researchReviewScreeningReviewerSchema,actor:researchRelationReviewerSchema,recordedAt:z.iso.datetime()
}).strict();
export const researchReviewQualityAssessmentInspectionSchema=z.object({
  snapshot:researchReviewQualityAssessmentSnapshotSchema,snapshotHash:hash,isLatest:z.boolean(),currentExtraction:z.boolean(),
  currentProtocol:z.boolean(),referenceStatus:z.enum(['current','superseded'])
}).strict();
export type ResearchReviewQualityAssessmentSave=z.infer<typeof researchReviewQualityAssessmentSaveSchema>;
export type ResearchReviewQualityAssessmentInspection=z.infer<typeof researchReviewQualityAssessmentInspectionSchema>;
