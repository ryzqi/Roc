import type { ResearchWorkflowSnapshot, ResearchWorkflowTransitionRequest } from '../../../shared/types';
import type { ResearchRepository } from './repository';

export type ResearchProductionVerifier = {
  verifyStage(projectId: string): Promise<void>;
};

export type ResearchHumanGate = {
  complete(request: ResearchWorkflowTransitionRequest): Promise<ResearchWorkflowSnapshot>;
  approve(request: ResearchWorkflowTransitionRequest): Promise<ResearchWorkflowSnapshot>;
  reject(request: ResearchWorkflowTransitionRequest): Promise<ResearchWorkflowSnapshot>;
};

export function createResearchHumanGate(input: {
  repository: ResearchRepository;
  production?: ResearchProductionVerifier;
}): ResearchHumanGate {
  async function submit(request: ResearchWorkflowTransitionRequest, action: 'complete' | 'approve' | 'reject'): Promise<ResearchWorkflowSnapshot> {
    if (request.action !== action) throw new Error('research_gate_action_invalid');
    if (action === 'reject') return input.repository.transitionWorkflow(request);
    const workflow = input.repository.getWorkflow(request.projectId);
    if (workflow.currentStage !== request.expectedStage) throw new Error('research_workflow_stage_conflict');
    const current = workflow.stages.find((stage) => stage.stage === workflow.currentStage);
    if (current === undefined) throw new Error('research_stage_not_found');
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
    return input.repository.transitionWorkflow(request);
  }

  return {
    complete(request) { return submit(request, 'complete'); },
    approve(request) { return submit(request, 'approve'); },
    reject(request) { return submit(request, 'reject'); }
  };
}
