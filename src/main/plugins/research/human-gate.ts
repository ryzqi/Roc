import type { ResearchWorkflowSnapshot, ResearchWorkflowTransitionRequest } from '../../../shared/types';
import { researchContentHash } from './research-files';
import type { ResearchRepository } from './repository';

export type ResearchHumanGateFigures = {
  verifyStage(projectId: string): Promise<void>;
};

export type ResearchHumanGateExports = {
  verifyStage(projectId: string): Promise<void>;
};

export type ResearchHumanGate = {
  complete(request: ResearchWorkflowTransitionRequest): Promise<ResearchWorkflowSnapshot>;
  approve(request: ResearchWorkflowTransitionRequest): Promise<ResearchWorkflowSnapshot>;
  reject(request: ResearchWorkflowTransitionRequest): Promise<ResearchWorkflowSnapshot>;
};

export function createResearchHumanGate(input: {
  repository: ResearchRepository;
  figures?: ResearchHumanGateFigures;
  exports?: ResearchHumanGateExports;
}): ResearchHumanGate {
  async function submit(request: ResearchWorkflowTransitionRequest, action: 'complete' | 'approve' | 'reject'): Promise<ResearchWorkflowSnapshot> {
    if (request.action !== action) throw new Error('research_gate_action_invalid');
    if (action === 'reject') return input.repository.transitionWorkflow(request);
    const workflow = input.repository.getWorkflow(request.projectId);
    if (workflow.currentStage !== request.expectedStage) throw new Error('research_workflow_stage_conflict');
    const current = workflow.stages.find((stage) => stage.stage === workflow.currentStage);
    if (current === undefined) throw new Error('research_stage_not_found');
    if (current.stage === 'figure') {
      if (input.figures === undefined) throw new Error('research_figure_verify_unavailable');
      const signature = figureSignature(input.repository, request.projectId);
      await input.figures.verifyStage(request.projectId);
      if (signature !== figureSignature(input.repository, request.projectId)) throw new Error('research_figure_review_changed');
    }
    if (current.stage === 'export') {
      if (input.exports === undefined) throw new Error('research_export_verify_unavailable');
      const signature = exportSignature(input.repository, request.projectId);
      await input.exports.verifyStage(request.projectId);
      if (signature !== exportSignature(input.repository, request.projectId)) throw new Error('research_export_review_changed');
    }
    return input.repository.transitionWorkflow(request);
  }

  return {
    complete(request) { return submit(request, 'complete'); },
    approve(request) { return submit(request, 'approve'); },
    reject(request) { return submit(request, 'reject'); }
  };
}


function figureSignature(repository: ResearchRepository, projectId: string): string {
  const workflow = repository.getWorkflow(projectId);
  const stage = workflow.stages.find((entry) => entry.stage === 'figure');
  if (stage === undefined) throw new Error('research_stage_not_found');
  const artifacts = stage.artifactIds.map((id) => ({
    artifact: repository.getArtifact(id),
    claims: repository.evidence.listClaims({ projectId, artifactId: id })
  }));
  return researchContentHash(JSON.stringify({
    currentStage: workflow.currentStage, projectStatus: workflow.projectStatus, stage, artifacts
  }));
}

function exportSignature(repository: ResearchRepository, projectId: string): string {
  const workflow = repository.getWorkflow(projectId);
  const stage = workflow.stages.find((entry) => entry.stage === 'export');
  if (stage === undefined) throw new Error('research_stage_not_found');
  return researchContentHash(JSON.stringify({
    currentStage: workflow.currentStage, projectStatus: workflow.projectStatus, stage,
    artifacts: stage.artifactIds.map((id) => repository.getArtifact(id))
  }));
}
