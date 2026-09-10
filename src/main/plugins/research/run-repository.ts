import { createHash, randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { z } from 'zod';

import { researchArtifactSchema, researchProjectSchema, researchStageSchema } from '../../../shared/schemas/research';
import { researchManuscriptSchema } from '../../../shared/schemas/research-evidence';
import {
  researchArtifactContentSchema,
  researchStageOutputSchema,
  researchStagePolicySchema,
  researchStageRunSchema
} from '../../../shared/schemas/research-runs';
import type {
  ResearchArtifactContent, ResearchStageOutput, ResearchStagePolicy, ResearchStageRun,
  ResearchStageRunStartRequest, ResearchStageRunRetryRequest, ResearchStageRunsRequest
} from '../../../shared/types';
import type { ResearchRepository } from './repository';
import { getResearchStageRoleProfile, researchCapabilityToolNames } from './role-profiles';
import { getResearchSkillInstructions } from './research-skills';

const executionContextSchema = z.object({
  project: researchProjectSchema,
  skillInstructions: z.string().min(1),
  inputs: z.array(z.object({
    artifact: researchArtifactSchema,
    output: researchStageOutputSchema.nullable(),
    manuscript: researchManuscriptSchema.nullable()
  }).strict())
}).strict();

export type ResearchExecutionContext = z.infer<typeof executionContextSchema>;

export class ResearchRunRepository {
  constructor(private readonly db: Database, private readonly research: ResearchRepository, private readonly now: () => string) {}

  initializeProject(projectId: string): void {
    for (const stage of researchStageSchema.options) {
      const policy: ResearchStagePolicy = {
        projectId, stage, tier: stage === 'retrieval' ? 'fast' : ['writing', 'review', 'revision'].includes(stage) ? 'deep' : 'balanced',
        model: { kind: 'app_default' }, maxSteps: 30, timeoutMs: 180000
      };
      this.db.prepare('INSERT INTO research_stage_policies (project_id, stage, policy_json) VALUES (?, ?, ?)')
        .run(projectId, stage, JSON.stringify(policy));
    }
  }

  listPolicies(projectId: string): ResearchStagePolicy[] {
    this.research.getProject(projectId);
    return this.db.prepare('SELECT policy_json FROM research_stage_policies WHERE project_id = ? ORDER BY rowid')
      .all(projectId).map((row) => researchStagePolicySchema.parse(JSON.parse((row as { policy_json: string }).policy_json)));
  }

  savePolicy(input: ResearchStagePolicy): ResearchStagePolicy {
    const policy = researchStagePolicySchema.parse(input);
    this.research.getProject(policy.projectId);
    const updated = this.db.prepare('UPDATE research_stage_policies SET policy_json = ? WHERE project_id = ? AND stage = ?')
      .run(JSON.stringify(policy), policy.projectId, policy.stage);
    if (updated.changes !== 1) throw new Error('research_stage_policy_missing');
    return policy;
  }

  begin(request: ResearchStageRunStartRequest, retryOf?: ResearchStageRun): ResearchStageRun {
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT snapshot_json FROM research_stage_runs WHERE project_id = ? AND request_id = ?')
        .get(request.projectId, request.requestId) as { snapshot_json: string } | undefined;
      if (existing !== undefined) {
        const run = researchStageRunSchema.parse(JSON.parse(existing.snapshot_json));
        if (run.instruction !== request.instruction || run.stage !== request.expectedStage || run.retryOfRunId !== (retryOf?.id ?? null)) {
          throw new Error('research_run_request_conflict');
        }
        return run;
      }
      const workflow = this.research.getWorkflow(request.projectId);
      if (workflow.projectStatus === 'archived') throw new Error('research_project_archived');
      if (workflow.currentStage !== request.expectedStage) throw new Error('research_workflow_stage_conflict');
      const stage = workflow.stages.find((state) => state.stage === request.expectedStage);
      if (stage === undefined) throw new Error('research_stage_not_found');
      if (stage.activeRunId !== null) throw new Error('research_stage_run_active');
      if (!['ready', 'running', 'paused', 'failed', 'blocked'].includes(stage.status)) throw new Error('research_stage_not_runnable');
      const profile = getResearchStageRoleProfile(stage.stage);
      const policy = retryOf?.policy ?? this.listPolicies(request.projectId).find((entry) => entry.stage === stage.stage);
      if (policy === undefined) throw new Error('research_stage_policy_missing');
      const context = retryOf === undefined ? this.captureContext(request.projectId, stage.stage) : this.getContext(retryOf.id);
      for (const input of context.inputs) {
        if (this.research.getArtifact(input.artifact.id).status !== 'approved') throw new Error('research_stage_inputs_stale');
      }
      const timestamp = this.now();
      const run: ResearchStageRun = {
        id: `research_run_${randomUUID()}`, projectId: request.projectId, stage: stage.stage, requestId: request.requestId,
        parentRunId: null, retryOfRunId: retryOf?.id ?? null, role: retryOf?.role ?? profile.role, outputKind: retryOf?.outputKind ?? profile.outputKind,
        status: 'queued', instruction: request.instruction, skillIds: retryOf?.skillIds ?? [...profile.skillIds],
        skillHash: createHash('sha256').update(context.skillInstructions).digest('hex'),
        toolNames: retryOf?.toolNames ?? profile.allowedCapabilities.map((capability) => {
          const name = researchCapabilityToolNames[capability];
          if (name === undefined) throw new Error('research_role_capability_unknown');
          return name;
        }),
        inputArtifactIds: context.inputs.map((input) => input.artifact.id), outputArtifactIds: [], policy,
        providerId: null, modelId: null, modelVersion: null, error: null, createdAt: timestamp, startedAt: null, endedAt: null
      };
      if (retryOf?.providerId !== null && retryOf?.providerId !== undefined && retryOf.modelId !== null) {
        run.policy = { ...policy, model: { kind: 'model', providerId: retryOf.providerId, modelId: retryOf.modelId } };
      }
      this.insertRun(run, context);
      this.db.prepare("UPDATE research_stage_states SET status = 'running', active_run_id = ?, entered_at = COALESCE(entered_at, ?), last_error = NULL WHERE project_id = ? AND stage = ?")
        .run(run.id, timestamp, run.projectId, run.stage);
      this.db.prepare("UPDATE research_projects SET status = 'active', updated_at = ? WHERE id = ?").run(timestamp, run.projectId);
      this.recordEvent(run, 'role_queued', '阶段角色已排队。');
      return run;
    })();
  }

  retry(request: ResearchStageRunRetryRequest): ResearchStageRun {
    const previous = this.get(request.runId, request.projectId);
    if (!['failed', 'cancelled', 'interrupted'].includes(previous.status)) throw new Error('research_run_not_retryable');
    if (request.requestId === previous.requestId) throw new Error('research_run_request_conflict');
    return this.begin({ projectId: request.projectId, expectedStage: previous.stage, instruction: previous.instruction, requestId: request.requestId }, previous);
  }

  get(id: string, projectId: string): ResearchStageRun {
    const row = this.db.prepare('SELECT snapshot_json FROM research_stage_runs WHERE id = ? AND project_id = ?').get(id, projectId) as { snapshot_json: string } | undefined;
    if (row === undefined) throw new Error('research_stage_run_not_found');
    return researchStageRunSchema.parse(JSON.parse(row.snapshot_json));
  }

  list(request: ResearchStageRunsRequest): ResearchStageRun[] {
    this.research.getProject(request.projectId);
    return this.db.prepare('SELECT snapshot_json FROM research_stage_runs WHERE project_id = ? ORDER BY rowid DESC LIMIT ?')
      .all(request.projectId, request.limit).map((row) => researchStageRunSchema.parse(JSON.parse((row as { snapshot_json: string }).snapshot_json)));
  }

  getContext(runId: string): ResearchExecutionContext {
    const row = this.db.prepare('SELECT context_json FROM research_stage_runs WHERE id = ?').get(runId) as { context_json: string } | undefined;
    if (row === undefined) throw new Error('research_stage_run_not_found');
    return executionContextSchema.parse(JSON.parse(row.context_json));
  }

  getArtifactContent(projectId: string, artifactId: string): ResearchArtifactContent | null {
    if (this.research.getArtifact(artifactId).projectId !== projectId) throw new Error('research_artifact_project_mismatch');
    const row = this.db.prepare('SELECT run_id, output_json, created_at FROM research_artifact_contents WHERE artifact_id = ? AND project_id = ?')
      .get(artifactId, projectId) as { run_id: string; output_json: string; created_at: string } | undefined;
    if (row === undefined) return null;
    return researchArtifactContentSchema.parse({ artifactId, projectId, runId: row.run_id, output: JSON.parse(row.output_json), createdAt: row.created_at });
  }

  markRunning(id: string, projectId: string, model: { providerId: string; modelId: string }): ResearchStageRun {
    const run = this.requireActive(id, projectId);
    if (run.status !== 'queued') throw new Error('research_run_already_started');
    const running: ResearchStageRun = {
      ...run, providerId: model.providerId, modelId: model.modelId, status: 'running', startedAt: this.now()
    };
    this.db.transaction(() => {
      this.saveRun(running);
      this.recordEvent(running, 'role_started', '阶段角色正在执行。');
    })();
    return running;
  }

  recordModelVersion(id: string, projectId: string, modelVersion: string | null): void {
    const run = this.requireActive(id, projectId);
    this.saveRun({ ...run, modelVersion });
  }

  complete(id: string, projectId: string, value: unknown): ResearchStageRun {
    const output = researchStageOutputSchema.parse(value);
    return this.db.transaction(() => {
      const run = this.requireActive(id, projectId);
      if (run.status !== 'running') throw new Error('research_run_not_started');
      const artifact = this.research.createArtifact({ projectId, stage: run.stage, kind: run.outputKind, title: output.title, path: null });
      const claims = output.claims.map((claim) => this.research.evidence.createClaim({ ...claim, projectId, artifactId: artifact.id }));
      if (run.outputKind === 'manuscript') {
        this.research.evidence.saveManuscript({
          artifactId: artifact.id,
          sections: output.sections.map((section) => ({ title: section.title, claimIds: section.claimIndexes.map((index) => {
            const claim = claims[index];
            if (claim === undefined) throw new Error('research_output_claim_index_invalid');
            return claim.id;
          }) }))
        });
      }
      const timestamp = this.now();
      this.db.prepare('INSERT INTO research_artifact_contents (artifact_id, project_id, run_id, output_json, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(artifact.id, projectId, run.id, JSON.stringify(output), timestamp);
      for (const subject of [{ type: 'artifact' as const, id: artifact.id }, ...claims.map((claim) => ({
        type: claim.subjectType === 'figure' ? 'figure_claim' as const : claim.subjectType, id: claim.id
      }))]) {
        this.research.addProvenance({ projectId, artifactId: artifact.id, subjectType: subject.type, subjectId: subject.id,
          sourceType: 'model_run', sourceId: run.id, locator: null, excerpt: null });
      }
      const completed: ResearchStageRun = { ...run, status: 'completed', outputArtifactIds: [artifact.id], endedAt: timestamp };
      this.saveRun(completed);
      this.recordEvent(completed, 'role_completed', '阶段角色已生成产物。');
      if (run.parentRunId === null) {
        this.db.prepare('UPDATE research_stage_states SET active_run_id = NULL WHERE project_id = ? AND stage = ?').run(projectId, run.stage);
        this.research.transitionWorkflow({ projectId, expectedStage: run.stage, action: 'complete' });
      }
      return completed;
    })();
  }

  terminate(id: string, projectId: string, status: 'failed' | 'cancelled' | 'interrupted', error: string): ResearchStageRun {
    return this.db.transaction(() => {
      const run = this.get(id, projectId);
      if (run.status !== 'queued' && run.status !== 'running') return run;
      const terminal: ResearchStageRun = { ...run, status, error, endedAt: this.now() };
      this.saveRun(terminal);
      if (run.parentRunId === null) {
        const changed = this.db.prepare('UPDATE research_stage_states SET active_run_id = NULL, status = ?, last_error = ? WHERE project_id = ? AND stage = ? AND active_run_id = ?')
          .run(status === 'failed' ? 'failed' : 'paused', error, projectId, run.stage, run.id);
        if (changed.changes === 1) {
          this.db.prepare("UPDATE research_projects SET status = 'paused', updated_at = ? WHERE id = ? AND status != 'archived'").run(this.now(), projectId);
        }
      }
      this.recordEvent(terminal, `role_${status}`, status === 'failed' ? '阶段角色执行失败。' : '阶段角色已停止，可从保存的输入重试。');
      return terminal;
    })();
  }

  recoverInterrupted(): number {
    const rows = this.db.prepare("SELECT id, project_id FROM research_stage_runs WHERE status IN ('queued','running')")
      .all() as Array<{ id: string; project_id: string }>;
    for (const row of rows) this.terminate(row.id, row.project_id, 'interrupted', 'research_run_interrupted_by_restart');
    return rows.length;
  }

  private requireActive(id: string, projectId: string): ResearchStageRun {
    const run = this.get(id, projectId);
    const workflow = this.research.getWorkflow(projectId);
    const current = workflow.stages.find((stage) => stage.stage === run.stage);
    if (!['queued', 'running'].includes(run.status) || workflow.currentStage !== run.stage || current?.status !== 'running' ||
        current.activeRunId !== (run.parentRunId ?? run.id) || workflow.projectStatus === 'archived') {
      throw new Error('research_run_not_current');
    }
    return run;
  }

  private captureContext(projectId: string, stage: ResearchStageRun['stage']): ResearchExecutionContext {
    return {
      project: this.research.getProject(projectId), skillInstructions: getResearchSkillInstructions(stage),
      inputs: this.research.listArtifacts(projectId).filter((artifact) => artifact.status === 'approved').map((artifact) => ({
        artifact, output: this.getArtifactContent(projectId, artifact.id)?.output ?? null,
        manuscript: this.research.evidence.getManuscript(artifact.id)
      }))
    };
  }

  private insertRun(run: ResearchStageRun, context: ResearchExecutionContext): void {
    this.db.prepare('INSERT INTO research_stage_runs (id, project_id, stage, request_id, parent_run_id, status, snapshot_json, context_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(run.id, run.projectId, run.stage, run.requestId, run.parentRunId, run.status, JSON.stringify(run), JSON.stringify(context));
  }

  private saveRun(run: ResearchStageRun): void {
    researchStageRunSchema.parse(run);
    this.db.prepare('UPDATE research_stage_runs SET status = ?, snapshot_json = ? WHERE id = ?')
      .run(run.status, JSON.stringify(run), run.id);
  }

  private recordEvent(run: ResearchStageRun, type: string, message: string): void {
    this.db.prepare('INSERT INTO research_workflow_events (id, project_id, stage, type, message, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), run.projectId, run.stage, type, message,
        JSON.stringify({ runId: run.id, role: run.role, modelId: run.modelId, providerId: run.providerId }), this.now());
  }
}
