import type { ResearchWorkflowSnapshot, ResearchWorkflowTransitionRequest } from '../../../shared/types';
import type { ResearchRepository } from './repository';
import { requireSearchPlanContent, searchPlanApprovalHash } from './search-strategy';
import {currentArtifactScientificReviews, type ResearchArtifactScientificReviewService} from './artifact-scientific-reviews';

export type ResearchProductionVerifier = {
  verifyStage(projectId: string): Promise<void>;
};

export type ResearchHumanGate = {
  complete(request: ResearchWorkflowTransitionRequest, signal?: AbortSignal): Promise<ResearchWorkflowSnapshot>;
  approve(request: ResearchWorkflowTransitionRequest): Promise<ResearchWorkflowSnapshot>;
  reject(request: ResearchWorkflowTransitionRequest): Promise<ResearchWorkflowSnapshot>;
};

export function createResearchHumanGate(input: {
  repository: ResearchRepository;
  production?: ResearchProductionVerifier;
  scientificReviews?: Pick<ResearchArtifactScientificReviewService, 'verifyArtifacts'>;
}): ResearchHumanGate {
  async function submit(request: ResearchWorkflowTransitionRequest, action: 'complete' | 'approve' | 'reject', signal?: AbortSignal): Promise<ResearchWorkflowSnapshot> {
    signal?.throwIfAborted();
    if (request.action !== action) throw new Error('research_gate_action_invalid');
    if (action === 'reject') return input.repository.transitionWorkflow(request);
    const workflow = input.repository.getWorkflow(request.projectId);
    if (workflow.currentStage !== request.expectedStage) throw new Error('research_workflow_stage_conflict');
    const current = workflow.stages.find((stage) => stage.stage === workflow.currentStage);
    if (current === undefined) throw new Error('research_stage_not_found');
    if (request.action === 'approve' && current.stage === 'discovery') {
      if (current.artifactIds.length !== 1) throw new Error('research_search_plan_required');
      const artifact = input.repository.getArtifact(current.artifactIds[0]);
      const output = requireSearchPlanContent(input.repository, artifact);
      if (request.expectedSearchPlanHash !== searchPlanApprovalHash(request.projectId, artifact.id, output)) {
        throw new Error('research_search_plan_approval_changed');
      }
    }
    if (request.action === 'approve') input.repository.assertArtifactReview(request);
    const versions = current.artifactIds.map(artifactId => ({
      artifactId, version: input.repository.inspectArtifact({projectId: request.projectId, artifactId, expectedVersion: null}).snapshot.version
    }));
    const reviews = current.artifactIds.map(artifactId => currentArtifactScientificReviews(input.repository, request.projectId, artifactId));
    if (reviews.some(review => review.citations.length > 0 || review.consistency !== null || review.figure !== null ||
      review.response !== null || review.journal !== null)) {
      if (input.scientificReviews === undefined) throw new Error('research_scientific_review_verify_unavailable');
      await input.scientificReviews.verifyArtifacts(request.projectId, current.artifactIds);
    }
    if (current.stage === 'figure' || current.stage === 'export') {
      if (input.production === undefined) throw new Error(current.stage === 'figure' ? 'research_figure_verify_unavailable' : 'research_export_verify_unavailable');
      const signature = current.stage === 'figure'
        ? input.repository.figures.reviewSignature(request.projectId)
        : input.repository.exports.reviewSignature(request.projectId);
      await input.production.verifyStage(request.projectId);
      const next = current.stage === 'figure'
        ? input.repository.figures.reviewSignature(request.projectId)
        : input.repository.exports.reviewSignature(request.projectId);
      if (signature !== next) throw new Error(current.stage === 'figure' ? 'research_figure_review_changed' : 'research_export_review_changed');
    }
    signal?.throwIfAborted();
    const finalWorkflow = input.repository.getWorkflow(request.projectId);
    const finalStage = finalWorkflow.stages.find(stage => stage.stage === current.stage);
    if (finalWorkflow.currentStage !== current.stage || finalStage?.status !== current.status ||
      JSON.stringify(finalStage.artifactIds) !== JSON.stringify(current.artifactIds)) {
      throw new Error('research_artifact_review_set_changed');
    }
    for (const version of versions) {
      if (input.repository.inspectArtifact({projectId: request.projectId, artifactId: version.artifactId,
        expectedVersion: version.version}).status !== 'current') throw new Error('research_artifact_review_changed');
    }
    return input.repository.transitionWorkflow(request);
  }

  return {
    complete(request, signal) { return submit(request, 'complete', signal); },
    approve(request) { return submit(request, 'approve'); },
    reject(request) { return submit(request, 'reject'); }
  };
}
