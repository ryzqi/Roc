import {exportValidationPath, exportValidationVersion, researchExportValidationSchema,
  type ResearchExportValidation} from '../../../shared/schemas/research-export-validation';
import type {ResearchExportExecution, ResearchExportFile, ResearchExportPrepare, ResearchExportSources} from '../../../shared/schemas/research-exports';
import {scientificReviewRulesVersion} from '../../../shared/schemas/research-scientific-review';
import {RocDomainError} from '../../services/errors';
import {relationClaimHash} from './evidence-relation-repository';
import {collectExportInputs, validateExportPublication} from './export-publication';
import {serializeResearchPublicProjection} from './export-public-projection';
import {assertCurrentExportScientificReview, exportScientificReviewPath} from './export-scientific-review';
import {exportSourceHash} from './export-sources';
import {researchContentHash} from './research-files';
import type {ResearchRepository} from './repository';

/** Called after compilation/copy checks. Never infers scientific replication from file integrity. */
export function captureExportValidation(repository: ResearchRepository, sources: ResearchExportSources,
  request: ResearchExportPrepare, files: readonly ResearchExportFile[]): ResearchExportValidation {
  const file = (path: string): ResearchExportFile => {
    const result = files.find(entry => entry.path === path);
    if (result === undefined) throw new Error('research_export_validation_file_required');
    return result;
  };
  const projectId = sources.project.id;
  const publicationReview = validateExportPublication(request.publicationReview, collectExportInputs(repository, sources));
  const semanticReports = repository.scientificReviews.reportsForManuscript(projectId, sources.manuscriptArtifact.id);
  const runIds = [...new Set([...sources.modelRuns.map(run => run.id),
    ...semanticReports.map(report => report.producer.runId),
    ...sources.experiments.flatMap(run => run.ownerRunId === null ? [] : [run.ownerRunId])])].sort();
  return researchExportValidationSchema.parse({
    schemaVersion: 1, rulesVersion: exportValidationVersion, scientificRulesVersion: scientificReviewRulesVersion,
    projectId, sourceHash: exportSourceHash(sources),
    manuscript: {artifactId: sources.manuscriptArtifact.id, artifactHash: researchContentHash(JSON.stringify(sources.manuscriptArtifact)),
      hash: researchContentHash(JSON.stringify(sources.manuscript))},
    deterministicChecks: {sourceClosure: 'validated', humanSupport: 'validated', publicationSelection: 'validated',
      compiledOutputs: [file('paper.pdf'), file('report.pdf')]},
    humanReviewFile: file(exportScientificReviewPath), semanticAuthority: 'model_suggestion_requires_human_review', semanticReports,
    claims: sources.claims.map(claim => {
      repository.evidence.assertReviewedSupport(claim);
      const currentVerifierReportIds = semanticReports.filter(report => report.status === 'current' &&
        report.output.kind === 'verifier' && report.output.suggestions.some(suggestion => suggestion.claimId === claim.id)).map(report => report.artifactId);
      return {claimId: claim.id, version: claim.version, hash: relationClaimHash(claim),
        adviceStatus: currentVerifierReportIds.length === 0 ? 'missing_current_verifier' : 'requires_human_review',
        currentVerifierReportIds, humanConfirmedRelationIds: repository.evidence.relations.list({projectId, claimId: claim.id})
          .filter(relation => relation.status === 'confirmed').map(relation => relation.id)};
    }),
    runs: runIds.map(runId => {
      const run = repository.runs.get(runId, projectId);
      // Use the immutable execution context, never today's Skill in place of historical provenance.
      const {skillPin} = repository.runs.getContext(runId);
      return {runId, taskId: run.taskId, role: run.role, providerId: run.providerId, modelId: run.modelId,
        modelVersion: run.modelVersion, skillHash: run.skillHash, skillPin};
    }),
    experiments: sources.experiments.map(run => {
      if (run.status !== 'completed' || run.inputHash === null || run.environment === null) throw new Error('research_export_experiment_not_ready');
      const external = publicationReview.resources.some(resource => resource.source.kind === 'experiment' &&
        resource.source.id === run.id && resource.delivery.kind === 'metadata_only');
      return {runId: run.id, artifactId: run.artifactId, inputHash: run.inputHash, environmentHash: run.environment.hash,
        files: run.files, materialAvailability: external ? 'external_material_required' : 'all_selected_originals_bundled',
        replay: 'not_run', scientificReplication: 'not_verified'};
    }),
    publicationReview, referenceDelivery: 'metadata_only', journalSupplementDelivery: 'metadata_only',
    externalPublication: 'not_performed_by_export'
  });
}

export function assertCurrentExportValidation(repository: ResearchRepository, record: ResearchExportExecution): void {
  if (record.sources === null) throw new Error('research_export_sources_required');
  const file = record.files.find(entry => entry.path === exportValidationPath);
  if (file === undefined) throw new RocDomainError({code: 'research_export_validation_required', category: 'conflict', retryable: false,
    message: '当前导出缺少验证清单。请重新生成并审核导出。'});
  const bytes = serializeResearchPublicProjection(captureExportValidation(repository, record.sources, record.request, record.files));
  if (file.sha256 !== researchContentHash(bytes) || file.size !== Buffer.byteLength(bytes)) {
    throw new RocDomainError({code: 'research_export_validation_changed', category: 'conflict', retryable: false,
      message: '导出的语义报告、Skill 或验证状态已变化。请重新生成并审核导出。'});
  }
}

/** All current approval/delivery boundaries check both human receipts and semantic advice. */
export function assertCurrentExportReviews(repository: ResearchRepository, record: ResearchExportExecution): void {
  assertCurrentExportScientificReview(repository, record);
  assertCurrentExportValidation(repository, record);
}
