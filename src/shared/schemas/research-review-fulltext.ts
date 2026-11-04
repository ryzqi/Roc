import {z} from 'zod';
import {researchReviewCorpusHitSchema, researchReviewCorpusSourceSchema} from './research-review-corpus';
import {researchRelationReviewerSchema} from './research-evidence-relations';
const id=z.string().trim().min(1).max(300);
const hash=z.string().regex(/^[a-f0-9]{64}$/u);
const note=z.string().trim().min(1).max(10000);
const selection=z.object({documentId:id,sourceHash:hash,parseId:id.nullable(),parseHash:hash.nullable()}).strict()
  .refine(value=>(value.parseId===null)===(value.parseHash===null),'review_fulltext_parse_pair_required');
export const researchReviewFullTextBindingSaveSchema=z.object({
  projectId:id,corpusId:id,hitId:id,requestId:id,expectedTitleFreezeHash:hash,
  outcome:z.discriminatedUnion('kind',[
    z.object({kind:z.literal('retrieved'),selection,relationNote:note}).strict(),
    z.object({kind:z.literal('not_retrieved'),reason:note}).strict()
  ]),
  parentBindingId:id.nullable(),expectedParentHash:hash.nullable(),revisionReason:note.nullable()
}).strict().refine(value=>value.parentBindingId===null?
  value.expectedParentHash===null&&value.revisionReason===null:
  value.expectedParentHash!==null&&value.revisionReason!==null,'review_fulltext_revision_requires_parent');
export const researchReviewFullTextSourceSchema=z.object({
  documentId:id,libraryItemId:id,sourceHash:hash,filename:id,mediaType:id,size:z.number().int().nonnegative(),
  parse:z.object({id,hash,parserFingerprint:hash,pageCount:z.number().int().nonnegative(),coordinateHash:hash.nullable()}).strict().nullable()
}).strict();
export const researchReviewFullTextBindingSnapshotSchema=z.object({
  id,version:z.number().int().positive(),request:researchReviewFullTextBindingSaveSchema,requestHash:hash,
  hit:researchReviewCorpusHitSchema,searchSource:researchReviewCorpusSourceSchema,
  source:researchReviewFullTextSourceSchema.nullable(),actor:researchRelationReviewerSchema,recordedAt:z.iso.datetime()
}).strict().refine(value=>(value.request.outcome.kind==='not_retrieved')===(value.source===null),
  'review_fulltext_retrieved_source_required');
export const researchReviewFullTextBindingInspectionSchema=z.object({
  snapshot:researchReviewFullTextBindingSnapshotSchema,snapshotHash:hash,isLatest:z.boolean(),currentProtocol:z.boolean(),
  referenceStatus:z.enum(['current','superseded','not_retrieved'])
}).strict();
export const researchReviewFullTextBindingGetSchema=z.object({projectId:id,corpusId:id,bindingId:id}).strict();
export const researchReviewFullTextBindingListSchema=z.object({projectId:id,corpusId:id,hitId:id}).strict();
export const researchReviewFullTextBindingsListSchema=researchReviewFullTextBindingListSchema.omit({hitId:true});
export const researchReviewFullTextBindingVerifySchema=researchReviewFullTextBindingGetSchema.extend({expectedBindingHash:hash});
export type ResearchReviewFullTextBindingSave=z.infer<typeof researchReviewFullTextBindingSaveSchema>;
export type ResearchReviewFullTextBindingInspection=z.infer<typeof researchReviewFullTextBindingInspectionSchema>;
export type ResearchReviewFullTextSource=z.infer<typeof researchReviewFullTextSourceSchema>;
