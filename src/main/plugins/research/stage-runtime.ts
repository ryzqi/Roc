import { ZodError } from 'zod';

import type { ResearchStageRun, ResearchStageRunIdRequest, ResearchStageRunRetryRequest, ResearchStageRunStartRequest, ResearchWorkflowTransitionRequest } from '../../../shared/types';
import type { RocCapabilityRegistry } from '../../kernel/types';
import type { ResearchRepository } from './repository';
import type { PreparedResearchRole, ResearchRoleExecutor } from './role-executor';
import { createResearchRoleTools } from './role-tools';

type ActiveRole = { controller: AbortController; pending: Promise<void>; projectId: string };

export class ResearchStageRuntime {
  private readonly active = new Map<string, ActiveRole>();

  constructor(
    private readonly repository: ResearchRepository,
    private readonly capabilities: RocCapabilityRegistry,
    private readonly executor: ResearchRoleExecutor | undefined
  ) {}

  start(request: ResearchStageRunStartRequest): ResearchStageRun {
    if (this.executor === undefined) throw new Error('research_model_executor_unavailable');
    const run = this.repository.runs.begin(request);
    this.schedule(run);
    return run;
  }

  retry(request: ResearchStageRunRetryRequest): ResearchStageRun {
    if (this.executor === undefined) throw new Error('research_model_executor_unavailable');
    const run = this.repository.runs.retry(request);
    this.schedule(run);
    return run;
  }

  cancel(request: ResearchStageRunIdRequest): ResearchStageRun {
    return this.stop(request, 'cancelled', 'research_run_cancelled');
  }

  transition(request: ResearchWorkflowTransitionRequest) {
    const workflow = this.repository.getWorkflow(request.projectId);
    if (workflow.currentStage !== request.expectedStage) throw new Error('research_workflow_stage_conflict');
    const current = workflow.stages.find((stage) => stage.stage === workflow.currentStage);
    if (request.action === 'pause' && current?.activeRunId !== null && current?.activeRunId !== undefined) {
      this.stop({ projectId: request.projectId, runId: current.activeRunId }, 'interrupted', 'research_run_paused');
      return this.repository.getWorkflow(request.projectId);
    }
    return this.repository.transitionWorkflow(request);
  }

  async shutdown(): Promise<void> {
    const pending = [...this.active.values()].map((entry) => entry.pending);
    for (const [runId, entry] of this.active) {
      this.stop({ projectId: entry.projectId, runId }, 'interrupted', 'research_run_interrupted_by_shutdown');
    }
    await Promise.all(pending);
  }

  async waitForIdle(): Promise<void> {
    await Promise.all([...this.active.values()].map((entry) => entry.pending));
  }

  private stop(request: ResearchStageRunIdRequest, status: 'cancelled' | 'interrupted', reason: string): ResearchStageRun {
    if (this.repository.runs.get(request.runId, request.projectId).parentRunId !== null) {
      throw new Error('research_run_cancel_parent_required');
    }
    const run = this.repository.runs.terminate(request.runId, request.projectId, status, reason);
    this.active.get(run.id)?.controller.abort(new Error(reason));
    return run;
  }

  private schedule(run: ResearchStageRun): void {
    if (run.status !== 'queued' || this.active.has(run.id)) return;
    const controller = new AbortController();
    const pending = Promise.resolve().then(() => this.execute(run, controller)).finally(() => {
      this.active.delete(run.id);
    });
    this.active.set(run.id, { controller, pending, projectId: run.projectId });
  }

  private async execute(queued: ResearchStageRun, controller: AbortController): Promise<void> {
    const timeout = setTimeout(() => controller.abort(new Error('research_run_timeout')), queued.policy.timeoutMs);
    let children: Promise<ResearchStageRun>[] = [];
    try {
      const { prepared, run } = await this.prepareRole(queued, controller.signal);
      if (run.stage === 'review') {
        children = this.repository.runs.createReviewChildren(run.id, run.projectId)
          .map((child) => this.executeChild(child, controller.signal));
        const reports = await Promise.all(children);
        this.repository.runs.setReviewReports(run.id, run.projectId, reports);
      }
      await this.executeOutput(run, prepared, controller.signal);
    } catch (error) {
      controller.abort(error);
      await Promise.allSettled(children);
      this.repository.runs.terminate(queued.id, queued.projectId, 'failed', executionErrorCode(error));
    } finally {
      clearTimeout(timeout);
    }
  }

  private async prepareRole(queued: ResearchStageRun, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.executor === undefined) throw new Error('research_model_executor_unavailable');
    const prepared = await withAbort(this.executor.prepare(queued.policy.model), signal);
    signal.throwIfAborted();
    return { prepared, run: this.repository.runs.markRunning(queued.id, queued.projectId, prepared) };
  }

  private async executeOutput(run: ResearchStageRun, prepared: PreparedResearchRole, signal: AbortSignal): Promise<ResearchStageRun> {
    const context = this.repository.runs.getContext(run.id);
    const tools = createResearchRoleTools({ run, context, repository: this.repository, capabilities: this.capabilities, signal });
    const result = await withAbort(prepared.execute({ run, context, tools, signal }), signal);
    signal.throwIfAborted();
    this.repository.runs.recordModelVersion(run.id, run.projectId, result.modelVersion);
    return this.repository.runs.complete(run.id, run.projectId, result.output);
  }

  private async executeChild(queued: ResearchStageRun, signal: AbortSignal): Promise<ResearchStageRun> {
    try {
      const { prepared, run } = await this.prepareRole(queued, signal);
      return await this.executeOutput(run, prepared, signal);
    } catch (error) {
      this.repository.runs.terminate(queued.id, queued.projectId, signal.aborted ? 'interrupted' : 'failed', executionErrorCode(error));
      throw error;
    }
  }
}

function withAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function executionErrorCode(error: unknown): string {
  if (error instanceof ZodError) return 'research_role_output_invalid';
  if (error instanceof Error && /^research_[a-z0-9_]+(?::[a-z0-9_.-]+)*$/iu.test(error.message)) return error.message;
  return 'research_role_execution_failed';
}
