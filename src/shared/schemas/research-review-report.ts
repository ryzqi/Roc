import {z} from 'zod';
import {researchReviewCorpusGetSchema,researchReviewCorpusHitSchema,researchReviewCorpusSourceSchema} from './research-review-corpus';
import {literatureRankedRecordSchema} from './literature-search-pool';
import {researchReviewProtocolVersionSchema,researchReviewProtocolFreezeSchema} from './research-systematic-review';
import {researchReviewSearchInspectionSchema} from './research-review-search';
import {researchReviewDeduplicationReceiptSchema} from './research-review-deduplication';
import {researchReviewScreeningFreezeReceiptSchema} from './research-review-screening';
import {researchReviewFullTextFreezeReceiptSchema} from './research-review-fulltext-screening';
import {researchReviewStudiesSnapshotSchema} from './research-review-studies';
import {researchReviewExtractionSnapshotSchema,researchReviewExtractionInspectionSchema} from './research-review-extraction';
import {
  researchReviewQualityPlanSnapshotSchema,researchReviewQualityAssessmentSnapshotSchema,
  researchReviewQualityPlanInspectionSchema,researchReviewQualityAssessmentInspectionSchema
} from './research-review-quality';
const id=z.string().trim().min(1).max(300),hash=z.string().regex(/^[a-f0-9]{64}$/u),number=z.number().int().nonnegative();
const sealed=<T>(schema:z.ZodType<T>)=>z.object({snapshot:schema,snapshotHash:hash}).strict();
const reference=z.object({id,expectedHash:hash}).strict();
export const researchReviewReportGetSchema=researchReviewCorpusGetSchema;
export const researchReviewReportBodySchema=z.object({
  format:z.literal('roc.review-report.v1'),projectId:id,corpusId:id,
  basis:z.object({protocolVersionHash:hash,protocolFreezeHash:hash,corpusHash:hash,dedupFreezeHash:hash,
    titleFreezeHash:hash,fullFreezeHash:hash}).strict(),
  protocol:z.object({version:researchReviewProtocolVersionSchema,freeze:researchReviewProtocolFreezeSchema}).strict(),
  deduplication:researchReviewDeduplicationReceiptSchema,title:researchReviewScreeningFreezeReceiptSchema,
  fullText:researchReviewFullTextFreezeReceiptSchema,studyGrouping:sealed(researchReviewStudiesSnapshotSchema).nullable(),
  counts:z.object({identifiedRecords:number,removedDuplicates:number,recordsScreened:number,recordsExcluded:number,
    reportsSought:number,reportsNotRetrieved:number,reportsAssessed:number,reportsExcluded:number,includedReports:number,
    includedStudies:number.nullable()}).strict(),
  searchCoverageComplete:z.boolean(),
  queries:z.array(z.object({source:researchReviewCorpusSourceSchema,search:researchReviewSearchInspectionSchema}).strict()).min(1).max(18),
  records:z.array(z.object({hit:researchReviewCorpusHitSchema,record:literatureRankedRecordSchema}).strict()).max(1620),
  exclusions:z.array(z.object({hit:researchReviewCorpusHitSchema,phase:z.enum(['title_abstract','full_text']),
    criterion:z.object({id,text:z.string().min(1)}).strict(),decisions:z.array(reference),arbitration:reference.nullable(),
    binding:reference.nullable()}).strict()).max(1620),
  evidenceTable:z.array(z.object({hit:researchReviewCorpusHitSchema,
    extraction:sealed(researchReviewExtractionSnapshotSchema).nullable(),qualityPlan:sealed(researchReviewQualityPlanSnapshotSchema).nullable(),
    assessment:sealed(researchReviewQualityAssessmentSnapshotSchema).nullable()}).strict()).max(1620)
}).strict().superRefine((body,context)=>{
  const c=body.counts;
  if(c.identifiedRecords!==c.removedDuplicates+c.recordsScreened||c.recordsScreened!==c.recordsExcluded+c.reportsSought||
    c.reportsSought!==c.reportsNotRetrieved+c.reportsAssessed||c.reportsAssessed!==c.reportsExcluded+c.includedReports||
    c.identifiedRecords!==body.deduplication.identifiedRecords||c.removedDuplicates!==body.deduplication.removedDuplicates||
    c.recordsScreened!==body.title.authority.counts.recordsToScreen||c.recordsExcluded!==body.title.authority.counts.excluded||
    c.reportsSought!==body.fullText.authority.counts.reportsToSeek||c.reportsNotRetrieved!==body.fullText.authority.counts.not_retrieved||
    c.reportsExcluded!==body.fullText.authority.counts.excluded||c.includedReports!==body.fullText.authority.counts.included||
    c.identifiedRecords!==body.records.length||c.includedReports!==body.evidenceTable.length||
    c.recordsExcluded!==body.exclusions.filter(item=>item.phase==='title_abstract').length||
    c.reportsExcluded!==body.exclusions.filter(item=>item.phase==='full_text').length||
    (body.studyGrouping===null?c.includedStudies!==null:c.includedStudies!==body.studyGrouping.snapshot.request.groups.length)) {
    context.addIssue({code:'custom',message:'review_report_counts_not_conserved'});
  }
});
export const researchReviewReportInspectionSchema=z.object({
  body:researchReviewReportBodySchema,bodyHash:hash,currentProtocol:z.boolean(),sourcesCurrent:z.boolean(),
  evidenceStatus:z.array(z.object({hitId:id,
    extraction:researchReviewExtractionInspectionSchema.pick({isLatest:true,currentProtocol:true,referenceStatus:true}).nullable(),
    qualityPlan:researchReviewQualityPlanInspectionSchema.pick({currentExtraction:true,currentProtocol:true,referenceStatus:true}).nullable(),
    assessment:researchReviewQualityAssessmentInspectionSchema.pick({isLatest:true,currentExtraction:true,currentProtocol:true,referenceStatus:true}).nullable()
  }).strict()).max(1620)
}).strict();
export type ResearchReviewReportInspection=z.infer<typeof researchReviewReportInspectionSchema>;
