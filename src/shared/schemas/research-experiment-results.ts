import {z} from 'zod';
import {researchExperimentPathSchema, researchExperimentFileSchema} from './research-experiments';
import {researchRelationReviewerSchema} from './research-evidence-relations';

const id=z.string().trim().min(1).max(128);
const text=z.string().trim().min(1).max(4000);
const digest=z.string().regex(/^[a-f0-9]{64}$/u);
const unavailable=z.strictObject({kind:z.literal('unavailable'),reason:text});
const interval=z.strictObject({kind:z.literal('recorded'),lower:z.number(),upper:z.number(),
  confidence:z.number().gt(0).lt(1)}).refine(value=>value.lower<=value.upper,{message:'research_result_interval_invalid'});

export const researchExperimentMetricSchema=z.strictObject({
  id,value:z.number(),unit:id,sampleSize:z.number().int().positive(),
  uncertainty:z.discriminatedUnion('kind',[
    unavailable,z.strictObject({kind:z.literal('recorded'),type:z.enum(['standard_deviation','standard_error']),value:z.number().nonnegative()})
  ]),
  confidenceInterval:z.union([unavailable,interval]),
  effect:z.discriminatedUnion('kind',[
    unavailable,z.strictObject({kind:z.literal('recorded'),name:id,value:z.number(),unit:id})
  ])
});
export const researchExperimentResultFileSchema=z.strictObject({
  schemaVersion:z.literal(1),metrics:z.array(researchExperimentMetricSchema).min(1).max(100)
}).refine(value=>new Set(value.metrics.map(metric=>metric.id)).size===value.metrics.length,
  {message:'research_result_duplicate_metric'});
export const researchExperimentMetricDefinitionSchema=z.strictObject({
  id,label:id,definition:text,unit:id,direction:z.enum(['higher','lower','neutral'])
});
export const researchExperimentResultReviewSchema=z.strictObject({
  projectId:id,requestId:id,runId:id,expectedInputHash:digest,
  resultPath:researchExperimentPathSchema,expectedResultHash:digest,
  definitions:z.array(researchExperimentMetricDefinitionSchema).min(1).max(100),
  method:z.strictObject({name:id,rationale:text,assumptions:text,limitations:text})
}).refine(value=>new Set(value.definitions.map(metric=>metric.id)).size===value.definitions.length,
  {message:'research_result_duplicate_definition'});
export const researchExperimentResultGetSchema=z.strictObject({projectId:id,resultId:id,expectedHash:digest});
export const researchExperimentResultEvidenceCaptureSchema=researchExperimentResultGetSchema.extend({metricId:id});
export const researchExperimentResultEvidenceGetSchema=z.strictObject({projectId:id,evidenceId:id});
export const researchExperimentResultEvidenceMetadataSchema=z.strictObject({
  type:z.literal('experiment-result'),resultId:id,resultHash:digest,metricId:id,runId:id,
  area:z.literal('output'),path:researchExperimentPathSchema,sha256:digest,
  pointer:z.string().regex(/^\/metrics\/\d+$/u)
});
export const researchExperimentResultListSchema=z.strictObject({projectId:id,runId:id,offset:z.number().int().nonnegative(),
  limit:z.number().int().min(1).max(100)});
export const researchExperimentResultSnapshotSchema=z.strictObject({
  schemaVersion:z.literal(1),id,request:researchExperimentResultReviewSchema,actor:researchRelationReviewerSchema,recordedAt:text,
  result:researchExperimentResultFileSchema,
  execution:z.strictObject({
    runId:id,inputHash:digest,engine:z.enum(['typescript','python','r','julia']),environmentHash:digest,
    source:researchExperimentFileSchema,output:researchExperimentFileSchema,
    inputs:z.array(researchExperimentFileSchema).max(500),
    parameters:z.record(z.string(),z.string()),arguments:z.array(z.string()).max(100),seed:z.number().int().nonnegative().nullable()
  })
});
export const researchExperimentResultReceiptSchema=z.strictObject({
  snapshot:researchExperimentResultSnapshotSchema,snapshotHash:digest
});
export const researchExperimentResultEvidenceTraceSchema=z.strictObject({receipt:researchExperimentResultReceiptSchema,metricId:id});
export const researchExperimentResultListResultSchema=z.strictObject({items:researchExperimentResultReceiptSchema.array(),total:z.number().int().nonnegative()});
export const researchExperimentCompareSchema=z.strictObject({
  projectId:id,left:researchExperimentResultGetSchema.omit({projectId:true}),right:researchExperimentResultGetSchema.omit({projectId:true})
});
export const researchExperimentComparisonSchema=z.strictObject({
  left:researchExperimentResultReceiptSchema,right:researchExperimentResultReceiptSchema,
  comparable:z.boolean(),differences:z.array(z.enum(['data','metric_definitions','units','environment','parameters','seed','method']))
});
export type ResearchExperimentResultReview=z.infer<typeof researchExperimentResultReviewSchema>;
export type ResearchExperimentResultReceipt=z.infer<typeof researchExperimentResultReceiptSchema>;
export type ResearchExperimentResultGet=z.infer<typeof researchExperimentResultGetSchema>;
export type ResearchExperimentResultEvidenceCapture=z.infer<typeof researchExperimentResultEvidenceCaptureSchema>;
export type ResearchExperimentResultEvidenceGet=z.infer<typeof researchExperimentResultEvidenceGetSchema>;
export type ResearchExperimentResultEvidenceMetadata=z.infer<typeof researchExperimentResultEvidenceMetadataSchema>;
export type ResearchExperimentResultEvidenceTrace=z.infer<typeof researchExperimentResultEvidenceTraceSchema>;
export type ResearchExperimentResultList=z.infer<typeof researchExperimentResultListSchema>;
export type ResearchExperimentCompare=z.infer<typeof researchExperimentCompareSchema>;
export type ResearchExperimentComparison=z.infer<typeof researchExperimentComparisonSchema>;
