import {researchNodeOutputSchema} from '../../../shared/schemas/research-task-graph';
import {researchWorkerLease} from './execution/worker-context';
import {researchNodeLeaseSchema, researchTaskNodeSchema} from '../../../shared/schemas/research-task-graph';
import { createHash, randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { z } from 'zod';

import { researchArtifactSchema, researchProjectSchema, researchStageSchema } from '../../../shared/schemas/research';
import { researchManuscriptSchema } from '../../../shared/schemas/research-evidence';
import { researchIdeaCanvasSchema } from '../../../shared/schemas/research-ideas';
import {
  researchArtifactContentSchema,
  researchStageOutputSchema,
  researchStagePolicySchema,
  researchStageRunSchema
} from '../../../shared/schemas/research-runs';
import type {
  ResearchArtifact, ResearchArtifactContent, ResearchStageOutput, ResearchStagePolicy, ResearchStageRun,
  ResearchStageRunStartRequest, ResearchStageRunRetryRequest, ResearchStageRunsRequest
} from '../../../shared/types';
import type { ResearchRepository } from './repository';
import { getResearchStageRoleProfile, researchCapabilityToolNames } from './role-profiles';
import {researchSkills} from './research-skills';
import {researchSkillPinSchema} from '../../../shared/schemas/research-skills';
import { researchReviewRoles } from './review-repository';
import { requireConfirmedSearchStrategy, searchPlanReviewMarkdown } from './search-strategy';
import {relationSourceDigest} from './evidence-relation-repository';
import type {ConsumedResearchDispatchGrant} from '../../services/deep-agent/execution-grant-broker';
import {assertResearchDispatchGrant} from '../../services/deep-agent/execution-grant-broker';
import {researchDispatchRequestHash} from '../../services/research-dispatch-context';
import {executionInputVersionSchema} from '../../../shared/schemas/execution';
import {scientificReviewInputSchema} from '../../../shared/schemas/research-scientific-review';

const executionContextSchema = z.object({
  project: researchProjectSchema,
  skillInstructions: z.string().min(1),
  skillPin: researchSkillPinSchema,
  scientificInput: scientificReviewInputSchema.optional(),
  inputVersions: z.array(executionInputVersionSchema),
  reviewReports: z.array(z.object({ role: z.string(), runId: z.string(), artifactId: z.string(), output: researchStageOutputSchema }).strict()),
  inputs: z.array(z.object({
    artifact: researchArtifactSchema,
    output: researchStageOutputSchema.nullable(),
    manuscript: researchManuscriptSchema.nullable(),
    ideaCanvas: researchIdeaCanvasSchema.nullable()
  }).strict())
}).strict();

export type ResearchExecutionContext = z.infer<typeof executionContextSchema>;

const hashStageValue = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function freezeStageInputs(run: ResearchStageRun, context: ResearchExecutionContext) {
  return {
    schemaVersion: 1 as const,
    requestHash: researchDispatchRequestHash({projectId: run.projectId, expectedStage: run.stage, instruction: run.instruction, requestId: run.requestId}),
    manifestHash: hashStageValue({policy: run.policy, skillHash: run.skillHash, toolNames: run.toolNames}),
    policyHash: hashStageValue(run.policy),
    versions: [
      ...run.skillIds.map(id => ({kind: 'skill' as const, id, hash: run.skillHash})),
      ...context.inputVersions,
      {kind: 'context' as const, id: run.id, hash: hashStageValue({project: context.project, skillInstructions: context.skillInstructions, skillPin: context.skillPin, inputs: context.inputs,
        ...(context.scientificInput === undefined ? {} : {scientificInput: context.scientificInput})})}
    ]
  };
}

type StageRunRow = { id: string; project_id: string; task_id: string | null; status: string;
  stage: string; request_id: string; parent_run_id: string | null; snapshot_json: string };
const parseStageRunRow = (row: StageRunRow): ResearchStageRun => {
  const run = researchStageRunSchema.parse(JSON.parse(row.snapshot_json));
  if (run.id !== row.id || run.projectId !== row.project_id || run.taskId !== row.task_id || run.status !== row.status ||
      run.stage !== row.stage || run.requestId !== row.request_id || run.parentRunId !== row.parent_run_id) {
    throw new Error('research_stage_run_identity_corrupt');
  }
  return run;
};

export class ResearchRunRepository {
  constructor(private readonly db: Database, private readonly research: ResearchRepository, private readonly now: () => string) {}

  initializeProject(projectId: string): void {
    for (const stage of researchStageSchema.options) {
      const policy: ResearchStagePolicy = {
        projectId, stage, tier: stage === 'retrieval' ? 'fast' : ['writing', 'review', 'revision'].includes(stage) ? 'deep' : 'balanced',
        model: { kind: 'app_default' }
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

  begin(request: ResearchStageRunStartRequest, retryOf?: ResearchStageRun, dispatch: ConsumedResearchDispatchGrant | null = null): ResearchStageRun {
    if (dispatch !== null) assertResearchDispatchGrant(dispatch);
    const result = this.db.transaction(() => {
      const existing = this.db.prepare('SELECT id, project_id, task_id, status, stage, request_id, parent_run_id, snapshot_json FROM research_stage_runs WHERE project_id = ? AND request_id = ?')
        .get(request.projectId, request.requestId) as StageRunRow | undefined;
      if (existing !== undefined) {
        const run = parseStageRunRow(existing);
        if (run.parentRunId !== null || run.instruction !== request.instruction || run.stage !== request.expectedStage || run.retryOfRunId !== (retryOf?.id ?? null)) {
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
      if (stage.status === 'running' && this.hasCompletedParent(request.projectId, stage.stage)) {
        throw new Error('research_stage_awaiting_gate');
      }
      if (!['ready', 'running', 'paused', 'failed', 'blocked'].includes(stage.status)) throw new Error('research_stage_not_runnable');
      const cycle = this.research.reviews.requireForStage(request.projectId, stage.stage);
      const revisionRound = stage.stage === 'revision' && cycle !== null ? cycle.revisionRound + 1 : cycle?.revisionRound ?? 0;
      if (retryOf !== undefined && (retryOf.reviewCycleId !== (cycle?.originArtifactId ?? null) || retryOf.revisionRound !== revisionRound)) {
        throw new Error('research_review_cycle_changed');
      }
      this.retireDraftRunOutputs(request.projectId, stage.stage, stage.artifactIds);
      const profile = getResearchStageRoleProfile(stage.stage);
      const policy = retryOf?.policy ?? this.listPolicies(request.projectId).find((entry) => entry.stage === stage.stage);
      if (policy === undefined) throw new Error('research_stage_policy_missing');
      const context = retryOf === undefined ? this.captureContext(request.projectId, stage.stage) : this.getContext(retryOf.id);
      if (retryOf !== undefined) this.assertInputsCurrent(retryOf);
      if (stage.stage === 'retrieval') requireConfirmedSearchStrategy(this.research, context);
      this.verifyCurrentInputs(request.projectId, context);
      const timestamp = this.now();
      const run: ResearchStageRun = {
        id: `research_run_${randomUUID()}`, projectId: request.projectId, stage: stage.stage, requestId: request.requestId,
        taskId: null, executionSnapshot: null,
        parentRunId: null, retryOfRunId: retryOf?.id ?? null, role: retryOf?.role ?? profile.role, outputKind: retryOf?.outputKind ?? profile.outputKind,
        reviewCycleId: cycle?.originArtifactId ?? null, revisionRound,
        status: 'queued', instruction: request.instruction, skillIds: retryOf?.skillIds ?? [...profile.skillIds],
        skillHash: hashStageValue({pin: context.skillPin, instructions: context.skillInstructions}),
        toolNames: retryOf?.toolNames ?? profile.allowedCapabilities.map((capability) => {
          const name = researchCapabilityToolNames[capability];
          if (name === undefined) throw new Error('research_role_capability_unknown');
          return name;
        }),
        inputArtifactIds: context.inputs.map((input) => input.artifact.id), outputArtifactIds: [], policy,
        providerId: null, modelId: null, modelVersion: null, error: null, createdAt: timestamp, startedAt: null, endedAt: null
      };
      this.insertRun(run, context, dispatch);
      if (run.stage === 'review') {
        this.db.prepare("UPDATE research_review_cycles SET status = 'reviewing', updated_at = ? WHERE project_id = ?").run(timestamp, run.projectId);
      }
      this.db.prepare("UPDATE research_stage_states SET status = 'running', active_run_id = ?, entered_at = COALESCE(entered_at, ?), last_error = NULL WHERE project_id = ? AND stage = ?")
        .run(run.id, timestamp, run.projectId, run.stage);
      this.db.prepare("UPDATE research_projects SET status = 'active', updated_at = ? WHERE id = ?").run(timestamp, run.projectId);
      this.recordEvent(run, 'role_queued', '阶段角色已排队。');
      return run;
    })();
    return this.bindTask(result.id, result.projectId);
  }

  retry(request: ResearchStageRunRetryRequest): ResearchStageRun {
    const previous = this.get(request.runId, request.projectId);
    if (previous.stage === 'figure' && !previous.toolNames.includes('get_figure')) {
      throw new Error('research_run_tool_contract_changed');
    }
    if (previous.parentRunId !== null) throw new Error('research_run_retry_parent_required');
    if (!['failed', 'cancelled', 'interrupted'].includes(previous.status)) throw new Error('research_run_not_retryable');
    if (request.requestId === previous.requestId) throw new Error('research_run_request_conflict');
    return this.begin({ projectId: request.projectId, expectedStage: previous.stage, instruction: previous.instruction, requestId: request.requestId }, previous);
  }

  get(id: string, projectId: string): ResearchStageRun {
    const row = this.db.prepare('SELECT id, project_id, task_id, status, stage, request_id, parent_run_id, snapshot_json FROM research_stage_runs WHERE id = ? AND project_id = ?').get(id, projectId) as StageRunRow | undefined;
    if (row === undefined) throw new Error('research_stage_run_not_found');
    return parseStageRunRow(row);
  }

  bindTask(id: string, projectId: string): ResearchStageRun {
    const run = this.get(id, projectId);
    const execution = this.research.tasks.requireExecution('stage', id, projectId);
    if (run.taskId !== null && run.taskId !== execution.taskId) throw new Error('research_task_execution_conflict');
    const linked = { ...run, taskId: execution.taskId };
    if (run.executionSnapshot === null) throw new Error('research_stage_snapshot_invalid');
    this.verifyFrozenInputs(run);
    this.saveRun(linked);
    this.research.tasks.confirmExecution('stage', id, projectId, run.executionSnapshot.frozenInputs);
    return linked;
  }

  flushTaskEvents(taskId: string | null = null): {pending: number; failed: number} {
    const rows = this.db.prepare('SELECT * FROM research_execution_outbox WHERE delivered_at IS NULL AND (? IS NULL OR task_id=?) ORDER BY created_at,event_id LIMIT 1000')
      .all(taskId,taskId) as Array<{event_id: string; task_id: string; project_id: string; event_type: string; payload_json: string; payload_hash: string; created_at: string}>;
    for (const row of rows) {
      try {
        this.research.tasks.receiveEvent({eventId: row.event_id,taskId: row.task_id,projectId: row.project_id,
          eventType: row.event_type,payload: JSON.parse(row.payload_json),payloadHash: row.payload_hash,createdAt: row.created_at});
        this.db.prepare('UPDATE research_execution_outbox SET delivered_at=?,error=NULL WHERE event_id=?').run(this.now(),row.event_id);
      } catch {
        this.db.prepare("UPDATE research_execution_outbox SET error='research_event_delivery_failed' WHERE event_id=?").run(row.event_id);
      }
    }
    return this.db.prepare('SELECT COUNT(*) pending,COALESCE(SUM(error IS NOT NULL),0) failed FROM research_execution_outbox WHERE delivered_at IS NULL AND (? IS NULL OR task_id=?)')
      .get(taskId,taskId) as {pending: number; failed: number};
  }

  reconcileTaskLinks(): void {
    this.research.tasks.reconcileStageIntents((id,projectId) => this.db.prepare('SELECT 1 FROM research_stage_runs WHERE id=? AND project_id=?').get(id,projectId) !== undefined);
    this.db.transaction(() => {
      const rows = this.db.prepare('SELECT id, project_id, task_id, status, stage, request_id, parent_run_id, snapshot_json FROM research_stage_runs')
        .all() as StageRunRow[];
      for (const row of rows) {
        const run = parseStageRunRow(row);
        const execution = this.research.tasks.findExecution('stage', run.id, run.projectId);
        if (run.taskId === null) {
          if (execution !== null) this.bindTask(run.id, run.projectId);
        } else if (execution === null || execution.taskId !== run.taskId) {
          throw new Error('research_task_execution_conflict');
        } else if (execution.associationState !== 'historical') {
          this.bindTask(run.id, run.projectId);
        }
      }
    }).immediate();
    const receipts = this.db.prepare('SELECT execution_id,lease_json,output_json FROM research_node_output_receipts').all() as
      Array<{execution_id: string; lease_json: string; output_json: string}>;
    for (const receipt of receipts) {
      const lease = researchNodeLeaseSchema.parse(JSON.parse(receipt.lease_json));
      const output = researchTaskNodeSchema.shape.output.unwrap().parse(JSON.parse(receipt.output_json));
      const run = this.get(receipt.execution_id, lease.projectId);
      if (run.id !== lease.executionId || run.status !== 'completed' || JSON.stringify(this.nodeOutput(run)) !== JSON.stringify(output)) {
        throw new Error('research_node_receipt_conflict');
      }
      this.research.tasks.graph.reconcileOutput(lease, output, run.parentRunId === null);
    }
    const decisions = this.db.prepare('SELECT * FROM research_node_decision_receipts').all() as
      Array<{node_id: string; project_id: string; output_hash: string; output_revision: number; accepted: number}>;
    for (const decision of decisions) this.research.tasks.graph.reconcileDecision({nodeId: decision.node_id,
      projectId: decision.project_id, hash: decision.output_hash, revision: decision.output_revision, accepted: decision.accepted === 1});
  }

  list(request: ResearchStageRunsRequest): ResearchStageRun[] {
    this.research.getProject(request.projectId);
    return (this.db.prepare('SELECT id, project_id, task_id, status, stage, request_id, parent_run_id, snapshot_json FROM research_stage_runs WHERE project_id = ? ORDER BY rowid DESC LIMIT ?')
      .all(request.projectId, request.limit) as StageRunRow[]).map(parseStageRunRow);
  }

  getContext(runId: string): ResearchExecutionContext {
    const row = this.db.prepare('SELECT context_json, snapshot_json FROM research_stage_runs WHERE id = ?').get(runId) as { context_json: string; snapshot_json: string } | undefined;
    if (row === undefined) throw new Error('research_stage_run_not_found');
    if (researchStageRunSchema.parse(JSON.parse(row.snapshot_json)).executionSnapshot === null) throw new Error('historical_execution_not_resumable');
    return executionContextSchema.parse(JSON.parse(row.context_json));
  }

  createReviewChildren(id: string, projectId: string): ResearchStageRun[] {
    const children = this.db.transaction(() => {
      const parent = this.requireDispatchable(id, projectId);
      if (parent.stage !== 'review' || parent.parentRunId !== null) throw new Error('research_review_parent_required');
      const existing = this.db.prepare('SELECT id FROM research_stage_runs WHERE parent_run_id=? ORDER BY rowid').all(parent.id) as {id: string}[];
      if (existing.length > 0) {
        if (existing.length !== researchReviewRoles.length) throw new Error('research_review_panel_incomplete');
        return existing.map(row => this.get(row.id, projectId));
      }
      const context = this.getContext(parent.id);
      const cycle = this.research.reviews.requireForStage(projectId, 'review');
      if (cycle === null) throw new Error('research_review_cycle_missing');
      const inputs = context.inputs.filter(({ artifact }) =>
        (artifact.kind === 'manuscript' && artifact.id === cycle.manuscriptArtifactId) ||
        artifact.kind === 'experiment_run' || artifact.kind === 'figure')
        .map(input => ({...input, output: null, ideaCanvas: null}));
      return researchReviewRoles.map(({ role, focus }) => {
        const skillInstructions = `${context.skillInstructions}\n\n本角色职责：${focus}\n不得读取其他评审角色的报告。`;
        const child: ResearchStageRun = {
          ...parent, id: `research_run_${randomUUID()}`, parentRunId: parent.id, retryOfRunId: null,
          requestId: `${parent.id}:${role}`, role, status: 'queued', instruction: `${parent.instruction}\n${focus}`,
          toolNames: parent.toolNames.filter((name) => !['read_review_report', 'read_source_migrations', 'read_source_replacements'].includes(name)),
          inputArtifactIds: inputs.map((entry) => entry.artifact.id),
          skillHash: hashStageValue({pin: context.skillPin, instructions: skillInstructions}), outputArtifactIds: [],
          providerId: null, modelId: null, modelVersion: null, error: null, createdAt: this.now(), startedAt: null, endedAt: null
        };
        this.insertRun(child, { ...context, skillInstructions, inputs,
          inputVersions: this.captureInputVersions(projectId, inputs.map(input => input.artifact.id)), reviewReports: [] });
        this.recordEvent(child, 'role_queued', '独立评审角色已排队。');
        return child;
      });
    })();
    return children.map(child => this.bindTask(child.id, child.projectId));
  }

  setReviewReports(id: string, projectId: string, children: ResearchStageRun[]): void {
    const parent = this.requireActive(id, projectId);
    if (children.length !== researchReviewRoles.length) throw new Error('research_review_panel_incomplete');
    const reviewReports = children.map((child) => {
      const saved = this.get(child.id, projectId);
      if (saved.parentRunId !== parent.id || saved.status !== 'completed' || saved.outputArtifactIds.length !== 1) {
        throw new Error('research_review_panel_incomplete');
      }
      const binding = this.research.tasks.requireExecution('stage', saved.id, projectId).nodeBinding;
      if (binding.kind !== 'dag') throw new Error('research_node_binding_invalid');
      const node = this.research.tasks.graph.get(binding.nodeId, projectId);
      if (node.status !== 'done' || JSON.stringify(node.output) !== JSON.stringify(this.nodeOutput(saved))) {
        throw new Error('research_node_output_changed');
      }
      const artifactId = saved.outputArtifactIds[0];
      const content = this.getArtifactContent(projectId, artifactId);
      if (content === null) throw new Error('research_review_report_missing');
      return { role: saved.role, runId: saved.id, artifactId, output: content.output };
    });
    const context = { ...this.getContext(parent.id), reviewReports };
    this.db.prepare('UPDATE research_stage_runs SET context_json = ? WHERE id = ?').run(JSON.stringify(context), parent.id);
  }

  requireReviewPanel(projectId: string, artifactIds: string[]): void {
    const contents = artifactIds.map((id) => this.getArtifactContent(projectId, id)).filter((entry) => entry !== null);
    const summary = contents.find((content) => {
      const run = this.get(content.runId, projectId);
      return run.parentRunId === null && run.stage === 'review' && run.status === 'completed';
    });
    if (summary === undefined) throw new Error('research_review_synthesis_required');
    const parent = this.get(summary.runId, projectId);
    const reports = this.getContext(parent.id).reviewReports;
    if (reports.length !== researchReviewRoles.length || researchReviewRoles.some(({ role }) => !reports.some((report) => report.role === role))) {
      throw new Error('research_review_panel_incomplete');
    }
    for (const report of reports) {
      const child = this.get(report.runId, projectId);
      if (child.parentRunId !== parent.id || child.status !== 'completed' || !artifactIds.includes(report.artifactId)) {
        throw new Error('research_review_panel_incomplete');
      }
      const inspection = this.research.scientificReviews.inspect(projectId, report.artifactId);
      if (inspection.status !== 'current') throw new Error('research_scientific_review_stale');
    }
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
    if (run.stage === 'figure' && !run.toolNames.includes('get_figure')) {
      throw new Error('research_run_tool_contract_changed');
    }
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
    let output = researchStageOutputSchema.parse(value);
    const lease = researchWorkerLease();
    return this.research.tasks.graph.commit(lease, () => {
    const completed = this.db.transaction(() => {
      const run = this.requireActive(id, projectId);
      if (run.status !== 'running') throw new Error('research_run_not_started');
      if (run.stage === 'review' && run.parentRunId !== null) {
        const input = this.getContext(run.id).scientificInput;
        if (input === undefined || output.scientificReview === undefined) throw new Error('research_scientific_review_required');
        if (output.claims.length > 0 || output.sections.length > 0) throw new Error('research_reviewer_readonly');
        this.research.scientificReviews.validate(run, input, output.scientificReview);
      } else if (output.scientificReview !== undefined) throw new Error('research_scientific_review_role_invalid');
      if (run.stage === 'discovery') {
        if (output.searchPlan === undefined) throw new Error('research_search_plan_required');
        if (output.searchPlan.researchQuestion !== run.instruction) throw new Error('research_search_question_changed');
        output = researchStageOutputSchema.parse({...output, markdown: output.markdown + searchPlanReviewMarkdown(output.searchPlan)});
      } else if (output.searchPlan !== undefined) throw new Error('research_search_plan_stage_invalid');
      const artifacts = this.outputArtifacts(run, output);
      const timestamp = this.now();
      for (const artifact of artifacts) this.attachOutput(run, artifact, output, timestamp);
      const outputArtifactIds = [...run.outputArtifactIds];
      for (const artifact of artifacts) if (!outputArtifactIds.includes(artifact.id)) outputArtifactIds.push(artifact.id);
      const completed: ResearchStageRun = { ...run, status: 'completed', outputArtifactIds, endedAt: timestamp };
      this.saveRun(completed);
      if (run.parentRunId !== null) {
        const parent = this.get(run.parentRunId, projectId);
        const parentOutputIds = [...parent.outputArtifactIds];
        for (const artifact of artifacts) if (!parentOutputIds.includes(artifact.id)) parentOutputIds.push(artifact.id);
        this.saveRun({ ...parent, outputArtifactIds: parentOutputIds });
      }
      this.recordEvent(completed, 'role_completed', '阶段角色已生成产物。');
      if (run.parentRunId === null) {
        this.db.prepare('UPDATE research_stage_states SET active_run_id = NULL WHERE project_id = ? AND stage = ?').run(projectId, run.stage);
      }
      this.db.prepare('INSERT INTO research_node_output_receipts(execution_id,lease_json,output_json) VALUES(?,?,?)')
        .run(completed.id, JSON.stringify(lease), JSON.stringify(this.nodeOutput(completed)));
      return completed;
    })();
    this.research.tasks.graph.finish(lease, this.nodeOutput(completed), completed.parentRunId === null);
    return completed;
    });
  }

  nodeOutput(run: ResearchStageRun) {
    const binding = this.research.tasks.requireExecution('stage', run.id, run.projectId).nodeBinding;
    if (binding.kind !== 'dag') throw new Error('research_node_binding_invalid');
    const node = this.research.tasks.graph.get(binding.nodeId, run.projectId);
    const artifacts = run.outputArtifactIds.map(id => ({id, content: this.getArtifactContent(run.projectId, id)}));
    if (artifacts.length === 0 || artifacts.some(entry => entry.content === null)) throw new Error('research_node_output_missing');
    return researchNodeOutputSchema.parse({revision: node.output?.revision ?? node.outputRevision + 1, schemaVersion: 1,
      hash: hashStageValue({executionId: run.id, artifacts}), artifactIds: run.outputArtifactIds});
  }

  commitStageDecision<T>(projectId: string, stage: ResearchStageRun['stage'], artifactIds: string[], accepted: boolean, write: () => T): T {
    const rows = this.db.prepare("SELECT id FROM research_stage_runs WHERE project_id=? AND stage=? AND status='completed' AND parent_run_id IS NULL")
      .all(projectId, stage) as {id: string}[];
    const decisions = rows.map(row => this.get(row.id, projectId))
      .filter(run => run.outputArtifactIds.some(id => artifactIds.includes(id))).map(run => {
        if (run.outputArtifactIds.some(id => !artifactIds.includes(id))) throw new Error('research_node_output_changed');
        const binding = this.research.tasks.requireExecution('stage', run.id, projectId).nodeBinding;
        if (binding.kind !== 'dag') throw new Error('research_node_binding_invalid');
        return {nodeId: binding.nodeId, projectId, ...this.nodeOutput(run), accepted};
      });
    return this.research.tasks.graph.commitDecisions(decisions, () => this.db.transaction(() => {
      const result = write();
      for (const decision of decisions) this.db.prepare(
        'INSERT INTO research_node_decision_receipts(node_id,project_id,output_hash,output_revision,accepted) VALUES(?,?,?,?,?) ON CONFLICT(node_id) DO NOTHING')
        .run(decision.nodeId, projectId, decision.hash, decision.revision, accepted ? 1 : 0);
      return result;
    })());
  }

  terminate(id: string, projectId: string, status: 'failed' | 'cancelled' | 'interrupted', error: string): ResearchStageRun {
    return this.db.transaction(() => {
      const run = this.get(id, projectId);
      if (run.status !== 'queued' && run.status !== 'running') return run;
      const terminal: ResearchStageRun = { ...run, status, error, endedAt: this.now() };
      this.saveRun(terminal);
      this.research.tasks.graph.stopExecution(run.id, projectId, status, error);
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
    for (const row of rows) {
      const run = this.get(row.id, row.project_id);
      const binding = this.research.tasks.requireExecution('stage', run.id, row.project_id).nodeBinding;
      if (binding.kind === 'dag') this.research.tasks.workerEffects.recover(binding.nodeId);
      const task = run.taskId === null ? null : this.research.tasks.get(run.taskId, row.project_id);
      this.terminate(row.id, row.project_id, task?.status === 'cancelled' ? 'cancelled' : 'interrupted',
        task?.status === 'cancelled' ? 'research_task_cancelled' : 'research_run_interrupted_by_restart');
      if (task?.status === 'active') {
        this.research.tasks.setStatus(task.id, row.project_id, 'interrupted', 'research_task_interrupted_by_restart', ['active']);
      }
    }
    return rows.length;
  }

  pendingOutputReviews(): ResearchStageRun[] {
    return (this.db.prepare("SELECT r.id,r.project_id FROM research_stage_runs r JOIN research_stage_states s ON s.project_id=r.project_id AND s.stage=r.stage WHERE r.status='completed' AND r.parent_run_id IS NULL AND s.status IN ('running','waiting_approval') AND s.active_run_id IS NULL")
      .all() as {id: string; project_id: string}[]).map(row => this.get(row.id, row.project_id)).filter(run => {
        const binding = this.research.tasks.requireExecution('stage', run.id, run.projectId).nodeBinding;
        return binding.kind === 'dag' && this.research.tasks.graph.get(binding.nodeId, run.projectId).status === 'pending_review';
      });
  }

  taskIdsForStage(projectId: string, stage: ResearchStageRun['stage']): string[] {
    this.research.getProject(projectId);
    return this.db.prepare(`SELECT DISTINCT task_id FROM research_stage_runs
      WHERE project_id = ? AND stage = ? AND task_id IS NOT NULL AND parent_run_id IS NULL AND status = 'completed'`)
      .pluck().all(projectId, stage) as string[];
  }

  requireActive(id: string, projectId: string): ResearchStageRun {
    const run = this.requireDispatchable(id, projectId);
    this.research.tasks.authorizeStage(run);
    return run;
  }

  /** Completed production belongs to the frozen logical node, across explicit retries. */
  requireProductionOwner(producerRunId: string, projectId: string): ResearchStageRun {
    const current = this.requireActive(researchWorkerLease().executionId, projectId);
    if (current.status !== 'running') throw new Error('research_run_not_current');
    const producer = this.research.tasks.requireExecution('stage', producerRunId, projectId);
    const active = this.research.tasks.requireExecution('stage', current.id, projectId);
    if (producer.taskId !== active.taskId || producer.nodeBinding.kind !== 'dag' || active.nodeBinding.kind !== 'dag' ||
        producer.nodeBinding.nodeId !== active.nodeBinding.nodeId) throw new Error('research_production_owner_mismatch');
    return current;
  }

  requireDispatchable(id: string, projectId: string): ResearchStageRun {
    const run = this.get(id, projectId);
    this.assertInputsCurrent(run);
    const workflow = this.research.getWorkflow(projectId);
    const current = workflow.stages.find((stage) => stage.stage === run.stage);
    if (!['queued', 'running'].includes(run.status) || workflow.currentStage !== run.stage || current?.status !== 'running' ||
        current.activeRunId !== (run.parentRunId ?? run.id) || workflow.projectStatus === 'archived') {
      throw new Error('research_run_not_current');
    }
    if (run.taskId === null || this.research.tasks.get(run.taskId, projectId).status !== 'active') throw new Error('research_task_not_active');
    if (run.parentRunId !== null) {
      const parent = this.requireDispatchable(run.parentRunId, projectId);
      if (parent.parentRunId !== null || parent.stage !== run.stage || parent.taskId !== run.taskId ||
          run.toolNames.some(name => !parent.toolNames.includes(name))) throw new Error('research_stage_child_capability_denied');
    }
    return run;
  }

  assertInputsCurrent(run: ResearchStageRun): void {
    this.verifyFrozenInputs(run);
    const context = this.getContext(run.id);
    const skill = researchSkills.load(run.stage, context.skillPin);
    const capabilities = run.toolNames.map(name => {
      const capability = Object.keys(researchCapabilityToolNames).find(key => researchCapabilityToolNames[key] === name);
      if (capability === undefined) throw new Error('research_skill_capability_denied');
      return capability;
    });
    researchSkills.assertCapabilities(skill.manifest, capabilities);
    this.verifyCurrentInputs(run.projectId, context);
  }

  private hasCompletedParent(projectId: string, stage: ResearchStageRun['stage']): boolean {
    return this.db.prepare("SELECT 1 FROM research_stage_runs WHERE project_id = ? AND stage = ? AND parent_run_id IS NULL AND status = 'completed' LIMIT 1")
      .get(projectId, stage) !== undefined;
  }

  private captureContext(projectId: string, stage: ResearchStageRun['stage']): ResearchExecutionContext {
    const cycle = this.research.reviews.requireForStage(projectId, stage);
    const inputs = this.research.listArtifacts(projectId).filter((artifact) => artifact.status === 'approved')
        .filter((artifact) => stage !== 'review' || artifact.kind !== 'review_report')
        .filter((artifact) => cycle === null || artifact.kind !== 'manuscript' || artifact.id === cycle.manuscriptArtifactId)
        .filter((artifact) => stage !== 'revision' || artifact.kind !== 'review_report' || cycle?.reportArtifactIds.includes(artifact.id))
        .map((artifact) => ({
        artifact, output: this.getArtifactContent(projectId, artifact.id)?.output ?? null,
        manuscript: this.research.manuscripts.getManuscript(artifact.id),
        ideaCanvas: this.research.ideas.get(artifact.id)
      }));
    const skill = researchSkills.load(stage);
    return {
      project: this.research.getProject(projectId), skillInstructions: skill.instructions, skillPin: skill.pin, reviewReports: [],
      inputs, inputVersions: this.captureInputVersions(projectId, inputs.map(input => input.artifact.id)),
      ...(stage === 'review' && cycle !== null ? {scientificInput: this.research.scientificReviews.capture(projectId, cycle.manuscriptArtifactId)} : {})
    };
  }

  private captureInputVersions(projectId: string, artifactIds: string[]): ResearchExecutionContext['inputVersions'] {
    const versions = new Map<string, z.infer<typeof executionInputVersionSchema>>();
    for (const artifactId of artifactIds) {
      const {snapshot} = this.research.inspectArtifact({projectId, artifactId, expectedVersion: null});
      const {artifact, content, origin, claims, evidence, relations, production, ideaCanvas, ideaPlan,
        ideaOutcomes, citationReviews, consistencyReviews, responseMatrix, journalCompliance, provenance, scientificReview} = snapshot;
      // UI state (current stage, available actions) changes as this run starts. Only freeze input material.
      versions.set(`artifact:${artifactId}`, {kind: 'artifact', id: artifactId,
        hash: hashStageValue({artifact, content, origin, claims, evidence, relations, production, ideaCanvas,
          ideaPlan, ideaOutcomes, citationReviews, consistencyReviews, responseMatrix, journalCompliance, provenance,
          ...(scientificReview === undefined ? {} : {scientificReview})})});
      for (const source of evidence) versions.set(`source:${source.evidence.id}`,
        {kind: 'source', id: source.evidence.id, hash: hashStageValue(source)});
      if (ideaPlan !== null) versions.set(`plan:${artifactId}`, {kind: 'plan', id: artifactId, hash: hashStageValue(ideaPlan)});
      if (content?.output.searchPlan !== undefined) versions.set(`plan:${artifactId}`,
        {kind: 'plan', id: artifactId, hash: hashStageValue(content.output.searchPlan)});
    }
    return [...versions.values()];
  }

  private verifyCurrentInputs(projectId: string, context: ResearchExecutionContext): void {
    if (context.scientificInput !== undefined) this.research.scientificReviews.assertCurrent(context.scientificInput);
    const artifactIds = context.inputs.map(input => input.artifact.id);
    if (context.project.id !== projectId || artifactIds.some(id => this.research.getArtifact(id).status !== 'approved') ||
        JSON.stringify(context.inputVersions) !== JSON.stringify(this.captureInputVersions(projectId, artifactIds))) {
      throw new Error('research_stage_inputs_stale');
    }
  }

  private outputArtifacts(run: ResearchStageRun, output: ResearchStageOutput): ResearchArtifact[] {
    if (run.outputKind === 'experiment_run' || run.outputKind === 'figure' || run.outputKind === 'export_package') {
      const lineage = this.lineageRunIds(run);
      const artifacts = this.ownedProductionArtifacts(run).filter((artifact) => {
        const ownerRunId = this.ownerRunIdFor(artifact);
        return ownerRunId !== null && lineage.has(ownerRunId);
      });
      if (artifacts.length === 0) throw new Error('research_stage_production_required');
      return artifacts;
    }
    return [this.research.createArtifact({ projectId: run.projectId, stage: run.stage, kind: run.outputKind, title: output.title, path: null })];
  }

  private ownedProductionArtifacts(run: ResearchStageRun): ResearchArtifact[] {
    const stage = this.research.getWorkflow(run.projectId).stages.find((entry) => entry.stage === run.stage);
    if (stage === undefined) throw new Error('research_stage_not_found');
    const artifacts: ResearchArtifact[] = [];
    for (const id of stage.artifactIds) {
      const artifact = this.research.getArtifact(id);
      if (artifact.status !== 'draft' || artifact.kind !== run.outputKind) continue;
      this.requireProductionArtifact(artifact);
      artifacts.push(artifact);
    }
    return artifacts;
  }

  private requireProductionArtifact(artifact: ResearchArtifact): void {
    if (artifact.kind === 'experiment_run') this.research.experiments.forArtifact(artifact);
    else if (artifact.kind === 'figure') this.research.figures.forArtifact(artifact);
    else if (artifact.kind === 'export_package') this.research.exports.forArtifact(artifact);
    else throw new Error('research_stage_artifact_invalid');
  }

  private ownerRunIdFor(artifact: ResearchArtifact): string | null {
    if (artifact.kind === 'experiment_run') return this.research.experiments.forArtifact(artifact).ownerRunId;
    if (artifact.kind === 'figure') return this.research.figureRuns.get(artifact.projectId, this.research.figures.forArtifact(artifact).runId).ownerRunId;
    if (artifact.kind === 'export_package') return this.research.exports.forArtifact(artifact).ownerRunId;
    return null;
  }

  private lineageRunIds(run: ResearchStageRun): Set<string> {
    const ids = new Set<string>([run.id]);
    let current: ResearchStageRun | null = run;
    while (current.retryOfRunId !== null) {
      current = this.get(current.retryOfRunId, run.projectId);
      ids.add(current.id);
    }
    return ids;
  }

  private attachOutput(run: ResearchStageRun, artifact: ResearchArtifact, output: ResearchStageOutput, timestamp: string): void {
    const claims = output.claims.map((claim) => this.research.evidence.createClaim({ ...claim, projectId: run.projectId, artifactId: artifact.id }));
    // Model "supported" is a semantic proposal, never a recorded human confirmation.
    for (const claim of claims) {
      if (claim.status !== 'supported') continue;
      for (const evidenceId of claim.evidenceIds) {
        const source = this.research.evidence.inspectEvidence(evidenceId, run.projectId);
        this.research.evidence.relations.propose({projectId: run.projectId, claimId: claim.id,
          expectedClaimVersion: claim.version, evidenceId, expectedSourceDigest: relationSourceDigest(source),
          kind: 'supports', condition: null, supersedesRelationId: null}, {kind: 'agent', id: run.id});
      }
    }
    if (run.outputKind === 'manuscript') {
      this.research.manuscripts.saveManuscript({
        artifactId: artifact.id,
        sections: output.sections.map((section) => ({ title: section.title, claimIds: section.claimIndexes.map((index) => {
          const claim = claims[index];
          if (claim === undefined) throw new Error('research_output_claim_index_invalid');
          return claim.id;
        }) }))
      });
    }
    if (run.outputKind === 'idea_canvas') {
      if (output.ideaCanvas === undefined) throw new Error('research_idea_canvas_required');
      this.research.ideas.save({ ...output.ideaCanvas, artifactId: artifact.id, expectedVersion: null });
    }
    this.db.prepare('INSERT INTO research_artifact_contents (artifact_id, project_id, run_id, output_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(artifact.id, run.projectId, run.id, JSON.stringify(output), timestamp);
    const locator = `provider:${run.providerId ?? 'unknown'}; model:${run.modelId ?? 'unknown'}; version:${run.modelVersion ?? 'unknown'}`;
    for (const subject of [{ type: 'artifact' as const, id: artifact.id }, ...claims.map((claim) => ({
      type: claim.subjectType === 'figure' ? 'figure_claim' as const : claim.subjectType, id: claim.id
    }))]) {
      this.research.addProvenance({ projectId: run.projectId, artifactId: artifact.id, subjectType: subject.type, subjectId: subject.id,
        sourceType: 'model_run', sourceId: run.id, locator, excerpt: output.title });
    }
  }

  private retireDraftRunOutputs(projectId: string, stage: ResearchStageRun['stage'], artifactIds: string[]): void {
    const retired = new Set<string>();
    for (const id of artifactIds) {
      const generated = this.db.prepare('SELECT artifact_id FROM research_artifact_contents WHERE project_id = ? AND artifact_id = ?').get(projectId, id);
      if (generated === undefined || this.research.getArtifact(id).status !== 'draft') continue;
      if (this.research.experiments.hasArtifact(id) || this.research.figures.hasArtifact(id) || this.research.exports.hasArtifact(id)) continue;
      this.db.prepare("UPDATE research_artifacts SET status = 'superseded', updated_at = ? WHERE project_id = ? AND id = ?")
        .run(this.now(), projectId, id);
      retired.add(id);
    }
    if (retired.size > 0) {
      this.db.prepare('UPDATE research_stage_states SET artifact_ids_json = ? WHERE project_id = ? AND stage = ?')
        .run(JSON.stringify(artifactIds.filter((id) => !retired.has(id))), projectId, stage);
    }
  }

  private verifyFrozenInputs(run: ResearchStageRun): void {
    const context = this.getContext(run.id);
    if (run.skillHash !== hashStageValue({pin: context.skillPin, instructions: context.skillInstructions}) ||
        run.skillIds.length !== 1 || run.skillIds[0] !== context.skillPin.id || context.skillPin.stage !== run.stage ||run.executionSnapshot === null || run.executionSnapshot.nodeBinding.kind !== 'dag' ||
        JSON.stringify(run.executionSnapshot.frozenInputs) !== JSON.stringify(freezeStageInputs(run, this.getContext(run.id)))) {
      throw new Error('research_stage_snapshot_invalid');
    }
  }

  private insertRun(run: ResearchStageRun, context: ResearchExecutionContext, dispatch: ConsumedResearchDispatchGrant | null = null): void {
    run.executionSnapshot = {schemaVersion: 1, nodeBinding: {kind: 'none'}, frozenInputs: freezeStageInputs(run, context),
      origin: dispatch === null ? {kind: 'main', action: run.parentRunId !== null ? 'review' : run.retryOfRunId !== null ? 'retry' : 'start', requestId: run.requestId}
        : {kind: 'conversation', runId: dispatch.runId, grantId: dispatch.grantId, requestHash: dispatch.requestHash}};
    // This commits independently before the research transaction. A crash leaves a visible pending intent.
    const intent = this.research.tasks.linkStage(run, dispatch);
    run.taskId = intent.taskId;
    this.db.prepare('INSERT INTO research_stage_runs (id, project_id, stage, request_id, parent_run_id, task_id, status, snapshot_json, context_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(run.id, run.projectId, run.stage, run.requestId, run.parentRunId, run.taskId, run.status, JSON.stringify(run), JSON.stringify(context));
  }

  private saveRun(run: ResearchStageRun): void {
    researchStageRunSchema.parse(run);
    this.db.prepare('UPDATE research_stage_runs SET status = ?, task_id = ?, snapshot_json = ? WHERE id = ?')
      .run(run.status, run.taskId, JSON.stringify(run), run.id);
  }

  private recordEvent(run: ResearchStageRun, type: string, message: string): void {
    this.db.prepare('INSERT INTO research_workflow_events (id, project_id, stage, type, message, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), run.projectId, run.stage, type, message,
        JSON.stringify({ runId: run.id, taskId: run.taskId, role: run.role, modelId: run.modelId, providerId: run.providerId }), this.now());
  }
}
