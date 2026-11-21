import type {Database} from 'better-sqlite3';
import {
  researchImpactInspectSchema, researchImpactReportSchema, type ResearchImpactInspect,
  type ResearchImpactReport, type ResearchImpactReason
} from '../../../shared/schemas/research-impact';
import {researchExperimentResultEvidenceMetadataSchema} from '../../../shared/schemas/research-experiment-results';
import type {ResearchArtifact} from '../../../shared/types';
import type {ResearchRepository} from './repository';
import {researchContentHash} from './research-files';
import {relationSourceDigest} from './evidence-relation-repository';

type Artifact = Pick<ResearchArtifact, 'id' | 'stage' | 'title'>;
export type ResearchImpactEdge = {from: string; to: string; reason: ResearchImpactReason};
const key = (kind: 'artifact' | 'evidence' | 'result', id: string): string => `${kind}:${id}`;
const digest = (value: unknown): string => researchContentHash(JSON.stringify(value));
const sorted = <T extends {id: string}>(values: T[]): T[] => values.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Fixed-point closure over recorded edges; broad run context stays an explicit reason. */
export function deriveResearchImpact(artifacts: Artifact[], source: string, edges: ResearchImpactEdge[]): {
  affected: ResearchImpactReport['affected']; preservedArtifactIds: string[]; reached: Set<string>
} {
  const adjacency = new Map<string, ResearchImpactEdge[]>();
  for (const edge of edges) {
    const children = adjacency.get(edge.from);
    if (children === undefined) adjacency.set(edge.from, [edge]);
    else children.push(edge);
  }
  const reached = new Set([source]), queue = [source];
  const reasons = new Map<string, Map<string, ResearchImpactReason>>();
  const addReason = (target: string, reason: ResearchImpactReason): void => {
    if (!target.startsWith('artifact:')) return;
    let values = reasons.get(target);
    if (values === undefined) {values = new Map(); reasons.set(target, values);}
    values.set(JSON.stringify(reason), reason);
  };
  addReason(source, {kind: 'source', subjectId: source.slice('artifact:'.length), detail: '所选变更源工件。'});
  for (let offset = 0; offset < queue.length; offset++) for (const edge of adjacency.get(queue[offset]) ?? []) {
    if (!reached.has(edge.to)) {reached.add(edge.to); queue.push(edge.to);}
  }
  const semantic = new Set([source]), semanticQueue = [source];
  for (let offset = 0; offset < semanticQueue.length; offset++) for (const edge of adjacency.get(semanticQueue[offset]) ?? []) {
    if (edge.reason.kind !== 'run_context' && !semantic.has(edge.to)) {semantic.add(edge.to); semanticQueue.push(edge.to);}
  }
  for (const edge of edges) if (reached.has(edge.from)) {
    addReason(edge.to, semantic.has(edge.from) || edge.reason.kind === 'run_context' ? edge.reason : {
      kind: 'run_context', subjectId: edge.reason.subjectId,
      detail: `仅由冻结运行上下文传递（${edge.reason.kind}）：${edge.reason.detail}`
    });
  }
  const affected: ResearchImpactReport['affected'] = [], preservedArtifactIds: string[] = [];
  for (const artifact of sorted([...artifacts])) {
    const values = reasons.get(key('artifact', artifact.id));
    if (values === undefined) preservedArtifactIds.push(artifact.id);
    else affected.push({artifactId: artifact.id, stage: artifact.stage, title: artifact.title,
      reasons: [...values].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, reason]) => reason)});
  }
  return {affected, preservedArtifactIds, reached};
}

/** Metadata-only impact analysis. It does not reopen files or assert scientific validity. */
export class ResearchImpactService {
  constructor(private readonly db: Database, private readonly research: ResearchRepository) {}

  inspect(input: ResearchImpactInspect): ResearchImpactReport {
    const request = researchImpactInspectSchema.parse(input);
    return this.db.transaction(() => this.capture(request))();
  }

  private capture(request: ResearchImpactInspect): ResearchImpactReport {
    const {projectId, source} = request;
    const project = this.research.getProject(projectId);
    const artifacts = sorted(this.research.listArtifacts(projectId));
    const artifactIds = new Set(artifacts.map(artifact => artifact.id));
    const edges: ResearchImpactEdge[] = [], pins = new Map<string, unknown>();
    const edge = (from: string, to: string, kind: ResearchImpactReason['kind'], subjectId: string, detail: string): void => {
      if (to.startsWith('artifact:') && !artifactIds.has(to.slice('artifact:'.length))) throw new Error('research_impact_project_mismatch');
      edges.push({from, to, reason: {kind, subjectId, detail}});
    };
    const use = (kind: 'artifact' | 'evidence' | 'result', id: string, artifactId: string,
      reason: ResearchImpactReason['kind'], subjectId: string, detail: string): void => {
      edge(key(kind, id), key('artifact', artifactId), reason, subjectId, detail);
    };
    const runArtifacts = new Map<string, string>();
    const executionRows = this.db.prepare('SELECT run_id FROM research_experiment_executions WHERE project_id=? ORDER BY run_id')
      .all(projectId) as {run_id: string}[];
    for (const row of executionRows) {
      const run = this.research.experiments.get(projectId, row.run_id);
      if (run.artifactId !== null) runArtifacts.set(run.id, run.artifactId);
    }
    for (const artifact of artifacts) if (artifact.kind === 'figure' && this.research.figures.hasArtifact(artifact.id)) {
      const figure = this.research.figures.forArtifact(artifact);
      runArtifacts.set(figure.runId, artifact.id);
    }
    const resultRows = this.db.prepare('SELECT id,snapshot_hash FROM research_experiment_results WHERE project_id=? ORDER BY id')
      .all(projectId) as {id: string; snapshot_hash: string}[];
    for (const row of resultRows) {
      const result = this.research.experimentResults.get({projectId, resultId: row.id, expectedHash: row.snapshot_hash});
      pins.set(key('result', row.id), {hash: result.snapshotHash,
        execution: this.research.experiments.get(projectId, result.snapshot.execution.runId)});
      const artifactId = runArtifacts.get(result.snapshot.execution.runId);
      if (artifactId !== undefined) {
        use('result', row.id, artifactId, 'experiment_result', row.id, '实验工件关联此结果回执。');
        edge(key('artifact', artifactId), key('result', row.id), 'experiment_result', row.id, '结果记录来自此实验工件的执行。');
      }
    }
    for (const record of sorted(this.research.evidence.list(projectId))) {
      const inspected = this.research.evidence.inspectEvidence(record.id, projectId);
      pins.set(key('evidence', record.id), relationSourceDigest(inspected));
      const metadata = this.research.evidence.sourceMetadata(projectId, record.id);
      if (metadata?.type === 'experiment-result') {
        const reference = researchExperimentResultEvidenceMetadataSchema.parse(metadata);
        if (!pins.has(key('result', reference.resultId))) throw new Error('research_impact_result_not_found');
        edge(key('result', reference.resultId), key('evidence', record.id), 'result_evidence', record.id, '指标证据固定到结果回执与 JSON 位置。');
      }
      const artifactId = runArtifacts.get(record.sourceId);
      if (record.sourceType === 'experiment' && artifactId !== undefined) {
        edge(key('artifact', artifactId), key('evidence', record.id), 'result_evidence', record.id, '证据记录引用此生产执行。');
      }
    }
    for (const artifact of artifacts) {
      for (const claim of this.research.evidence.listClaims({projectId, artifactId: artifact.id})) {
        for (const evidenceId of claim.evidenceIds) use('evidence', evidenceId, artifact.id, 'claim_evidence', claim.id, '当前主张显式引用此证据。');
      }
      for (const relation of this.research.evidence.relations.forArtifact(artifact.id, projectId)) {
        if (relation.status === 'confirmed' || relation.status === 'proposed') {
          use('evidence', relation.evidenceId, artifact.id, 'evidence_relation', relation.id, '当前证据关系记录涉及此来源。');
        }
      }
      const consistency = this.research.consistency.latest(projectId, artifact.id);
      for (const binding of consistency?.snapshot.request.bindings ?? []) {
        use('result', binding.resultId, artifact.id, 'numeric_mapping', consistency!.snapshot.id, '已保存数值映射引用此结果。');
        use('evidence', binding.evidenceId, artifact.id, 'numeric_mapping', consistency!.snapshot.id, '已保存数值映射引用此指标证据。');
      }
      if (artifact.kind === 'figure') {
        const review = this.research.figureConsistency.latest(projectId, artifact.id);
        for (const binding of review?.snapshot.request.bindings ?? []) {
          use('result', binding.resultId, artifact.id, 'figure_mapping', review!.snapshot.id, '已保存场景数据映射引用此结果。');
          use('evidence', binding.evidenceId, artifact.id, 'figure_mapping', review!.snapshot.id, '已保存场景数据映射引用此指标证据。');
        }
      }
      if (artifact.kind === 'manuscript') {
        const response = this.research.responseMatrix.latest(projectId, artifact.id);
        for (const row of response?.snapshot.request.rows ?? []) for (const evidenceId of row.evidenceIds) {
          use('evidence', evidenceId, artifact.id, 'response_evidence', row.commentId, '回复矩阵中的意见引用此证据。');
        }
        const journal = this.research.journalCompliance.latest(projectId, artifact.id);
        for (const figureId of journal?.snapshot.request.selection.figureIds ?? []) {
          const figure = this.research.figures.get(projectId, figureId);
          use('artifact', figure.artifactId, artifact.id, 'journal_figure', journal!.snapshot.id, '投稿检查包含此图稿。');
        }
      }
      if (artifact.kind === 'review_report') {
        const content = this.research.runs.getArtifactContent(projectId, artifact.id);
        if (content?.output.scientificReview !== undefined) {
          const review = this.research.scientificReviews.inspect(projectId, artifact.id);
          use('artifact', review.manuscriptArtifactId, artifact.id, 'scientific_review', artifact.id, '科学审查明确核验此正文。');
          for (const record of review.input.evidence) use('evidence', record.evidence.id, artifact.id,
            'scientific_review', artifact.id, '科学审查冻结了此来源。');
        }
      }
      if (artifact.kind === 'idea_canvas') {
        const canvas = this.research.ideas.get(artifact.id);
        for (const evidenceId of canvas?.fields.flatMap(field => field.evidenceIds) ?? []) {
          use('evidence', evidenceId, artifact.id, 'idea_plan', artifact.id, 'Idea Canvas 字段引用此证据。');
        }
        const plan = this.research.ideaPlans.history({projectId, artifactId: artifact.id, offset: 0, limit: 1}).items[0];
        const body = plan?.version.request.body;
        const evidenceIds = body === undefined ? [] : [...body.novelty.comparisons.map(item => item.evidenceId),
          ...(body.observation.kind === 'after_data' ? body.observation.evidenceIds : []),
          ...(body.sampleSize.kind === 'calculated' ? body.sampleSize.evidenceIds : [])];
        for (const evidenceId of evidenceIds) use('evidence', evidenceId, artifact.id, 'idea_plan', plan!.version.id, '方法计划引用此证据。');
        for (const outcome of this.research.ideaOutcomes.forArtifact(projectId, artifact.id)) {
          use('result', outcome.snapshot.request.result.resultId, artifact.id, 'idea_outcome', outcome.snapshot.id, '计划结果评估引用此结果回执。');
        }
      }
    }
    const runs = this.db.prepare('SELECT id FROM research_stage_runs WHERE project_id=? ORDER BY id').all(projectId) as {id: string}[];
    for (const {id} of runs) {
      const run = this.research.runs.get(id, projectId);
      for (const inputId of run.inputArtifactIds) for (const outputId of run.outputArtifactIds) {
        use('artifact', inputId, outputId, 'run_context', run.id, '阶段运行冻结了此输入上下文；未记录更细的语义使用范围。');
      }
    }
    const revisions = this.db.prepare(`SELECT b.artifact_id,b.parent_artifact_id FROM research_manuscript_sync_bindings b
      JOIN research_artifacts a ON a.id=b.artifact_id WHERE a.project_id=? AND b.parent_artifact_id IS NOT NULL ORDER BY b.artifact_id`)
      .all(projectId) as {artifact_id: string; parent_artifact_id: string}[];
    for (const revision of revisions) use('artifact', revision.parent_artifact_id, revision.artifact_id,
      'manuscript_revision', revision.artifact_id, '修订稿从此正文版本分支。');
    const exports = this.db.prepare('SELECT id FROM research_export_executions WHERE project_id=? ORDER BY id').all(projectId) as {id: string}[];
    for (const {id} of exports) {
      const exported = this.research.exports.get(projectId, id), artifactId = exported.artifactId;
      if (artifactId === null) continue;
      use('artifact', exported.request.manuscriptArtifactId, artifactId, 'export_source', id, '已保存导出选择了此正文。');
      for (const figureId of exported.request.figureIds) use('artifact', this.research.figures.get(projectId, figureId).artifactId,
        artifactId, 'export_source', id, '已保存导出选择了此图稿。');
      for (const evidence of exported.sources?.evidence ?? []) use('evidence', evidence.id, artifactId, 'export_source', id, '交付包冻结了此证据。');
      for (const result of exported.sources?.experimentResults ?? []) use('result', result.snapshot.id, artifactId, 'export_source', id, '交付包冻结了此结果回执。');
      for (const reportId of exported.sources?.review.reportArtifactIds ?? []) use('artifact', reportId, artifactId, 'scientific_review', id, '交付包包含此审稿结论。');
    }
    let sourceKey: string, stale: boolean;
    switch (source.kind) {
      case 'artifact': {
        if (!artifactIds.has(source.artifactId)) {
          this.research.getArtifact(source.artifactId);
          throw new Error('research_impact_project_mismatch');
        }
        const inspected = this.research.inspectArtifact({projectId, artifactId: source.artifactId, expectedVersion: source.expectedVersion});
        sourceKey = key('artifact', source.artifactId); stale = inspected.status === 'stale';
        break;
      }
      case 'evidence': {
        const inspected = this.research.evidence.inspectEvidence(source.evidenceId, projectId);
        sourceKey = key('evidence', source.evidenceId); stale = relationSourceDigest(inspected) !== source.expectedSourceDigest;
        break;
      }
      case 'result': {
        const row = this.db.prepare('SELECT project_id,snapshot_hash FROM research_experiment_results WHERE id=?').get(source.resultId) as
          {project_id: string; snapshot_hash: string} | undefined;
        if (row === undefined) throw new Error('research_impact_result_not_found');
        if (row.project_id !== projectId) throw new Error('research_impact_project_mismatch');
        sourceKey = key('result', source.resultId); stale = row.snapshot_hash !== source.expectedHash;
        break;
      }
    }
    const {affected, preservedArtifactIds, reached} = deriveResearchImpact(artifacts, sourceKey, edges);
    for (const {artifactId} of affected) pins.set(key('artifact', artifactId),
      this.research.inspectArtifact({projectId, artifactId, expectedVersion: null}).snapshot.version);
    const body = {projectId, source, coverage: 'recorded_relationships' as const, affected, preservedArtifactIds, stale};
    const basis = [...pins].filter(([node]) => reached.has(node)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return researchImpactReportSchema.parse({...body, reportHash: digest({body, basis,
      project: {status: project.status, currentStage: project.currentStage}, workflow: this.research.getWorkflow(projectId)})});
  }
}
