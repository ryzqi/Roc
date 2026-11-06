import {
  researchTaskDiagnosticsSchema, type ResearchTaskDiagnostics, type ResearchTaskExecutionDiagnostics
} from '../../../shared/schemas/research-task-diagnostics';
import type { ResearchTaskExecution } from '../../../shared/schemas/research-tasks';
import type { ResearchRepository } from './repository';
import type { RunBudgetLedger } from '../../services/deep-agent/run-budget-ledger';
import {taskExecutionDiagnosticsRequestSchema, taskExecutionObservationsSchema, taskResourceDiagnosticsSchema, type TaskExecutionDiagnosticsRequest} from '../../../shared/schemas/research-task-observability';
import {researchExperimentResourceReportSchema} from '../../../shared/schemas/research-process-resources';
import type {ResearchExperimentService} from './experiment-service';
import type {ResearchReviewSearchService} from './review-search-service';

export class ResearchTaskDiagnosticsService {
  constructor(private readonly repository: ResearchRepository, private readonly ledger: RunBudgetLedger,
    private readonly reviewSearches: Pick<ResearchReviewSearchService, 'get'> | null,
    private readonly experiments: Pick<ResearchExperimentService, 'source'>) {}

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
    const cleanupConfirmed = task.statusReason !== 'research_task_cleanup_pending' &&
      task.statusReason !== 'research_task_cleanup_failed';
    const recoveryIssues: ResearchTaskDiagnostics['recoveryIssues'] = this.repository.tasks.recoveryIssues(task.id, task.projectId);
    const recoveryExecution = continuation ?? (waiting ? [...executions].reverse().find(execution =>
      execution.association.kind === 'stage' && execution.association.associationSource !== 'review' &&
      execution.stage === current.stage && execution.status === 'completed') : undefined);
    if (recoveryExecution?.association.associationState === 'confirmed') {
      try {
        this.repository.runs.assertInputsCurrent(this.repository.runs.get(recoveryExecution.association.executionId, task.projectId));
      } catch (error) {
        if (error instanceof Error && (error.message === 'research_stage_inputs_stale' || error.message === 'research_stage_snapshot_invalid')) {
          recoveryIssues.push(error.message);
        } else { throw error; }
      }
    }
    const effectsResolved = recoveryIssues.length === 0 && !this.repository.tasks.hasUnresolvedEffects(task.id, task.projectId);
    const canContinue = cleanupConfirmed && effectsResolved && ['paused', 'interrupted', 'failed', 'cancelled'].includes(task.status) &&
      workflow.projectStatus !== 'archived';
    return researchTaskDiagnosticsSchema.parse({
      task, budget: this.ledger.readTaskBudgetStatus(task.id, task.projectId), executions,
      continuationRunId: canContinue ? continuation?.association.executionId ?? null : null,
      canRestoreApproval: cleanupConfirmed && effectsResolved && task.status === 'paused' && waiting && workflow.projectStatus !== 'archived',
      recoveryIssues, eventDelivery: this.repository.runs.flushTaskEvents(task.id), externalCost: 'unknown'
    });
  }

  events(request: {projectId: string; taskId: string; afterSequence: number; limit: number}) {
    this.repository.tasks.get(request.taskId,request.projectId);
    const delivery = this.repository.runs.flushTaskEvents(request.taskId);
    if (delivery.pending !== 0) throw new Error('research_event_delivery_pending');
    return this.repository.tasks.events(request);
  }

  async inspectExecution(input: TaskExecutionDiagnosticsRequest) {
    const request = taskExecutionDiagnosticsRequestSchema.parse(input);
    this.repository.tasks.get(request.taskId, request.projectId);
    const association = this.repository.tasks.requireExecution(request.executionKind, request.executionId, request.projectId);
    if (association.taskId !== request.taskId) throw new Error('research_task_execution_mismatch');
    let resources = null;
    if (association.kind === 'experiment') {
      const run = this.repository.experiments.get(request.projectId, request.executionId);
      if (run.files.some(file => file.area === 'log' && file.path === 'resources.json')) {
        const {bytes, file} = await this.experiments.source({projectId: request.projectId, runId: request.executionId, area: 'log', path: 'resources.json'});
        const report = researchExperimentResourceReportSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown);
        if (report.runId !== run.id || report.projectId !== run.projectId || report.engine !== run.request.engine ||
          report.inputHash !== run.inputHash || report.environmentHash !== (run.environment?.hash ?? null)) {
          throw new Error('research_experiment_resource_report_changed');
        }
        resources = taskResourceDiagnosticsSchema.parse({reportSha256: file.sha256, outcome: report.outcome, recordedAt: report.recordedAt,
          usage: report.usage, admission: report.admission, probes: report.probes.map(probe => ({phase: probe.phase, kind: probe.kind,
            outcome: probe.outcome, usage: probe.usage, admission: probe.admission}))});
      }
    }
    return taskExecutionObservationsSchema.parse({resources, calls: this.repository.tasks.observability.calls(request),
      replay: association.kind === 'chat' ? this.repository.tasks.observability.replay(request) : null,
      telemetry: association.kind === 'chat' ? this.repository.tasks.observability.summary(request.executionId) : null});
  }

  private execution(association: ResearchTaskExecution): ResearchTaskExecutionDiagnostics {
    const value = this.executionState(association);
    const {artifactIds, ...state} = value;
    const artifacts = artifactIds.map(id => {
      try {
        const current = this.repository.inspectArtifact({projectId: association.projectId, artifactId: id, expectedVersion: null});
        return {id, version: current.snapshot.version, versionSource: 'current_inspector' as const, state: 'present' as const};
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('research_artifact_not_found:')) {
          return {id, version: null, versionSource: 'current_inspector' as const, state: 'missing' as const};
        }
        throw error;
      }
    });
    return researchTaskDiagnosticsSchema.shape.executions.element.parse({...state, artifacts,
      telemetry: association.kind === 'chat' ? this.repository.tasks.observability.summary(association.executionId) : null});
  }

  private executionState(association: ResearchTaskExecution): Omit<ResearchTaskExecutionDiagnostics, 'artifacts'|'telemetry'> & {artifactIds: string[]} {
    const { executionId: id, projectId } = association;
    if (association.associationState === 'failed' || association.associationState === 'pending') {
      return {association,status: 'interrupted',stage: null,providerId: null,modelId: null,
        error: 'research_execution_intent_uncommitted',artifactIds: [],startedAt: null,endedAt: null};
    }
    if (association.kind === 'chat') {
      const chat = this.repository.tasks.chatDiagnostics(id);
      return {association, ...chat, status: researchTaskDiagnosticsSchema.shape.executions.element.shape.status.parse(chat.status), stage: null, artifactIds: []};
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
