import {randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {
  researchJournalSaveSchema, researchJournalReceiptSchema, researchJournalHistorySchema, researchJournalMaterialSchema,
  type ResearchJournalSave, type ResearchJournalReceipt, type ResearchJournalSelection, type ResearchJournalMaterial,
  type ResearchJournalHistory
} from '../../../shared/schemas/research-journal-compliance';
import {requireResearchHuman} from '../../services/research-human-context';
import {ResearchCitationCoverageService} from './citation-coverage-service';
import {researchContentHash} from './research-files';
import {manuscriptClaimsHash} from './manuscript-repository';
import {checkJournalCompliance} from './journal-compliance-checks';
import type {ResearchRepository} from './repository';

type Row = {id: string; project_id: string; artifact_id: string; version: number; request_id: string;
  snapshot_json: string; snapshot_hash: string; created_at: string};

export class ResearchJournalComplianceRepository {
  constructor(private readonly db: Database, private readonly research: ResearchRepository, private readonly now: () => string) {}

  scope(projectId: string, artifactId: string): void {
    this.research.getProject(projectId);
    const artifact = this.research.getArtifact(artifactId);
    if (artifact.projectId !== projectId) throw new Error('research_journal_project_mismatch');
    if (artifact.kind !== 'manuscript') throw new Error('research_manuscript_artifact_required');
  }

  latest(projectId: string, artifactId: string): ResearchJournalReceipt | null {
    this.scope(projectId, artifactId);
    const row = this.db.prepare('SELECT * FROM research_journal_compliance WHERE artifact_id=? ORDER BY version DESC LIMIT 1')
      .get(artifactId) as Row | undefined;
    return row === undefined ? null : this.read(row);
  }

  captureFacts(projectId: string, artifactId: string, selection: ResearchJournalSelection) {
    this.scope(projectId, artifactId);
    const coverage = new ResearchCitationCoverageService(this.research).inspect({projectId, artifactId, expectedHash: null}).report;
    const {claims} = this.research.manuscripts.inspectBundle({projectId, artifactId});
    const figures = selection.figureIds.map(figureId => {
      const figure = this.research.figures.get(projectId, figureId);
      if (figure.status === 'superseded') throw new Error('research_journal_source_changed');
      const {id, artifactId, runId, manifestHash, validation} = figure;
      return {id, projectId, artifactId, runId, manifestHash, validation};
    });
    return {manuscript: coverage.manuscript, claims, sources: coverage.sources, figures};
  }

  save(input: ResearchJournalSave, inputMaterial: ResearchJournalMaterial): ResearchJournalReceipt {
    const request = researchJournalSaveSchema.parse(input), material = researchJournalMaterialSchema.parse(inputMaterial);
    const actor = requireResearchHuman('research.journalCompliance.save', request.projectId);
    return this.db.transaction(() => {
      this.scope(request.projectId, request.artifactId);
      if (this.research.getProject(request.projectId).status === 'archived') throw new Error('research_project_archived');
      const replay = this.db.prepare('SELECT * FROM research_journal_compliance WHERE project_id=? AND request_id=?')
        .get(request.projectId, request.requestId) as Row | undefined;
      if (replay !== undefined) {
        const receipt = this.read(replay);
        if (JSON.stringify(receipt.snapshot.request) !== JSON.stringify(request) || receipt.snapshot.actor.id !== actor.id) {
          throw new Error('research_journal_request_conflict');
        }
        this.assertReceiptFactsCurrent(receipt);
        if (JSON.stringify(material) !== JSON.stringify(receipt.snapshot.material)) throw new Error('research_journal_source_changed');
        return receipt;
      }
      this.research.requireRelationReviewableArtifact(request.artifactId);
      const latest = this.latest(request.projectId, request.artifactId);
      if (latest === null ? request.parent !== null :
        request.parent?.reviewId !== latest.snapshot.id || request.parent.reviewHash !== latest.snapshotHash) {
        throw new Error('research_journal_version_conflict');
      }
      if (this.research.inspectArtifact({projectId: request.projectId, artifactId: request.artifactId,
        expectedVersion: request.expectedArtifactVersion}).status !== 'current') throw new Error('research_journal_artifact_changed');
      const {supplements, ...facts} = material;
      if (JSON.stringify(facts) !== JSON.stringify(this.captureFacts(request.projectId, request.artifactId, request.selection)) ||
        researchContentHash(JSON.stringify(material)) !== request.expectedMaterialHash) throw new Error('research_journal_source_changed');
      const snapshot = researchJournalReceiptSchema.shape.snapshot.parse({
        schemaVersion: 1, id: `journal_compliance_${randomUUID()}`, version: latest === null ? 1 : latest.snapshot.version + 1,
        request, actor, recordedAt: this.now(), material: {...facts, supplements},
        checks: checkJournalCompliance(request.selection, material)
      });
      this.assertMaterial(snapshot);
      const json = JSON.stringify(snapshot), snapshotHash = researchContentHash(json);
      this.db.prepare(`INSERT INTO research_journal_compliance
        (id,project_id,artifact_id,version,request_id,snapshot_json,snapshot_hash,created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(snapshot.id, request.projectId, request.artifactId, snapshot.version, request.requestId, json, snapshotHash, snapshot.recordedAt);
      return {snapshot, snapshotHash};
    })();
  }

  assertReceiptFactsCurrent(receipt: ResearchJournalReceipt): void {
    const {request, material} = receipt.snapshot;
    const {supplements: _supplements, ...facts} = material;
    if (JSON.stringify(this.captureFacts(request.projectId, request.artifactId, request.selection)) !== JSON.stringify(facts)) {
      throw new Error('research_journal_source_changed');
    }
  }

  history(input: ResearchJournalHistory) {
    const request = researchJournalHistorySchema.parse(input);
    this.scope(request.projectId, request.artifactId);
    const rows = this.db.prepare('SELECT * FROM research_journal_compliance WHERE artifact_id=? ORDER BY version DESC LIMIT ? OFFSET ?')
      .all(request.artifactId, request.limit, request.offset) as Row[];
    const total = this.db.prepare('SELECT count(*) FROM research_journal_compliance WHERE artifact_id=?')
      .pluck().get(request.artifactId) as number;
    return {verification: 'stored_receipt' as const, items: rows.map(row => this.read(row)), total};
  }

  private assertMaterial(snapshot: ResearchJournalReceipt['snapshot']): void {
    const {request, material} = snapshot, {manuscript, claims} = material;
    if (manuscript.projectId !== request.projectId || manuscript.artifactId !== request.artifactId ||
      researchContentHash(manuscript.latex) !== manuscript.contentHash ||
      manuscriptClaimsHash(claims) !== manuscript.claimsHash ||
      JSON.stringify(manuscript.sections.flatMap(section => section.claimIds)) !== JSON.stringify(claims.map(claim => claim.id)) ||
      claims.some(claim => claim.projectId !== request.projectId || claim.artifactId !== request.artifactId) ||
      material.sources.some(source => source.source.evidence.projectId !== request.projectId || source.source.referenceStatus !== 'recorded') ||
      JSON.stringify([...new Set(claims.flatMap(claim => claim.evidenceIds))]) !== JSON.stringify(material.sources.map(source => source.source.evidence.id)) ||
      material.figures.some(figure => figure.projectId !== request.projectId) ||
      JSON.stringify(request.selection.figureIds) !== JSON.stringify(material.figures.map(figure => figure.id)) ||
      JSON.stringify(request.selection.supplementPaths) !== JSON.stringify(material.supplements.map(file => file.path)) ||
      researchContentHash(JSON.stringify(material)) !== request.expectedMaterialHash ||
      JSON.stringify(snapshot.checks) !== JSON.stringify(checkJournalCompliance(request.selection, material))) {
      throw new Error('research_journal_snapshot_invalid');
    }
  }

  private read(row: Row): ResearchJournalReceipt {
    const receipt = researchJournalReceiptSchema.parse({snapshot: JSON.parse(row.snapshot_json), snapshotHash: row.snapshot_hash});
    const {snapshot} = receipt;
    if (JSON.stringify(snapshot) !== row.snapshot_json || researchContentHash(row.snapshot_json) !== row.snapshot_hash ||
      snapshot.id !== row.id || snapshot.version !== row.version || snapshot.recordedAt !== row.created_at ||
      snapshot.request.projectId !== row.project_id || snapshot.request.artifactId !== row.artifact_id ||
      snapshot.request.requestId !== row.request_id) throw new Error('research_journal_snapshot_invalid');
    this.assertMaterial(snapshot);
    const parent = snapshot.request.parent;
    if (parent === null) {
      if (snapshot.version !== 1) throw new Error('research_journal_snapshot_invalid');
    } else {
      const previous = this.db.prepare('SELECT * FROM research_journal_compliance WHERE id=?').get(parent.reviewId) as Row | undefined;
      if (previous === undefined || previous.project_id !== row.project_id || previous.artifact_id !== row.artifact_id ||
        previous.version !== row.version - 1 || previous.snapshot_hash !== parent.reviewHash ||
        researchContentHash(previous.snapshot_json) !== parent.reviewHash) throw new Error('research_journal_snapshot_invalid');
    }
    return receipt;
  }
}
