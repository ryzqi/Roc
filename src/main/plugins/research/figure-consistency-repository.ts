import {randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {
  researchFigureConsistencySaveSchema, researchFigureConsistencyReceiptSchema, researchFigureConsistencyHistorySchema, researchFigureConsistencyMaterialSchema,
  type ResearchFigureConsistencySave, type ResearchFigureConsistencyMaterial, type ResearchFigureConsistencyReceipt,
  type ResearchFigureConsistencyHistory
} from '../../../shared/schemas/research-figure-consistency';
import {researchFigureDataTraceSchema, type ResearchFigureDataTrace} from '../../../shared/schemas/research-figure-data';
import {requireResearchHuman} from '../../services/research-human-context';
import {researchContentHash} from './research-files';
import {assertFigureConsistencyMaterial, selectFigureData} from './figure-consistency-material';
import {assertExperimentMetricEvidence} from './experiment-result-evidence';
import {assertFigureRun, figureManifest} from './figure-repository';
import type {ResearchRepository} from './repository';

type Row = {id: string; project_id: string; artifact_id: string; version: number; request_id: string;
  snapshot_json: string; snapshot_hash: string; created_at: string};
export class ResearchFigureConsistencyRepository {
  constructor(private readonly db: Database, private readonly research: ResearchRepository, private readonly now: () => string) {}
  scope(projectId: string, artifactId: string): void {
    this.research.getProject(projectId);
    const artifact = this.research.getArtifact(artifactId);
    if (artifact.projectId !== projectId) throw new Error('research_figure_consistency_project_mismatch');
    if (artifact.kind !== 'figure') throw new Error('research_figure_consistency_figure_required');
  }
  latest(projectId: string, artifactId: string): ResearchFigureConsistencyReceipt | null {
    this.scope(projectId, artifactId);
    const row = this.db.prepare('SELECT * FROM research_figure_consistency_reviews WHERE artifact_id=? ORDER BY version DESC LIMIT 1')
      .get(artifactId) as Row | undefined;
    return row === undefined ? null : this.read(row);
  }
  history(input: ResearchFigureConsistencyHistory): {verification: 'stored_receipt'; items: ResearchFigureConsistencyReceipt[]; total: number} {
    const request = researchFigureConsistencyHistorySchema.parse(input);
    this.scope(request.projectId, request.artifactId);
    const rows = this.db.prepare('SELECT * FROM research_figure_consistency_reviews WHERE artifact_id=? ORDER BY version DESC LIMIT ? OFFSET ?')
      .all(request.artifactId, request.limit, request.offset) as Row[];
    const total = this.db.prepare('SELECT count(*) FROM research_figure_consistency_reviews WHERE artifact_id=?')
      .pluck().get(request.artifactId) as number;
    return {verification: 'stored_receipt', items: rows.map(row => this.read(row)), total};
  }
  save(input: ResearchFigureConsistencySave, inputMaterial: ResearchFigureConsistencyMaterial, inputTrace: ResearchFigureDataTrace): ResearchFigureConsistencyReceipt {
    const request = researchFigureConsistencySaveSchema.parse(input), trace = researchFigureDataTraceSchema.parse(inputTrace);
    const material = researchFigureConsistencyMaterialSchema.parse(inputMaterial);
    if (material.mappings.length !== request.bindings.length) throw new Error('research_figure_consistency_snapshot_invalid');
    const actor = requireResearchHuman('research.figureConsistency.save', request.projectId);
    return this.db.transaction(() => {
      this.scope(request.projectId, request.artifactId);
      if (this.research.getProject(request.projectId).status === 'archived') throw new Error('research_project_archived');
      this.research.requireRelationReviewableArtifact(request.artifactId);
      const row = this.db.prepare('SELECT * FROM research_figure_consistency_reviews WHERE project_id=? AND request_id=?')
        .get(request.projectId, request.requestId) as Row | undefined;
      const previous = row === undefined ? null : this.read(row);
      if (previous !== null) {
        if (JSON.stringify(previous.snapshot.request) !== JSON.stringify(request) || previous.snapshot.actor.id !== actor.id ||
          JSON.stringify(previous.snapshot.material) !== JSON.stringify(material)) throw new Error('research_figure_consistency_request_conflict');
        this.assertCurrent(request, material, trace);
        return previous;
      }
      const latest = this.latest(request.projectId, request.artifactId);
      if (latest === null ? request.parent !== null :
        request.parent?.reviewId !== latest.snapshot.id || request.parent.reviewHash !== latest.snapshotHash) {
        throw new Error('research_figure_consistency_version_conflict');
      }
      const {snapshot} = this.research.inspectArtifact({projectId: request.projectId, artifactId: request.artifactId, expectedVersion: null});
      if (snapshot.version !== request.expectedArtifactVersion) throw new Error('research_consistency_artifact_changed');
      this.assertCurrent(request, material, trace);
      const receipt = researchFigureConsistencyReceiptSchema.parse({snapshot: {
        schemaVersion: 1, id: `figure_consistency_${randomUUID()}`, version: latest === null ? 1 : latest.snapshot.version + 1,
        request, actor, recordedAt: this.now(), material
      }, snapshotHash: '0'.repeat(64)});
      assertFigureConsistencyMaterial(receipt);
      const json = JSON.stringify(receipt.snapshot), snapshotHash = researchContentHash(json);
      this.db.prepare(`INSERT INTO research_figure_consistency_reviews
        (id,project_id,artifact_id,version,request_id,snapshot_json,snapshot_hash,created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(receipt.snapshot.id, request.projectId, request.artifactId, receipt.snapshot.version,
          request.requestId, json, snapshotHash, receipt.snapshot.recordedAt);
      return {...receipt, snapshotHash};
    })();
  }
  private assertCurrent(request: ResearchFigureConsistencySave, material: ResearchFigureConsistencyMaterial, trace: ResearchFigureDataTrace): void {
    const figure = this.research.figures.forArtifact(this.research.getArtifact(request.artifactId));
    const run = this.research.figureRuns.get(request.projectId, figure.runId);
    assertFigureRun(run, figure.validation);
    if (JSON.stringify(figure) !== JSON.stringify(material.figure) ||
      JSON.stringify(run) !== JSON.stringify(material.run) ||
      researchContentHash(figureManifest(run, figure.validation)) !== figure.manifestHash ||
      researchContentHash(JSON.stringify(trace)) !== request.figure.traceHash ||
      trace.sourceHash !== material.trace.sourceHash || trace.rendererHash !== material.trace.rendererHash ||
      trace.compiledSpecHash !== material.trace.compiledSpecHash ||
      !run.files.some(file => file.area === 'output' && file.path === material.trace.file.path &&
        file.sha256 === material.trace.file.sha256 && file.size === material.trace.file.size) ||
      !run.files.some(file => file.area === 'input' && file.path === run.request.sourcePath && file.sha256 === trace.sourceHash)) {
      throw new Error('research_figure_consistency_source_changed');
    }
    request.bindings.forEach((binding, index) => {
      const entry = material.mappings[index];
      const selected = selectFigureData(trace, binding), {items: _items, ...mark} = selected.mark;
      if (JSON.stringify(selected.item) !== JSON.stringify(entry.item) || JSON.stringify(mark) !== JSON.stringify(entry.mark)) {
        throw new Error('research_figure_consistency_source_changed');
      }
      const claim = this.research.evidence.getClaim(binding.claimId);
      if (JSON.stringify(claim) !== JSON.stringify(entry.claim)) throw new Error('research_consistency_claim_changed');
      const evidence = this.research.evidence.inspectEvidence(binding.evidenceId, request.projectId);
      if (evidence.referenceStatus !== 'recorded' || JSON.stringify(evidence.evidence) !== JSON.stringify(entry.evidence)) {
        throw new Error('research_consistency_source_changed');
      }
      const metadata = this.research.evidence.sourceMetadata(request.projectId, binding.evidenceId);
      if (metadata === null) throw new Error('research_consistency_metric_invalid');
      assertExperimentMetricEvidence(entry.evidence, metadata, entry.result);
      const result = this.research.experimentResults.get({projectId: request.projectId,
        resultId: binding.resultId, expectedHash: binding.resultHash});
      if (JSON.stringify(result) !== JSON.stringify(entry.result)) throw new Error('research_consistency_source_changed');
    });
  }
  private read(row: Row): ResearchFigureConsistencyReceipt {
    const receipt = researchFigureConsistencyReceiptSchema.parse({snapshot: JSON.parse(row.snapshot_json), snapshotHash: row.snapshot_hash});
    const {snapshot} = receipt;
    if (JSON.stringify(snapshot) !== row.snapshot_json || researchContentHash(row.snapshot_json) !== row.snapshot_hash ||
      snapshot.id !== row.id || snapshot.version !== row.version || snapshot.recordedAt !== row.created_at ||
      snapshot.request.projectId !== row.project_id || snapshot.request.artifactId !== row.artifact_id ||
      snapshot.request.requestId !== row.request_id) throw new Error('research_figure_consistency_snapshot_invalid');
    assertFigureConsistencyMaterial(receipt);
    const parent = snapshot.request.parent;
    if (parent === null) {
      if (snapshot.version !== 1) throw new Error('research_figure_consistency_snapshot_invalid');
    } else {
      const rowParent = this.db.prepare('SELECT * FROM research_figure_consistency_reviews WHERE id=?').get(parent.reviewId) as Row | undefined;
      if (rowParent === undefined || rowParent.project_id !== row.project_id || rowParent.artifact_id !== row.artifact_id ||
        rowParent.version !== row.version - 1 || rowParent.snapshot_hash !== parent.reviewHash ||
        researchContentHash(rowParent.snapshot_json) !== parent.reviewHash) throw new Error('research_figure_consistency_snapshot_invalid');
    }
    return receipt;
  }
}
