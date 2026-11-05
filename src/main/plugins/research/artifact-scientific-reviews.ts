import type {ResearchRepository} from './repository';
import type {ResearchExperimentResultService} from './experiment-result-service';
import type {ResearchFigureService} from './figure-service';

/** Validate existing human mappings; absence and scientific findings remain human decisions. */
export function currentArtifactScientificReviews(repository: ResearchRepository, projectId: string, artifactId: string) {
  const artifact = repository.getArtifact(artifactId);
  if (artifact.projectId !== projectId) throw new Error('research_artifact_project_mismatch');
  const heads = repository.citationReviews.forArtifact(projectId, artifactId);
  const bundle = heads.length === 0 ? null : repository.manuscripts.inspectBundle({projectId, artifactId});
  const citations = heads.filter(receipt => bundle?.claims.some(claim =>
    claim.id === receipt.snapshot.request.claimId && claim.evidenceIds.includes(receipt.snapshot.request.evidenceId)));
  for (const receipt of citations) repository.citationReviews.assertReceiptCurrent(receipt);
  const consistency = repository.consistency.latest(projectId, artifactId);
  if (consistency !== null) repository.consistency.assertReceiptCurrent(consistency);
  const figure = artifact.kind === 'figure' ? repository.figureConsistency.latest(projectId, artifactId) : null;
  if (figure !== null) repository.figureConsistency.assertReceiptCurrent(figure);
  const response = artifact.kind === 'manuscript' ? repository.responseMatrix.latest(projectId, artifactId) : null;
  if (response !== null) repository.responseMatrix.assertReceiptCurrent(response);
  return {citations, consistency, figure, response};
}

export class ResearchArtifactScientificReviewService {
  constructor(private readonly repository: ResearchRepository,
    private readonly results: Pick<ResearchExperimentResultService, 'evidence'>,
    private readonly figures: Pick<ResearchFigureService, 'verify'>) {}

  async verifyArtifacts(projectId: string, artifactIds: readonly string[]): Promise<void> {
    const before = artifactIds.map(artifactId => ({
      artifactId,
      version: this.repository.inspectArtifact({projectId, artifactId, expectedVersion: null}).snapshot.version,
      reviews: currentArtifactScientificReviews(this.repository, projectId, artifactId)
    }));
    for (const {reviews} of before) {
      if (reviews.figure !== null) await this.figures.verify(projectId, reviews.figure.snapshot.material.figure.id);
      const mappings = [...(reviews.consistency?.snapshot.material ?? []), ...(reviews.figure?.snapshot.material.mappings ?? [])];
      for (const mapping of mappings) {
        const result = await this.results.evidence({projectId, evidenceId: mapping.evidence.id});
        if (result === null || JSON.stringify(result.receipt) !== JSON.stringify(mapping.result)) {
          throw new Error('research_consistency_source_changed');
        }
      }
      for (const source of reviews.response?.snapshot.material.evidence ?? []) {
        const result = await this.results.evidence({projectId, evidenceId: source.evidence.id});
        if (this.repository.evidence.sourceMetadata(projectId, source.evidence.id)?.type === 'experiment-result' && result === null) {
          throw new Error('research_response_source_changed');
        }
      }
    }
    for (const saved of before) {
      if (saved.reviews.figure !== null) await this.figures.verify(projectId, saved.reviews.figure.snapshot.material.figure.id);
    }
    for (const saved of before) {
      currentArtifactScientificReviews(this.repository, projectId, saved.artifactId);
      if (this.repository.inspectArtifact({projectId, artifactId: saved.artifactId, expectedVersion: null}).snapshot.version !== saved.version) {
        throw new Error('research_artifact_review_changed');
      }
    }
  }
}
