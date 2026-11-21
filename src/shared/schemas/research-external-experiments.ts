import {z} from 'zod';
import {researchExperimentMetricDefinitionSchema, researchExperimentResultFileSchema} from './research-experiment-results';
import {researchExperimentPathSchema} from './research-experiments';
import {researchRelationReviewerSchema} from './research-evidence-relations';
import {researchEvidenceSchema} from './research-evidence';
const id=z.string().trim().min(1).max(300),hash=z.string().regex(/^[a-f0-9]{64}$/u),text=z.string().trim().min(1).max(12000);
const scope=z.strictObject({projectId:id,contractId:id});
const role=z.enum(['input','output','source','environment']);
const file=z.strictObject({path:researchExperimentPathSchema,role});
const externalFile=file.extend({sha256:hash});
const method=z.strictObject({name:id,rationale:text,assumptions:text,limitations:text});
export const externalReportVerification='external_report_not_independently_verified' as const;
export const researchExternalExperimentCreateSchema=z.strictObject({
  projectId:id,artifactId:id,expectedArtifactVersion:hash,requestId:id,title:id,instructions:text,
  definitions:researchExperimentMetricDefinitionSchema.array().min(1).max(100),
  expectedFiles:file.array().max(20),resultFormat:z.literal('roc-external-metrics/v1')
}).refine(value=>new Set(value.definitions.map(metric=>metric.id)).size===value.definitions.length&&
  new Set(value.expectedFiles.map(item=>item.path)).size===value.expectedFiles.length,'research_external_experiment_duplicate');
export const researchExternalExperimentContractSchema=z.strictObject({
  snapshot:z.strictObject({schemaVersion:z.literal(1),id,request:researchExternalExperimentCreateSchema,requestHash:hash,
    actor:researchRelationReviewerSchema,recordedAt:z.string().datetime()}),snapshotHash:hash
});
export const researchExternalExperimentBindSchema=scope.extend({expectedRecordHash:hash,requestId:id,provider:id,externalId:id});
export const researchExternalExperimentReportSchema=z.strictObject({schemaVersion:z.literal(1),contractId:id,contractHash:hash,externalId:id,
  environment:z.strictObject({description:text,reportedBy:id}),method,result:researchExperimentResultFileSchema,
  files:externalFile.array().max(20)
}).refine(value=>new Set(value.files.map(item=>item.path)).size===value.files.length,'research_external_experiment_duplicate');
export const researchExternalExperimentPreviewSchema=scope.extend({resultPath:researchExperimentPathSchema});
export const researchExternalExperimentImportSchema=researchExternalExperimentPreviewSchema.extend({expectedRecordHash:hash,requestId:id,expectedResultHash:hash});
export const researchExternalExperimentResultRefSchema=z.strictObject({resultId:id,expectedHash:hash});
export const researchExternalExperimentResultSchema=z.strictObject({
  snapshot:z.strictObject({schemaVersion:z.literal(1),id,request:researchExternalExperimentImportSchema,requestHash:hash,
    contractHash:hash,provider:id,externalId:id,report:researchExternalExperimentReportSchema,
    original:z.strictObject({sha256:hash,size:z.number().int().positive()}),
    files:externalFile.extend({size:z.number().int().nonnegative()}).array().max(20),
    verification:z.literal(externalReportVerification),actor:researchRelationReviewerSchema,recordedAt:z.string().datetime()}),snapshotHash:hash
});
export const researchExternalExperimentRecordSchema=z.strictObject({
  contract:researchExternalExperimentContractSchema,
  binding:z.strictObject({request:researchExternalExperimentBindSchema,actor:researchRelationReviewerSchema,recordedAt:z.string().datetime()}).nullable(),
  status:z.enum(['unbound','waiting','reported']),sourceCurrent:z.boolean(),latestResult:researchExternalExperimentResultRefSchema.nullable(),
  resultCount:z.number().int().nonnegative(),recordHash:hash
});
export const researchExternalExperimentPreviewResultSchema=z.strictObject({recordHash:hash,resultPath:researchExperimentPathSchema,
  report:researchExternalExperimentReportSchema,original:z.strictObject({sha256:hash,size:z.number().int().positive()}),
  files:externalFile.extend({size:z.number().int().nonnegative()}).array().max(20)});
export const researchExternalExperimentGetSchema=scope;
export const researchExternalExperimentListSchema=z.strictObject({projectId:id,artifactId:id.optional(),offset:z.number().int().nonnegative(),limit:z.number().int().min(1).max(100)});
export const researchExternalExperimentListResultSchema=z.strictObject({items:researchExternalExperimentRecordSchema.array(),total:z.number().int().nonnegative()});
export const researchExternalExperimentResultGetSchema=researchExternalExperimentResultRefSchema.extend({projectId:id});
export const researchExternalExperimentResultsListSchema=scope.extend({offset:z.number().int().nonnegative(),limit:z.number().int().min(1).max(100)});
export const researchExternalExperimentResultsSchema=z.strictObject({items:researchExternalExperimentResultRefSchema.array(),total:z.number().int().nonnegative()});
export const researchExternalExperimentCaptureSchema=researchExternalExperimentResultGetSchema.extend({metricId:researchExperimentMetricDefinitionSchema.shape.id});
export const researchExternalExperimentDerivationSchema=z.strictObject({result:researchExternalExperimentResultRefSchema,
  verification:z.literal(externalReportVerification),methods:z.string().min(1).max(64000),
  rows:z.strictObject({ordinal:z.number().int().nonnegative(),metric:researchExperimentResultFileSchema.shape.metrics.element,
    definition:researchExperimentMetricDefinitionSchema,evidence:researchEvidenceSchema.nullable()}).array(),
  figures:z.strictObject({unit:id,filename:researchExperimentPathSchema,source:z.string().min(1),sourceHash:hash,metricIds:id.array()}).array()});
export type ResearchExternalExperimentCreate=z.infer<typeof researchExternalExperimentCreateSchema>;
export type ResearchExternalExperimentBind=z.infer<typeof researchExternalExperimentBindSchema>;
export type ResearchExternalExperimentPreview=z.infer<typeof researchExternalExperimentPreviewSchema>;
export type ResearchExternalExperimentImport=z.infer<typeof researchExternalExperimentImportSchema>;
export type ResearchExternalExperimentRecord=z.infer<typeof researchExternalExperimentRecordSchema>;
export type ResearchExternalExperimentResult=z.infer<typeof researchExternalExperimentResultSchema>;
export type ResearchExternalExperimentGet=z.infer<typeof researchExternalExperimentGetSchema>;
export type ResearchExternalExperimentList=z.infer<typeof researchExternalExperimentListSchema>;
export type ResearchExternalExperimentResultsList=z.infer<typeof researchExternalExperimentResultsListSchema>;
export type ResearchExternalExperimentResultGet=z.infer<typeof researchExternalExperimentResultGetSchema>;
export type ResearchExternalExperimentCapture=z.infer<typeof researchExternalExperimentCaptureSchema>;
export type ResearchExternalExperimentDerivation=z.infer<typeof researchExternalExperimentDerivationSchema>;
export type ResearchExternalExperimentPreviewResult=z.infer<typeof researchExternalExperimentPreviewResultSchema>;
