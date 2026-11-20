import {randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {
  researchConsistencySaveSchema, researchConsistencyReceiptSchema, researchConsistencyHistorySchema,
  type ResearchConsistencySave, type ResearchConsistencyReceipt, type ResearchConsistencyHistory
} from '../../../shared/schemas/research-consistency';
import {requireResearchHuman} from '../../services/research-human-context';
import {researchContentHash} from './research-files';
import {relationClaimHash} from './evidence-relation-repository';
import {assertExperimentMetricEvidence, experimentMetricSource} from './experiment-result-evidence';
import {calculateConsistency} from './consistency-calculation';
import type {ResearchRepository} from './repository';

type Row = {id: string; project_id: string; artifact_id: string; version: number; request_id: string;
  snapshot_json: string; snapshot_hash: string; created_at: string};
export class ResearchConsistencyRepository {
  constructor(private readonly db: Database, private readonly research: ResearchRepository, private readonly now: () => string) {}
  scope(projectId: string, artifactId: string): void {
    this.research.getProject(projectId);
    if (this.research.getArtifact(artifactId).projectId !== projectId) throw new Error('research_consistency_project_mismatch');
  }
  existing(request: ResearchConsistencySave): ResearchConsistencyReceipt | null {
    this.scope(request.projectId, request.artifactId);
    const row = this.db.prepare('SELECT * FROM research_consistency_reviews WHERE project_id=? AND request_id=?')
      .get(request.projectId, request.requestId) as Row | undefined;
    return row === undefined ? null : this.read(row);
  }
  latest(projectId: string, artifactId: string): ResearchConsistencyReceipt | null {
    this.scope(projectId, artifactId);
    const row = this.db.prepare('SELECT * FROM research_consistency_reviews WHERE artifact_id=? ORDER BY version DESC LIMIT 1')
      .get(artifactId) as Row | undefined;
    return row === undefined ? null : this.read(row);
  }
  assertReceiptCurrent(receipt: ResearchConsistencyReceipt): void {
    this.scope(receipt.snapshot.request.projectId, receipt.snapshot.request.artifactId);
    this.assertCurrent(receipt.snapshot.request, receipt.snapshot.material);
  }
  history(input: ResearchConsistencyHistory): {verification: 'stored_receipt'; items: ResearchConsistencyReceipt[]; total: number} {
    const request = researchConsistencyHistorySchema.parse(input);
    this.scope(request.projectId, request.artifactId);
    const rows = this.db.prepare('SELECT * FROM research_consistency_reviews WHERE artifact_id=? ORDER BY version DESC LIMIT ? OFFSET ?')
      .all(request.artifactId, request.limit, request.offset) as Row[];
    const total = this.db.prepare('SELECT count(*) FROM research_consistency_reviews WHERE artifact_id=?')
      .pluck().get(request.artifactId) as number;
    return {verification: 'stored_receipt', items: rows.map(row => this.read(row)), total};
  }
  save(input: ResearchConsistencySave, material: ResearchConsistencyReceipt['snapshot']['material']): ResearchConsistencyReceipt {
    const request = researchConsistencySaveSchema.parse(input);
    const actor = requireResearchHuman('research.consistency.save', request.projectId);
    return this.db.transaction(() => {
      this.scope(request.projectId, request.artifactId);
      if (this.research.getProject(request.projectId).status === 'archived') throw new Error('research_project_archived');
      this.research.requireRelationReviewableArtifact(request.artifactId);
      const previous = this.existing(request);
      if (previous !== null) {
        if (JSON.stringify(previous.snapshot.request) !== JSON.stringify(request) || previous.snapshot.actor.id !== actor.id ||
          JSON.stringify(previous.snapshot.material) !== JSON.stringify(material)) throw new Error('research_consistency_request_conflict');
        this.assertCurrent(request, material);
        return previous;
      }
      const latest = this.latest(request.projectId, request.artifactId);
      if (latest === null ? request.parent !== null :
        request.parent?.reviewId !== latest.snapshot.id || request.parent.reviewHash !== latest.snapshotHash) {
        throw new Error('research_consistency_version_conflict');
      }
      const {snapshot} = this.research.inspectArtifact({projectId: request.projectId, artifactId: request.artifactId, expectedVersion: null});
      if (snapshot.version !== request.expectedArtifactVersion) throw new Error('research_consistency_artifact_changed');
      this.assertCurrent(request, material);
      const receipt = researchConsistencyReceiptSchema.parse({snapshot: {
        schemaVersion: 1, id: `consistency_${randomUUID()}`, version: latest === null ? 1 : latest.snapshot.version + 1,
        request, actor, recordedAt: this.now(), material
      }, snapshotHash: '0'.repeat(64)});
      this.assertMaterial(receipt);
      const json = JSON.stringify(receipt.snapshot), snapshotHash = researchContentHash(json);
      this.db.prepare(`INSERT INTO research_consistency_reviews
        (id,project_id,artifact_id,version,request_id,snapshot_json,snapshot_hash,created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(receipt.snapshot.id, request.projectId, request.artifactId, receipt.snapshot.version,
          request.requestId, json, snapshotHash, receipt.snapshot.recordedAt);
      return {...receipt, snapshotHash};
    })();
  }
  private assertCurrent(request: ResearchConsistencySave, material: ResearchConsistencyReceipt['snapshot']['material']): void {
    const manuscript = this.research.getArtifact(request.artifactId).kind === 'manuscript' ?
      this.research.manuscripts.inspectBundle(request) : null;
    for (const item of material) {
      if (manuscript !== null && !manuscript.claims.some(claim => claim.id === item.claim.id)) {
        throw new Error('research_consistency_claim_required');
      }
      const claim = this.research.evidence.getClaim(item.claim.id);
      if (JSON.stringify(claim) !== JSON.stringify(item.claim)) throw new Error('research_consistency_claim_changed');
      const source = this.research.evidence.inspectEvidence(item.evidence.id, request.projectId);
      if (source.referenceStatus !== 'recorded' || JSON.stringify(source.evidence) !== JSON.stringify(item.evidence)) {
        throw new Error('research_consistency_source_changed');
      }
      const metadata = this.research.evidence.sourceMetadata(request.projectId, item.evidence.id);
      if (metadata === null) throw new Error('research_consistency_metric_invalid');
      assertExperimentMetricEvidence(item.evidence, metadata, item.result);
      const stored = this.research.experimentResults.get({projectId: request.projectId,
        resultId: item.result.snapshot.id, expectedHash: item.result.snapshotHash});
      if (JSON.stringify(stored) !== JSON.stringify(item.result)) throw new Error('research_consistency_source_changed');
    }
  }
  private assertMaterial(receipt: ResearchConsistencyReceipt): void {
    const {request, material} = receipt.snapshot;
    if (material.length !== request.bindings.length) throw new Error('research_consistency_snapshot_invalid');
    request.bindings.forEach((binding, index) => {
      const item = material[index];
      if (item.claim.id !== binding.claimId || item.claim.projectId !== request.projectId || item.claim.artifactId !== request.artifactId ||
        relationClaimHash(item.claim) !== binding.expectedClaimHash || !item.claim.evidenceIds.includes(binding.evidenceId) ||
        item.evidence.id !== binding.evidenceId || item.result.snapshot.id !== binding.resultId ||
        item.result.snapshotHash !== binding.resultHash || item.result.snapshot.request.projectId !== request.projectId ||
        researchContentHash(JSON.stringify(item.result.snapshot)) !== item.result.snapshotHash ||
        (binding.surface === 'figure_caption' ? item.claim.subjectType !== 'figure' : item.claim.subjectType === 'figure')) {
        throw new Error('research_consistency_snapshot_invalid');
      }
      assertExperimentMetricEvidence(item.evidence, experimentMetricSource(item.result, binding.metricId).metadata, item.result);
      if (JSON.stringify(calculateConsistency(binding, item.claim.content, item.result)) !== JSON.stringify(item.calculation)) {
        throw new Error('research_consistency_snapshot_invalid');
      }
    });
  }
  private read(row: Row): ResearchConsistencyReceipt {
    const receipt = researchConsistencyReceiptSchema.parse({snapshot: JSON.parse(row.snapshot_json), snapshotHash: row.snapshot_hash});
    const {snapshot} = receipt;
    if (JSON.stringify(snapshot) !== row.snapshot_json || researchContentHash(row.snapshot_json) !== row.snapshot_hash ||
      snapshot.id !== row.id || snapshot.version !== row.version || snapshot.recordedAt !== row.created_at ||
      snapshot.request.projectId !== row.project_id || snapshot.request.artifactId !== row.artifact_id ||
      snapshot.request.requestId !== row.request_id) throw new Error('research_consistency_snapshot_invalid');
    this.assertMaterial(receipt);
    const parent = snapshot.request.parent;
    if (parent === null) {
      if (snapshot.version !== 1) throw new Error('research_consistency_snapshot_invalid');
    } else {
      const rowParent = this.db.prepare('SELECT * FROM research_consistency_reviews WHERE id=?').get(parent.reviewId) as Row | undefined;
      if (rowParent === undefined || rowParent.project_id !== row.project_id || rowParent.artifact_id !== row.artifact_id ||
        rowParent.version !== row.version - 1 || rowParent.snapshot_hash !== parent.reviewHash ||
        researchContentHash(rowParent.snapshot_json) !== parent.reviewHash) throw new Error('research_consistency_snapshot_invalid');
    }
    return receipt;
  }
}
