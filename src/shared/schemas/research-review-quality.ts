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
