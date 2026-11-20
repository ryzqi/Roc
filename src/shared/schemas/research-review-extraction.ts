import {z} from 'zod';
import {researchRelationReviewerSchema} from './research-evidence-relations';
import {researchReviewScreeningReviewerSchema} from './research-review-screening';
import {researchReviewCorpusHitSchema} from './research-review-corpus';
import {researchEvidenceSchema} from './research-evidence';
import {researchSourceLocatorSchema} from './research-source-locator';
import {researchReviewProtocolBodySchema} from './research-systematic-review';
const id=z.string().trim().min(1).max(300),hash=z.string().regex(/^[a-f0-9]{64}$/u),note=z.string().trim().min(1).max(10000);
const reference=z.object({id,expectedHash:hash}).strict();
const evidence=z.array(reference).min(1).max(10).refine(refs=>new Set(refs.map(ref=>ref.id)).size===refs.length,'review_extraction_evidence_duplicate');
const text=z.object({kind:z.literal('text'),text:note}).strict();
const missing=z.object({kind:z.literal('missing'),reason:note}).strict();
const unjudgeable=z.object({kind:z.literal('unjudgeable'),reason:note}).strict();
export const researchReviewExtractionSaveSchema=z.object({
  projectId:id,corpusId:id,hitId:id,requestId:id,expectedFullFreezeHash:hash,bindingId:id,expectedBindingHash:hash,
  reviewerId:id,reviewNote:note,
  studyDesign:z.object({value:z.discriminatedUnion('kind',[text,missing,unjudgeable]),evidence}).strict(),
  fields:z.array(z.object({
    fieldId:id,unit:id.nullable(),value:z.discriminatedUnion('kind',[
      text,z.object({kind:z.literal('number'),number:z.number()}).strict(),missing,unjudgeable
    ]),evidence
  }).strict()).min(1).max(50),
  parentExtractionId:id.nullable(),expectedParentHash:hash.nullable(),revisionReason:note.nullable()
}).strict().refine(value=>new Set(value.fields.map(field=>field.fieldId)).size===value.fields.length,'review_extraction_field_duplicate')
  .refine(value=>value.parentExtractionId===null?
    value.expectedParentHash===null&&value.revisionReason===null:
    value.expectedParentHash!==null&&value.revisionReason!==null,'review_extraction_revision_requires_parent');
export const researchReviewExtractionSourceSchema=z.object({
  evidence:researchEvidenceSchema,sourceLocator:researchSourceLocatorSchema,coordinateHash:hash.nullable(),digest:hash
}).strict();
export const researchReviewExtractionSnapshotSchema=z.object({
  id,version:z.number().int().positive(),request:researchReviewExtractionSaveSchema,requestHash:hash,
  protocolVersionId:id,protocolVersionHash:hash,hit:researchReviewCorpusHitSchema,
  fieldDefinitions:researchReviewProtocolBodySchema.shape.extractionFields,
  sources:z.array(researchReviewExtractionSourceSchema).min(1).max(510),
  reviewer:researchReviewScreeningReviewerSchema,actor:researchRelationReviewerSchema,recordedAt:z.iso.datetime()
}).strict();
export const researchReviewExtractionInspectionSchema=z.object({
  snapshot:researchReviewExtractionSnapshotSchema,snapshotHash:hash,isLatest:z.boolean(),currentProtocol:z.boolean(),
  referenceStatus:z.enum(['current','superseded'])
}).strict();
export const researchReviewExtractionGetSchema=z.object({projectId:id,corpusId:id,extractionId:id}).strict();
export const researchReviewExtractionHistorySchema=z.object({projectId:id,corpusId:id,hitId:id}).strict();
export const researchReviewExtractionListSchema=researchReviewExtractionHistorySchema.omit({hitId:true});
export type ResearchReviewExtractionSave=z.infer<typeof researchReviewExtractionSaveSchema>;
export type ResearchReviewExtractionInspection=z.infer<typeof researchReviewExtractionInspectionSchema>;
export type ResearchReviewExtractionSource=z.infer<typeof researchReviewExtractionSourceSchema>;
