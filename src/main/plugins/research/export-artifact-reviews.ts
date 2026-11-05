import {researchExportFigureReviewSchema, type ResearchExportFigureReview,
  type ResearchExportScientificReview} from '../../../shared/schemas/research-export-review';
import type {ResearchFigureConsistencyReceipt} from '../../../shared/schemas/research-figure-consistency';
import type {ResearchRepository} from './repository';
import {currentArtifactScientificReviews} from './artifact-scientific-reviews';
import {researchContentHash} from './research-files';

/** The original hash is provenance; only the explicitly redacted projection is exported. */
export function redactExportFigureReview(receipt: ResearchFigureConsistencyReceipt): ResearchExportFigureReview {
  const {workspacePath: _workspacePath, workspaceRoot: _workspaceRoot, ...run} = receipt.snapshot.material.run;
  const snapshot = {...receipt.snapshot, material: {...receipt.snapshot.material, run}};
  return researchExportFigureReviewSchema.parse({
    verification: 'redacted_receipt',
    omittedFields: ['snapshot.material.run.workspacePath', 'snapshot.material.run.workspaceRoot'],
    originalSnapshotHash: receipt.snapshotHash, redactedSnapshotHash: researchContentHash(JSON.stringify(snapshot)), snapshot
  });
}

function completeHistory<T>(read: (offset: number) => {items: T[]; total: number; verification: 'stored_receipt'}) {
  const history = read(0);
  while (history.items.length < history.total) {
    const page = read(history.items.length);
    if (page.total !== history.total || page.items.length === 0 || history.items.length + page.items.length > history.total) {
      throw new Error('research_export_review_history_changed');
    }
    history.items.push(...page.items);
  }
  return history;
}

export function captureExportArtifactReviews(repository: ResearchRepository, projectId: string, artifactIds: readonly string[]):
  Pick<ResearchExportScientificReview, 'citationReviews' | 'consistencyReviews' | 'figureConsistencyReviews'> {
  const citationReviews: ResearchExportScientificReview['citationReviews'] = [];
  const consistencyReviews: ResearchExportScientificReview['consistencyReviews'] = [];
  const figureConsistencyReviews: ResearchExportScientificReview['figureConsistencyReviews'] = [];
  for (const artifactId of artifactIds) {
    const current = currentArtifactScientificReviews(repository, projectId, artifactId);
    const citationHeads = repository.citationReviews.forArtifact(projectId, artifactId);
    if (citationHeads.length > 0) citationReviews.push({
      artifactId, current: current.citations,
      history: citationHeads.map(receipt => {
        const {claimId, evidenceId} = receipt.snapshot.request;
        return {claimId, evidenceId, history: completeHistory(offset => repository.citationReviews.history({
          projectId, artifactId, claimId, evidenceId, offset, limit: 50
        }))};
      })
    });
    if (current.consistency !== null) consistencyReviews.push({
      artifactId, current: current.consistency,
      history: completeHistory(offset => repository.consistency.history({projectId, artifactId, offset, limit: 100}))
    });
    if (current.figure !== null) {
      const history = completeHistory(offset => repository.figureConsistency.history({projectId, artifactId, offset, limit: 100}));
      figureConsistencyReviews.push({artifactId, current: redactExportFigureReview(current.figure),
        history: {verification: 'redacted_receipts', items: history.items.map(redactExportFigureReview), total: history.total}});
    }
  }
  return {citationReviews, consistencyReviews, figureConsistencyReviews};
}
