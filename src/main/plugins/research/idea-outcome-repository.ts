import {randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {
  researchIdeaOutcomeSaveSchema, researchIdeaOutcomeGetSchema, researchIdeaOutcomeHistorySchema,
  researchIdeaOutcomeSnapshotSchema, researchIdeaOutcomeMaterialSchema,
  type ResearchIdeaOutcomeSave, type ResearchIdeaOutcomeMaterial, type ResearchIdeaOutcomeReceipt,
  type ResearchIdeaOutcomeGet, type ResearchIdeaOutcomeHistory, type ResearchIdeaOutcomeHistoryResult
} from '../../../shared/schemas/research-idea-outcomes';
import {requireResearchHuman} from '../../services/research-human-context';
import {researchContentHash} from './research-files';
import {assertExperimentMetricEvidence} from './experiment-result-evidence';
import type {ResearchRepository} from './repository';

type Row = {
  id: string; project_id: string; artifact_id: string; plan_version_id: string; version: number;
  request_id: string; snapshot_json: string; snapshot_hash: string; created_at: string
};

/** Append human assessments separately from immutable method plans and measured results. */
export class ResearchIdeaOutcomeRepository {
  constructor(private readonly db: Database, private readonly research: ResearchRepository, private readonly now: () => string) {}

  save(input: ResearchIdeaOutcomeSave, inputMaterial: ResearchIdeaOutcomeMaterial): ResearchIdeaOutcomeReceipt {
    const request = researchIdeaOutcomeSaveSchema.parse(input);
    const material = researchIdeaOutcomeMaterialSchema.parse(inputMaterial);
    const actor = requireResearchHuman('research.ideaOutcomes.save', request.projectId);
    return this.db.transaction(() => {
      this.requireScope(request.projectId, request.artifactId);
      if (this.research.getProject(request.projectId).status === 'archived') throw new Error('research_project_archived');
      const plan = this.research.ideaPlans.get({projectId: request.projectId, artifactId: request.artifactId,
        versionId: request.plan.versionId, expectedHash: request.plan.versionHash});
      if (plan.freeze === null || plan.freezeHash !== request.plan.freezeHash) throw new Error('research_idea_outcome_frozen_plan_required');
      if (JSON.stringify({version: plan.version, versionHash: plan.versionHash, freeze: plan.freeze, freezeHash: plan.freezeHash}) !==
        JSON.stringify(material.plan)) throw new Error('research_idea_outcome_material_changed');
      const result = this.research.experimentResults.get({projectId: request.projectId, ...request.result});
      if (JSON.stringify(result) !== JSON.stringify(material.result)) throw new Error('research_idea_outcome_material_changed');
      const run = this.research.experiments.get(request.projectId, result.snapshot.execution.runId);
      if (run.status !== 'completed' || run.startedAt !== material.executionTime.startedAt ||
        run.endedAt !== material.executionTime.endedAt) throw new Error('research_idea_outcome_material_changed');
      assertMaterial(request, material);
      for (const evidence of material.evidence) {
        if (JSON.stringify(this.research.evidence.getEvidence(evidence.id, request.projectId)) !== JSON.stringify(evidence)) {
          throw new Error('research_idea_outcome_material_changed');
        }
      }
      const requestHash = researchContentHash(JSON.stringify(request));
      const replay = this.db.prepare('SELECT * FROM research_idea_outcomes WHERE project_id=? AND request_id=?')
        .get(request.projectId, request.requestId) as Row | undefined;
      if (replay !== undefined) {
        const receipt = this.inspect(replay);
        if (receipt.snapshot.requestHash !== requestHash || receipt.snapshot.actor.id !== actor.id ||
          JSON.stringify(receipt.snapshot.material) !== JSON.stringify(material)) throw new Error('research_idea_outcome_request_conflict');
        return receipt;
      }
      const latest = this.latest(request.plan.versionId);
      if (latest === undefined ? request.parent !== null :
        request.parent?.outcomeId !== latest.id || request.parent.outcomeHash !== latest.snapshot_hash) {
        throw new Error('research_idea_outcome_version_conflict');
      }
      const snapshot = researchIdeaOutcomeSnapshotSchema.parse({
        schemaVersion: 1, id: `idea_outcome_${randomUUID()}`, version: latest === undefined ? 1 : latest.version + 1,
        request, requestHash, actor, recordedAt: this.now(), material
      });
      const json = JSON.stringify(snapshot), snapshotHash = researchContentHash(json);
      this.db.prepare(`INSERT INTO research_idea_outcomes
        (id,project_id,artifact_id,plan_version_id,version,request_id,snapshot_json,snapshot_hash,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(snapshot.id, request.projectId, request.artifactId, request.plan.versionId,
        snapshot.version, request.requestId, json, snapshotHash, snapshot.recordedAt);
      return {snapshot, snapshotHash};
    })();
  }

  get(input: ResearchIdeaOutcomeGet): ResearchIdeaOutcomeReceipt {
    const request = researchIdeaOutcomeGetSchema.parse(input);
    this.requireScope(request.projectId, request.artifactId);
    const row = this.row(request.outcomeId);
    if (row.project_id !== request.projectId || row.artifact_id !== request.artifactId) throw new Error('research_idea_outcome_project_mismatch');
    if (row.snapshot_hash !== request.expectedHash) throw new Error('research_idea_outcome_version_conflict');
    return this.inspect(row);
  }

  history(input: ResearchIdeaOutcomeHistory): ResearchIdeaOutcomeHistoryResult {
    const request = researchIdeaOutcomeHistorySchema.parse(input);
    this.requireScope(request.projectId, request.artifactId);
    const plan = this.db.prepare('SELECT project_id,artifact_id FROM research_idea_plan_versions WHERE id=?')
      .get(request.versionId) as {project_id: string; artifact_id: string} | undefined;
    if (plan === undefined) throw new Error('research_idea_plan_not_found');
    if (plan.project_id !== request.projectId || plan.artifact_id !== request.artifactId) throw new Error('research_idea_outcome_project_mismatch');
    const rows = this.db.prepare('SELECT * FROM research_idea_outcomes WHERE artifact_id=? AND plan_version_id=? ORDER BY version DESC LIMIT ? OFFSET ?')
      .all(request.artifactId, request.versionId, request.limit, request.offset) as Row[];
    const total = this.db.prepare('SELECT count(*) FROM research_idea_outcomes WHERE artifact_id=? AND plan_version_id=?')
      .pluck().get(request.artifactId, request.versionId) as number;
    return {verification: 'stored_receipt', items: rows.map(row => this.inspect(row)), total};
  }

  private requireScope(projectId: string, artifactId: string): void {
    this.research.getProject(projectId);
    const artifact = this.research.getArtifact(artifactId);
    if (artifact.projectId !== projectId) throw new Error('research_idea_outcome_project_mismatch');
    if (artifact.kind !== 'idea_canvas') throw new Error('research_idea_canvas_artifact_required');
  }
  private latest(versionId: string): Row | undefined {
    return this.db.prepare('SELECT * FROM research_idea_outcomes WHERE plan_version_id=? ORDER BY version DESC LIMIT 1').get(versionId) as Row | undefined;
  }
  private row(id: string): Row {
    const row = this.db.prepare('SELECT * FROM research_idea_outcomes WHERE id=?').get(id) as Row | undefined;
    if (row === undefined) throw new Error('research_idea_outcome_not_found');
    return row;
  }
  private inspect(row: Row): ResearchIdeaOutcomeReceipt {
    const snapshot = researchIdeaOutcomeSnapshotSchema.parse(JSON.parse(row.snapshot_json));
    if (JSON.stringify(snapshot) !== row.snapshot_json || researchContentHash(row.snapshot_json) !== row.snapshot_hash ||
      snapshot.id !== row.id || snapshot.version !== row.version || snapshot.request.projectId !== row.project_id ||
      snapshot.request.artifactId !== row.artifact_id || snapshot.request.plan.versionId !== row.plan_version_id ||
      snapshot.request.requestId !== row.request_id || snapshot.recordedAt !== row.created_at ||
      snapshot.requestHash !== researchContentHash(JSON.stringify(snapshot.request))) throw new Error('research_idea_outcome_snapshot_invalid');
    const request = snapshot.request;
    assertMaterial(request, snapshot.material);
    if (request.parent === null) {
      if (snapshot.version !== 1) throw new Error('research_idea_outcome_snapshot_invalid');
    } else {
      const parent = this.row(request.parent.outcomeId);
      if (parent.snapshot_hash !== request.parent.outcomeHash || parent.plan_version_id !== row.plan_version_id ||
        parent.artifact_id !== row.artifact_id || parent.project_id !== row.project_id || parent.version !== row.version - 1 ||
        researchContentHash(parent.snapshot_json) !== parent.snapshot_hash) throw new Error('research_idea_outcome_snapshot_invalid');
    }
    return {snapshot, snapshotHash: row.snapshot_hash};
  }
}

/** Validate saved provenance without treating it as proof that current source files remain valid. */
function assertMaterial(request: ResearchIdeaOutcomeSave, material: ResearchIdeaOutcomeMaterial): void {
  const {plan, result, executionTime} = material;
  const invalid: () => never = () => {throw new Error('research_idea_outcome_snapshot_invalid');};
  if (plan.version.id !== request.plan.versionId || plan.versionHash !== request.plan.versionHash ||
    plan.version.request.projectId !== request.projectId || plan.version.request.artifactId !== request.artifactId ||
    plan.version.requestHash !== researchContentHash(JSON.stringify(plan.version.request)) ||
    plan.freezeHash !== request.plan.freezeHash || researchContentHash(JSON.stringify(plan.version)) !== plan.versionHash ||
    researchContentHash(JSON.stringify(plan.freeze)) !== plan.freezeHash ||
    plan.freeze.request.projectId !== request.projectId || plan.freeze.request.artifactId !== request.artifactId ||
    plan.freeze.request.versionId !== plan.version.id || plan.freeze.request.expectedHash !== plan.versionHash ||
    plan.freeze.requestHash !== researchContentHash(JSON.stringify(plan.freeze.request)) ||
    result.snapshot.request.projectId !== request.projectId || result.snapshot.id !== request.result.resultId ||
    result.snapshotHash !== request.result.expectedHash || researchContentHash(JSON.stringify(result.snapshot)) !== result.snapshotHash ||
    Date.parse(executionTime.startedAt) > Date.parse(executionTime.endedAt)) invalid();
  const metrics = plan.version.request.body.metrics;
  if (request.metrics.length !== metrics.length ||
    request.metrics.some(mapping => !metrics.some(metric => metric.id === mapping.plannedMetricId))) invalid();
  const measured = request.metrics.filter(mapping => mapping.kind === 'measured');
  if (material.evidence.length !== measured.length ||
    new Set(material.evidence.map(evidence => evidence.id)).size !== material.evidence.length) invalid();
  const differences: ResearchIdeaOutcomeMaterial['differences'] = [];
  for (const metric of metrics) {
    const mapping = request.metrics.find(item => item.plannedMetricId === metric.id)!;
    if (mapping.kind === 'missing') {
      differences.push({plannedMetricId: metric.id, fields: ['missing_metric']});
      continue;
    }
    const evidence = material.evidence.find(item => item.id === mapping.evidenceId);
    if (evidence === undefined) invalid();
    const source = assertExperimentMetricEvidence(evidence, JSON.parse(evidence.excerpt).source, result);
    const definition = result.snapshot.request.definitions.find(item => item.id === source.metricId)!;
    const fields = (['definition', 'unit', 'direction'] as const).filter(field => metric[field] !== definition[field]);
    if (fields.length > 0) differences.push({plannedMetricId: metric.id, fields});
  }
  if (JSON.stringify(differences) !== JSON.stringify(material.differences) ||
    (differences.length > 0) !== (request.verdict === 'not_comparable')) invalid();
}
