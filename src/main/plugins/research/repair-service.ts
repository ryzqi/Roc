import {randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {z} from 'zod';
import {researchStageSchema} from '../../../shared/schemas/research';
import {executionInputVersionSchema} from '../../../shared/schemas/execution';
import {researchRelationReviewerSchema} from '../../../shared/schemas/research-evidence-relations';
import {researchRepairStartSchema, researchRepairReceiptSchema, researchRepairStages,
  type ResearchRepairStart, type ResearchRepairReceipt} from '../../../shared/schemas/research-repair';
import type {ResearchStage} from '../../../shared/types';
import {requireResearchHuman} from '../../services/research-human-context';
import {researchContentHash} from './research-files';
import type {ResearchImpactService} from './impact-service';
import type {ResearchRepository} from './repository';

const stageSchema = z.strictObject({stage: researchStageSchema, completed: z.boolean(),
  inputArtifactIds: z.string().array(), inputVersions: executionInputVersionSchema.array(), outputArtifactIds: z.string().array()});
const planSchema = z.strictObject({stages: stageSchema.array()});
type Plan = z.infer<typeof planSchema>;
type Row = {id: string; project_id: string; request_json: string; request_hash: string; actor_json: string;
  plan_json: string; plan_hash: string; status: 'active' | 'completed' | 'cancelled'; created_at: string};
const digest = (value: unknown): string => researchContentHash(JSON.stringify(value));

/** An explicit new repair plan selects new run inputs; existing execution nodes remain historical. */
export class ResearchRepairService {
  constructor(private readonly db: Database, private readonly research: ResearchRepository,
    private readonly impact: ResearchImpactService, private readonly now: () => string) {}

  start(input: ResearchRepairStart): ResearchRepairReceipt {
    const request = researchRepairStartSchema.parse(input);
    const actor = requireResearchHuman('research.impact.repair', request.projectId);
    return this.db.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM research_repairs WHERE project_id=? AND request_id=?')
        .get(request.projectId, request.requestId) as Row | undefined;
      if (previous !== undefined) {
        if (previous.request_hash !== digest(request) || previous.actor_json !== JSON.stringify(actor)) throw new Error('research_repair_request_conflict');
        return this.receipt(previous);
      }
      const workflow = this.research.getWorkflow(request.projectId);
      if (workflow.projectStatus === 'archived') throw new Error('research_project_archived');
      if (workflow.currentStage !== request.expectedStage) throw new Error('research_workflow_stage_conflict');
      if (this.active(request.projectId) !== null) throw new Error('research_repair_active');
      if (workflow.stages.some(stage => stage.activeRunId !== null || stage.status === 'waiting_approval') ||
          this.research.runs.pendingOutputReviews().some(run => run.projectId === request.projectId)) throw new Error('research_repair_run_active');
      const report = this.impact.inspect({projectId: request.projectId, source: request.source});
      if (report.stale || report.reportHash !== request.expectedReportHash) throw new Error('research_repair_impact_changed');
      const selected = new Set(request.targetArtifactIds), affected = new Map(report.affected.map(item => [item.artifactId, item]));
      if (request.targetArtifactIds.some(id => !affected.has(id)) || report.affected.some(item =>
        this.research.getArtifact(item.artifactId).status !== 'superseded' &&
        item.reasons.some(reason => reason.kind !== 'run_context') && !selected.has(item.artifactId))) throw new Error('research_repair_targets_incomplete');
      const targets = request.targetArtifactIds.map(id => this.research.getArtifact(id));
      if (targets.some(artifact => artifact.projectId !== request.projectId || artifact.status === 'superseded')) throw new Error('research_repair_current_target_required');
      const stages = researchRepairStages(targets);
      if (stages.length !== request.inputs.length || stages.some(stage => !request.inputs.some(input => input.stage === stage))) {
        throw new Error('research_repair_inputs_incomplete');
      }
      if (!stages.includes('writing') && stages.some(stage => ['review', 'export'].includes(stage))) {
        this.research.reviews.requireForStage(request.projectId, stages.includes('review') ? 'review' : 'export');
      }
      const plan: Plan = {stages: stages.map(stage => {
        const inputs = request.inputs.find(input => input.stage === stage)!.artifacts;
        for (const input of inputs) {
          const artifact = this.research.getArtifact(input.artifactId);
          if (selected.has(input.artifactId) || artifact.status !== 'approved' || artifact.projectId !== request.projectId ||
              this.research.inspectArtifact({projectId: request.projectId, artifactId: artifact.id,
                expectedVersion: input.expectedVersion}).status !== 'current') throw new Error('research_repair_inputs_changed');
        }
        const inputArtifactIds = inputs.map(input => input.artifactId);
        return {stage, inputArtifactIds, inputVersions: this.research.runs.captureInputVersions(request.projectId, inputArtifactIds),
          completed: false, outputArtifactIds: []};
      })};
      const timestamp = this.now(), repairId = `repair_${randomUUID()}`;
      for (const id of selected) this.db.prepare("UPDATE research_artifacts SET status='superseded',updated_at=? WHERE id=?")
        .run(timestamp, id);
      for (const stage of stages) {
        this.db.prepare(`UPDATE research_stage_states SET artifact_ids_json='[]',status=?,active_run_id=NULL,
          gate_approved=0,entered_at=?,completed_at=NULL,last_error=NULL WHERE project_id=? AND stage=?`)
          .run(stage === stages[0] ? 'ready' : 'locked', stage === stages[0] ? timestamp : null, request.projectId, stage);
      }
      if (stages.includes('review')) {
        this.db.prepare("UPDATE research_review_cycles SET status='reviewing',report_artifact_ids_json='[]',updated_at=? WHERE project_id=?")
          .run(timestamp, request.projectId);
      }
      this.db.prepare("UPDATE research_projects SET current_stage=?,status='active',updated_at=? WHERE id=?")
        .run(stages[0], timestamp, request.projectId);
      this.db.prepare(`INSERT INTO research_repairs
        (id,project_id,request_id,request_json,request_hash,actor_json,plan_json,plan_hash,status,created_at) VALUES (?,?,?,?,?,?,?,?,'active',?)`)
        .run(repairId, request.projectId, request.requestId, JSON.stringify(request), digest(request), JSON.stringify(actor), JSON.stringify(plan), digest(plan), timestamp);
      this.db.prepare(`INSERT INTO research_workflow_events(id,project_id,stage,type,message,payload_json,created_at)
        VALUES (?,?,?,'targeted_repair_started',?,?,?)`).run(randomUUID(), request.projectId, stages[0], request.reason,
        JSON.stringify({repairId, source: request.source, reportHash: report.reportHash, targetArtifactIds: request.targetArtifactIds}), timestamp);
      return this.receipt(this.active(request.projectId)!);
    })();
  }

  selection(projectId: string, stage: ResearchStage): string[] | null {
    const current = this.active(projectId);
    if (current === null) return null;
    const plan = planSchema.parse(JSON.parse(current.plan_json));
    const selection = plan.stages.find(input => input.stage === stage) ??
      (stage === 'revision' ? plan.stages.find(input => input.stage === 'writing') : undefined);
    if (selection === undefined) return null;
    if (digest(selection.inputVersions) !== digest(this.research.runs.captureInputVersions(projectId, selection.inputArtifactIds))) {
      throw new Error('research_repair_inputs_changed');
    }
    const ids = [...new Set([...selection.inputArtifactIds, ...plan.stages.flatMap(previous => previous.completed ? previous.outputArtifactIds : [])])];
    if (ids.some(id => this.research.getArtifact(id).status !== 'approved')) throw new Error('research_repair_inputs_changed');
    return ids;
  }

  /** Called only inside the existing successful human stage approval transaction. */
  complete(projectId: string, stage: ResearchStage, outputArtifactIds: string[]): boolean {
    const current = this.active(projectId);
    if (current === null) return false;
    const plan = planSchema.parse(JSON.parse(current.plan_json));
    const selected = plan.stages.find(input => input.stage === stage) ??
      (stage === 'revision' ? plan.stages.find(input => input.stage === 'writing') : undefined);
    if (selected !== undefined) {
      if (outputArtifactIds.some(id => this.research.getArtifact(id).status !== 'approved')) {
        throw new Error('research_repair_output_changed');
      }
      selected.completed = true;
      selected.outputArtifactIds = outputArtifactIds;
      this.db.prepare('UPDATE research_repairs SET plan_json=?,plan_hash=? WHERE id=?').run(JSON.stringify(plan), digest(plan), current.id);
    }
    return true;
  }

  finish(projectId: string): void {
    const current = this.active(projectId);
    if (current === null) return;
    if (planSchema.parse(JSON.parse(current.plan_json)).stages.some(stage => !stage.completed)) return;
    this.db.prepare("UPDATE research_repairs SET status='completed' WHERE id=?").run(current.id);
  }

  active(projectId: string): Row | null {
    const row = this.db.prepare("SELECT * FROM research_repairs WHERE project_id=? AND status='active'").get(projectId) as Row | undefined;
    if (row === undefined) return null;
    this.assertSnapshot(row);
    return row;
  }

  /** A separate explicit manual stage move abandons this plan, preserving its receipt. */
  cancelForMove(projectId: string): void {
    const row = this.active(projectId);
    if (row !== null) this.db.prepare("UPDATE research_repairs SET status='cancelled' WHERE id=?").run(row.id);
  }

  private assertSnapshot(row: Row): void {
    if (researchContentHash(row.request_json) !== row.request_hash || researchContentHash(row.plan_json) !== row.plan_hash) {
      throw new Error('research_repair_snapshot_invalid');
    }
    planSchema.parse(JSON.parse(row.plan_json));
  }

  private receipt(row: Row): ResearchRepairReceipt {
    this.assertSnapshot(row);
    const request = researchRepairStartSchema.parse(JSON.parse(row.request_json));
    if (request.projectId !== row.project_id || digest(request) !== row.request_hash) throw new Error('research_repair_snapshot_invalid');
    return researchRepairReceiptSchema.parse({repairId: row.id, projectId: row.project_id, source: request.source,
      reportHash: request.expectedReportHash, targetArtifactIds: request.targetArtifactIds,
      stages: planSchema.parse(JSON.parse(row.plan_json)).stages.map(stage => stage.stage),
      actor: researchRelationReviewerSchema.parse(JSON.parse(row.actor_json)), createdAt: row.created_at,
      workflow: this.research.getWorkflow(row.project_id)});
  }
}
