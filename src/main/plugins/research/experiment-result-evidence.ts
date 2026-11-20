import {researchExperimentResultEvidenceMetadataSchema,
  type ResearchExperimentResultReceipt,type ResearchExperimentResultEvidenceMetadata} from '../../../shared/schemas/research-experiment-results';
import type {ResearchEvidence} from '../../../shared/types';
import {researchContentHash} from './research-files';

/** A result metric has an exact JSON pointer; it is never inferred from output chunks. */
export function experimentMetricSource(receipt:ResearchExperimentResultReceipt,metricId:string):{
  id:string;title:string;content:string;locator:string;metadata:ResearchExperimentResultEvidenceMetadata
} {
  const {snapshot,snapshotHash}=receipt;
  const index=snapshot.result.metrics.findIndex(metric=>metric.id===metricId);
  const definition=snapshot.request.definitions.find(value=>value.id===metricId);
  if(index<0||definition===undefined)throw new Error('research_result_metric_not_found');
  const metadata:ResearchExperimentResultEvidenceMetadata={
    type:'experiment-result',resultId:snapshot.id,resultHash:snapshotHash,metricId,runId:snapshot.execution.runId,
    area:'output',path:snapshot.execution.output.path,sha256:snapshot.execution.output.sha256,pointer:`/metrics/${index}`
  };
  const id=`experiment_metric_${researchContentHash(JSON.stringify([snapshot.request.projectId,snapshot.id,snapshotHash,metricId]))}`;
  return {id,title:`${definition.label} (${snapshot.id})`,
    content:JSON.stringify({schemaVersion:1,source:metadata,metric:snapshot.result.metrics[index],definition,method:snapshot.request.method},null,2),
    locator:`output/${metadata.path}#${metadata.pointer}`,metadata};
}

export function assertExperimentMetricEvidence(evidence:ResearchEvidence,metadata:Record<string,unknown>,
  receipt:ResearchExperimentResultReceipt):ResearchExperimentResultEvidenceMetadata {
  const source=researchExperimentResultEvidenceMetadataSchema.parse(metadata);
  const expected=experimentMetricSource(receipt,source.metricId);
  if(JSON.stringify(source)!==JSON.stringify(expected.metadata)||evidence.projectId!==receipt.snapshot.request.projectId||
    evidence.sourceType!=='experiment'||evidence.sourceId!==source.runId||evidence.documentId!==expected.id||
    evidence.chunkId!==`${expected.id}:chunk:0`||evidence.title!==expected.title||evidence.locator!==expected.locator||
    evidence.excerpt!==expected.content||evidence.contentHash!==researchContentHash(expected.content)||
    evidence.sourceVersion!==researchContentHash(JSON.stringify([
      researchContentHash(expected.content),'experiment',source.runId,expected.title,expected.metadata
    ])))throw new Error('research_result_evidence_changed');
  return source;
}
