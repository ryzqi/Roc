import {
  researchTaskDiagnosticsSchema, type ResearchTaskDiagnostics, type ResearchTaskExecutionDiagnostics
} from '../../../shared/schemas/research-task-diagnostics';
import type { ResearchTaskExecution } from '../../../shared/schemas/research-tasks';
import type { ResearchRepository } from './repository';
import type { RunBudgetLedger } from '../../services/deep-agent/run-budget-ledger';
import type {ResearchReviewSearchService} from './review-search-service';

export class ResearchTaskDiagnosticsService {
  constructor(private readonly repository: ResearchRepository, private readonly ledger: RunBudgetLedger,
    private readonly reviewSearches: Pick<ResearchReviewSearchService, 'get'> | null) {}

  forChat(request: { projectId: string; threadId: string; runId: string }): ResearchTaskDiagnostics | null {
    const task = this.repository.tasks.taskForChatScope(request);
    return task === null ? null : this.get({ projectId: task.projectId, taskId: task.id });
  }

  get(request: { projectId: string; taskId: string }): ResearchTaskDiagnostics {
    const task = this.repository.tasks.get(request.taskId, request.projectId);
    const executions = this.repository.tasks.executions(task.id, task.projectId).map(execution => this.execution(execution));
    let continuation: ResearchTaskExecutionDiagnostics | undefined;
    for (const execution of executions) {
      if (execution.association.kind === 'stage' && execution.association.associationSource !== 'review' &&
        ['failed', 'cancelled', 'interrupted'].includes(execution.status)) continuation = execution;
    }
    const workflow = this.repository.getWorkflow(task.projectId);
    const current = workflow.stages.find(stage => stage.stage === workflow.currentStage);
    if (current === undefined) throw new Error('research_stage_not_found');
    const waiting = current.status === 'waiting_approval' &&
      this.repository.runs.taskIdsForStage(task.projectId, current.stage).includes(task.id);
    return researchTaskDiagnosticsSchema.parse({
      task, budget: this.ledger.readTaskBudgetStatus(task.id, task.projectId), executions,
      continuationRunId: continuation?.association.executionId ?? null,
      canRestoreApproval: task.status === 'paused' && waiting,
      externalCost: 'unknown'
    });
  }

  private execution(association: ResearchTaskExecution): ResearchTaskExecutionDiagnostics {
    const { executionId: id, projectId } = association;
    if (association.kind === 'chat') {
      return researchTaskDiagnosticsSchema.shape.executions.element.parse({
        association, ...this.repository.tasks.chatDiagnostics(id), stage: null, artifactIds: []
      });
    }
    if (association.kind === 'stage') {
      const run = this.repository.runs.get(id, projectId);
      return { association, status: run.status, stage: run.stage, providerId: run.providerId, modelId: run.modelId,
        error: run.error, artifactIds: run.outputArtifactIds, startedAt: run.startedAt, endedAt: run.endedAt };
    }
    if (association.kind === 'review_search') {
      if (this.reviewSearches === null) throw new Error('research_review_search_service_required');
      const run = this.reviewSearches.get({projectId, reviewSearchId: id});
      return {association, status: run.status, stage: null, providerId: null, modelId: null,
        error: run.receipt?.errorCode ?? null, artifactIds: [], startedAt: run.snapshot.startedAt,
        endedAt: run.receipt?.endedAt ?? null};
    }
    const run = association.kind === 'experiment' ? this.repository.experiments.get(projectId, id)
      : association.kind === 'figure' ? this.repository.figureRuns.get(projectId, id) : this.repository.exports.get(projectId, id);
    return { association, status: run.status, stage: association.kind, providerId: null, modelId: null, error: run.error,
      artifactIds: run.artifactId === null ? [] : [run.artifactId],
      startedAt: 'startedAt' in run ? run.startedAt : null, endedAt: run.endedAt };
  }
}
