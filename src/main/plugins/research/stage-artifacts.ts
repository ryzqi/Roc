import type { ResearchStageState } from '../../../shared/types';
import type { ResearchRepository } from './repository';
import { getResearchStageRoleProfile } from './role-profiles';

export function assertResearchStageArtifacts(repository: ResearchRepository, projectId: string, state: ResearchStageState): void {
  if (!state.gateRequired && state.artifactIds.length === 0) return;
  if (state.artifactIds.length === 0) throw new Error('research_stage_artifact_required');
  for (const id of state.artifactIds) {
    const artifact = repository.getArtifact(id);
    if (artifact.projectId !== projectId || artifact.stage !== state.stage || artifact.status !== 'draft' ||
        artifact.kind !== getResearchStageRoleProfile(state.stage).outputKind) {
      throw new Error('research_stage_artifact_invalid');
    }
    repository.evidence.assertPublishable(artifact);
    if (artifact.kind === 'idea_canvas') repository.ideas.assertPublishable(artifact);
    if (artifact.kind === 'experiment_run') repository.experiments.forArtifact(artifact);
    if (artifact.kind === 'figure') repository.figures.forArtifact(artifact);
  }
  if (state.stage === 'review') repository.runs.requireReviewPanel(projectId, state.artifactIds);
  if (state.stage === 'export') {
    repository.reviews.requireForStage(projectId, 'export');
    for (const id of state.artifactIds) repository.exports.forArtifact(repository.getArtifact(id));
  }
}
