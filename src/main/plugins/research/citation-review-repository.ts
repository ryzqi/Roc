import {randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {
  researchCitationReviewSaveSchema, researchCitationReviewSnapshotSchema, researchCitationReviewHistorySchema,
  type ResearchCitationReviewSave, type ResearchCitationReviewReceipt,
  type ResearchCitationReviewHistory, type ResearchCitationReviewHistoryResult
} from '../../../shared/schemas/research-citation-reviews';
import {requireResearchHuman} from '../../services/research-human-context';
import {researchContentHash} from './research-files';
import {relationClaimHash, relationSourceDigest} from './evidence-relation-repository';
import {ResearchCitationCoverageService} from './citation-coverage-service';
import type {ResearchRepository} from './repository';

type Row = {
  id: string; project_id: string; artifact_id: string; claim_id: string; evidence_id: string;
  version: number; request_id: string; snapshot_json: string; snapshot_hash: string; created_at: string
};

/** A human declaration of directness preserves the exact source, independently of support approval. */
export class ResearchCitationReviewRepository {
  constructor(private readonly db: Database, private readonly research: ResearchRepository, private readonly now: () => string) {}

  save(input: ResearchCitationReviewSave): ResearchCitationReviewReceipt {
    const request = researchCitationReviewSaveSchema.parse(input);
    const actor = requireResearchHuman('research.citationReviews.save', request.projectId);
    return this.db.transaction(() => {
      this.requireScope(request);
      if (this.research.getProject(request.projectId).status === 'archived') throw new Error('research_project_archived');
      const requestHash = researchContentHash(JSON.stringify(request));
      const replay = this.db.prepare('SELECT * FROM research_citation_reviews WHERE project_id=? AND request_id=?')
        .get(request.projectId, request.requestId) as Row | undefined;
      if (replay !== undefined) {
        const receipt = this.inspect(replay);
        if (receipt.snapshot.requestHash !== requestHash || receipt.snapshot.actor.id !== actor.id) {
          throw new Error('research_citation_review_request_conflict');
        }
        const {claim, source} = receipt.snapshot.material;
        if (relationClaimHash(this.research.evidence.getClaim(claim.id)) !== receipt.snapshot.material.claimHash ||
          relationSourceDigest(this.research.evidence.inspectEvidence(source.evidence.id, request.projectId)) !==
          receipt.snapshot.material.sourceDigest) throw new Error('research_citation_review_source_changed');
        return receipt;
      }
      this.research.requireRelationReviewableArtifact(request.artifactId);
      const coverage = new ResearchCitationCoverageService(this.research).inspect({
        projectId: request.projectId, artifactId: request.artifactId, expectedHash: request.expectedReportHash
      });
      if (coverage.status !== 'current') throw new Error('research_citation_review_report_changed');
      const paragraph = coverage.report.paragraphs.find(item => item.claim.id === request.claimId);
      const source = coverage.report.sources.find(item => item.source.evidence.id === request.evidenceId)?.source;
      if (paragraph === undefined || source === undefined ||
        !paragraph.citations.some(item => item.evidenceId === request.evidenceId)) throw new Error('research_citation_review_citation_required');
      const latest = this.latest(request.claimId, request.evidenceId);
      if (latest === undefined ? request.parent !== null :
        request.parent?.reviewId !== latest.id || request.parent.reviewHash !== latest.snapshot_hash) {
        throw new Error('research_citation_review_version_conflict');
      }
      const snapshot = researchCitationReviewSnapshotSchema.parse({
        schemaVersion: 1, id: `citation_review_${randomUUID()}`, version: latest === undefined ? 1 : latest.version + 1,
        request, requestHash, actor, recordedAt: this.now(),
        material: {manuscriptHash: coverage.report.manuscript.contentHash, artifactVersion: coverage.report.artifactVersion,
          claim: paragraph.claim, claimHash: relationClaimHash(paragraph.claim), source, sourceDigest: relationSourceDigest(source)}
      });
      const json = JSON.stringify(snapshot), snapshotHash = researchContentHash(json);
      this.db.prepare(`INSERT INTO research_citation_reviews
        (id,project_id,artifact_id,claim_id,evidence_id,version,request_id,snapshot_json,snapshot_hash,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(snapshot.id, request.projectId, request.artifactId, request.claimId,
        request.evidenceId, snapshot.version, request.requestId, json, snapshotHash, snapshot.recordedAt);
      return {snapshot, snapshotHash};
    })();
  }

  history(input: ResearchCitationReviewHistory): ResearchCitationReviewHistoryResult {
    const request = researchCitationReviewHistorySchema.parse(input);
    this.requireScope(request);
    const rows = this.db.prepare(`SELECT * FROM research_citation_reviews
      WHERE claim_id=? AND evidence_id=? ORDER BY version DESC LIMIT ? OFFSET ?`)
      .all(request.claimId, request.evidenceId, request.limit, request.offset) as Row[];
    const total = this.db.prepare('SELECT count(*) FROM research_citation_reviews WHERE claim_id=? AND evidence_id=?')
      .pluck().get(request.claimId, request.evidenceId) as number;
    return {verification: 'stored_receipt', items: rows.map(row => this.inspect(row)), total};
  }

  forArtifact(projectId: string, artifactId: string): ResearchCitationReviewReceipt[] {
    this.research.getProject(projectId);
    if (this.research.getArtifact(artifactId).projectId !== projectId) throw new Error('research_citation_review_project_mismatch');
    const rows = this.db.prepare(`SELECT review.* FROM research_citation_reviews review WHERE review.artifact_id=?
      AND NOT EXISTS (SELECT 1 FROM research_citation_reviews newer WHERE newer.claim_id=review.claim_id
        AND newer.evidence_id=review.evidence_id AND newer.version>review.version)
      ORDER BY review.claim_id,review.evidence_id`).all(artifactId) as Row[];
    return rows.map(row => this.inspect(row));
  }

  assertReceiptCurrent(receipt: ResearchCitationReviewReceipt): void {
    const {request, material} = receipt.snapshot;
    this.requireScope(request);
    const bundle = this.research.manuscripts.inspectBundle(request);
    if (!bundle.claims.some(claim => claim.id === request.claimId) ||
      relationClaimHash(this.research.evidence.getClaim(request.claimId)) !== material.claimHash ||
      relationSourceDigest(this.research.evidence.inspectEvidence(request.evidenceId, request.projectId)) !== material.sourceDigest) {
      throw new Error('research_citation_review_source_changed');
    }
  }

  private requireScope(request: {projectId: string; artifactId: string; claimId: string; evidenceId: string}): void {
    this.research.getProject(request.projectId);
    const artifact = this.research.getArtifact(request.artifactId), claim = this.research.evidence.getClaim(request.claimId);
    if (artifact.projectId !== request.projectId || claim.projectId !== request.projectId ||
      claim.artifactId !== request.artifactId) throw new Error('research_citation_review_project_mismatch');
    if (artifact.kind !== 'manuscript') throw new Error('research_manuscript_artifact_required');
    this.research.evidence.inspectEvidence(request.evidenceId, request.projectId);
  }
  private latest(claimId: string, evidenceId: string): Row | undefined {
    return this.db.prepare('SELECT * FROM research_citation_reviews WHERE claim_id=? AND evidence_id=? ORDER BY version DESC LIMIT 1')
      .get(claimId, evidenceId) as Row | undefined;
  }
  private inspect(row: Row): ResearchCitationReviewReceipt {
    const snapshot = researchCitationReviewSnapshotSchema.parse(JSON.parse(row.snapshot_json));
    const {request, material} = snapshot;
    if (JSON.stringify(snapshot) !== row.snapshot_json || researchContentHash(row.snapshot_json) !== row.snapshot_hash ||
      snapshot.id !== row.id || snapshot.version !== row.version || snapshot.recordedAt !== row.created_at ||
      request.projectId !== row.project_id || request.artifactId !== row.artifact_id || request.claimId !== row.claim_id ||
      request.evidenceId !== row.evidence_id || request.requestId !== row.request_id ||
      snapshot.requestHash !== researchContentHash(JSON.stringify(request)) ||
      material.claim.id !== request.claimId || material.claim.artifactId !== request.artifactId ||
      material.claim.projectId !== request.projectId || !material.claim.evidenceIds.includes(request.evidenceId) ||
      material.source.evidence.id !== request.evidenceId || material.source.evidence.projectId !== request.projectId ||
      material.source.referenceStatus !== 'recorded' || relationClaimHash(material.claim) !== material.claimHash ||
      relationSourceDigest(material.source) !== material.sourceDigest) throw new Error('research_citation_review_snapshot_invalid');
    if (request.parent === null) {
      if (snapshot.version !== 1) throw new Error('research_citation_review_snapshot_invalid');
    } else {
      const parent = this.db.prepare('SELECT * FROM research_citation_reviews WHERE id=?').get(request.parent.reviewId) as Row | undefined;
      if (parent === undefined || parent.snapshot_hash !== request.parent.reviewHash ||
        parent.version !== row.version - 1 || parent.project_id !== row.project_id || parent.artifact_id !== row.artifact_id ||
        parent.claim_id !== row.claim_id || parent.evidence_id !== row.evidence_id ||
        researchContentHash(parent.snapshot_json) !== parent.snapshot_hash) throw new Error('research_citation_review_snapshot_invalid');
    }
    return {snapshot, snapshotHash: row.snapshot_hash};
  }
}
