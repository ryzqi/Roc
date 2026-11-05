import {researchExportScientificReviewSchema, type ResearchExportScientificReview} from '../../../shared/schemas/research-export-review';
import type {ResearchExportExecution, ResearchExportSources} from '../../../shared/schemas/research-exports';
import {RocDomainError} from '../../services/errors';
import {relationClaimHash} from './evidence-relation-repository';
import {exportSourceHash} from './export-sources';
import {researchContentHash} from './research-files';
import type {ResearchRepository} from './repository';
import {captureExportIdeaOutcomes, captureExportIdeaOutcomeHistory} from './export-idea-outcomes';
import {captureExportArtifactReviews} from './export-artifact-reviews';

export const exportScientificReviewPath = 'provenance/scientific-review.json';

/** Freeze actual source versions, human decisions and their history without changing sealed sources. */
export function captureExportScientificReview(repository: ResearchRepository, sources: ResearchExportSources): ResearchExportScientificReview {
  const projectId = sources.project.id;
  const ideaOutcomes = captureExportIdeaOutcomes(repository, projectId, sources.experimentResults);
  if (JSON.stringify(ideaOutcomes) !== JSON.stringify(sources.ideaOutcomes)) {
    throw new RocDomainError({code: 'research_export_semantic_snapshot_changed', category: 'conflict', retryable: false,
      message: '导出的人工结果评估已变化。请重新生成导出并审核当前版本。'});
  }
  for (const claim of sources.claims) repository.evidence.assertReviewedSupport(claim);
  const relations = sources.claims.flatMap(claim => repository.evidence.relations.list({projectId, claimId: claim.id}));
  const evidenceIds = [...new Set([...sources.evidence.map(source => source.id), ...relations.map(relation => relation.evidenceId),
    ...ideaOutcomes.flatMap(outcome => {
      const plan = outcome.snapshot.material.plan.version.request.body;
      return [...outcome.snapshot.material.evidence.map(evidence => evidence.id),
        ...plan.novelty.comparisons.map(item => item.evidenceId),
        ...(plan.observation.kind === 'after_data' ? plan.observation.evidenceIds : []),
        ...(plan.sampleSize.kind === 'calculated' ? plan.sampleSize.evidenceIds : [])];
    })])];
  return researchExportScientificReviewSchema.parse({
    schemaVersion: 3, projectId, sourceHash: exportSourceHash(sources),
    claims: sources.claims.map(claim => ({claimId: claim.id, version: claim.version, hash: relationClaimHash(claim)})),
    evidence: evidenceIds.map(evidenceId => repository.evidence.inspectEvidence(evidenceId, projectId)),
    relations,
    history: relations.map(relation => ({relationId: relation.id, revisions: repository.evidence.relations.history(relation.id, projectId)})),
    ideaOutcomes, ideaOutcomeHistory: ideaOutcomes.map(outcome => ({planVersionId: outcome.snapshot.request.plan.versionId,
      history: captureExportIdeaOutcomeHistory(repository, outcome)})),
    ...captureExportArtifactReviews(repository, projectId,
      [sources.manuscriptArtifact.id, ...sources.figures.map(figure => figure.artifactId)])
  });
}

export function serializeExportScientificReview(review: ResearchExportScientificReview): string {
  return `${JSON.stringify(researchExportScientificReviewSchema.parse(review))}\n`;
}

/** Current publication requires a seal; historical reads verify only the saved files and archive. */
export function assertCurrentExportScientificReview(repository: ResearchRepository, record: ResearchExportExecution): void {
  if (record.sources === null) throw new Error('research_export_sources_required');
  if (record.sourceHash !== exportSourceHash(record.sources)) throw new Error('research_export_sources_changed');
  const file = record.files.find(entry => entry.path === exportScientificReviewPath);
  if (file === undefined) {
    throw new RocDomainError({code: 'research_export_semantic_snapshot_required', category: 'conflict', retryable: false,
      message: '当前导出缺少固定的科学关系审核快照。请核查来源并重新生成导出。'});
  }
  const bytes = serializeExportScientificReview(captureExportScientificReview(repository, record.sources));
  if (file.sha256 !== researchContentHash(bytes) || file.size !== Buffer.byteLength(bytes)) {
    throw new RocDomainError({code: 'research_export_semantic_snapshot_changed', category: 'conflict', retryable: false,
      message: '导出的科学关系审核快照已变化。请重新核查关系、生成导出并审核当前版本。'});
  }
}
