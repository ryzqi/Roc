import {randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {
  researchResponseMatrixSaveSchema, researchResponseMatrixReceiptSchema, researchResponseMatrixInspectSchema,
  researchResponseMatrixInspectionSchema, researchResponseMatrixHistorySchema,
  type ResearchResponseMatrixSave, type ResearchResponseMatrixReceipt, type ResearchResponseMatrixMaterial,
  type ResearchResponseMatrixInspect, type ResearchResponseMatrixInspection, type ResearchResponseMatrixHistory
} from '../../../shared/schemas/research-response-matrix';
import {requireResearchHuman} from '../../services/research-human-context';
import {researchContentHash} from './research-files';
import {relationClaimHash} from './evidence-relation-repository';
import {manuscriptClaimsHash} from './manuscript-repository';
import type {ResearchRepository} from './repository';

type Row = {id: string; project_id: string; artifact_id: string; version: number; request_id: string;
  snapshot_json: string; snapshot_hash: string; created_at: string};

export class ResearchResponseMatrixRepository {
  constructor(private readonly db: Database, private readonly research: ResearchRepository, private readonly now: () => string) {}

  private scope(projectId: string, artifactId: string): void {
    this.research.getProject(projectId);
    const artifact = this.research.getArtifact(artifactId);
    if (artifact.projectId !== projectId) throw new Error('research_response_project_mismatch');
    if (artifact.kind !== 'manuscript') throw new Error('research_manuscript_artifact_required');
  }

  private canReviewApproved(projectId: string, artifactId: string): boolean {
    const project = this.research.getProject(projectId);
    return project.status !== 'archived' && project.currentStage === 'review' &&
      this.research.getArtifact(artifactId).status === 'approved' &&
      this.research.reviews.get(projectId)?.manuscriptArtifactId === artifactId &&
      this.research.getWorkflow(projectId).stages.find(stage => stage.stage === 'review')?.status === 'waiting_approval';
  }

  private canEdit(projectId: string, artifactId: string): boolean {
    if (this.canReviewApproved(projectId, artifactId)) return true;
    const project = this.research.getProject(projectId), artifact = this.research.getArtifact(artifactId);
    const stage = this.research.getWorkflow(projectId).stages.find(stage => stage.stage === artifact.stage);
    return project.status !== 'archived' && artifact.status === 'draft' && project.currentStage === artifact.stage &&
      stage !== undefined && ['ready', 'running', 'paused', 'blocked', 'failed', 'waiting_approval'].includes(stage.status) &&
      stage.artifactIds.includes(artifactId);
  }

  latest(projectId: string, artifactId: string): ResearchResponseMatrixReceipt | null {
    this.scope(projectId, artifactId);
    const row = this.db.prepare('SELECT * FROM research_response_matrices WHERE artifact_id=? ORDER BY version DESC LIMIT 1')
      .get(artifactId) as Row | undefined;
    return row === undefined ? null : this.read(row);
  }

  inspect(input: ResearchResponseMatrixInspect): ResearchResponseMatrixInspection {
    const request = researchResponseMatrixInspectSchema.parse(input);
    return this.db.transaction(() => {
      this.scope(request.projectId, request.artifactId);
      const review = this.latest(request.projectId, request.artifactId);
      const material = this.captureMaterial(request, review?.snapshot.request.rows ?? []);
      const rows = review?.snapshot.request.rows ?? [];
      const scientificReviews = this.research.scientificReviews.reportsForManuscript(request.projectId, request.artifactId);
      const reviewCurrent = review !== null && JSON.stringify(material) === JSON.stringify(review.snapshot.material) &&
        this.research.scientificReviews.findingRowsIssue(request.projectId, request.artifactId, rows, scientificReviews) === null;
      const report = {
        schemaVersion: 1 as const, projectId: request.projectId, artifactId: request.artifactId,
        artifactVersion: this.research.inspectArtifact({
          projectId: request.projectId, artifactId: request.artifactId, expectedVersion: null
        }).snapshot.version,
        material, review, reviewCurrent, scientificReviews, canEdit: this.canEdit(request.projectId, request.artifactId),
        openCommentIds: rows.filter(row => row.status === 'open').map(row => row.commentId),
        addressedCommentIds: rows.filter(row => row.status === 'addressed').map(row => row.commentId),
        declinedCommentIds: rows.filter(row => row.status === 'declined').map(row => row.commentId)
      };
      const reportHash = researchContentHash(JSON.stringify(report));
      return researchResponseMatrixInspectionSchema.parse({
        status: request.expectedHash === null || request.expectedHash === reportHash ? 'current' : 'stale', reportHash, report
      });
    })();
  }

  save(input: ResearchResponseMatrixSave): ResearchResponseMatrixReceipt {
    const request = researchResponseMatrixSaveSchema.parse(input);
    const actor = requireResearchHuman('research.responseMatrix.save', request.projectId);
    return this.db.transaction(() => {
      this.scope(request.projectId, request.artifactId);
      if (this.research.getProject(request.projectId).status === 'archived') throw new Error('research_project_archived');
      const replay = this.db.prepare('SELECT * FROM research_response_matrices WHERE project_id=? AND request_id=?')
        .get(request.projectId, request.requestId) as Row | undefined;
      if (replay !== undefined) {
        const receipt = this.read(replay);
        if (JSON.stringify(receipt.snapshot.request) !== JSON.stringify(request) || receipt.snapshot.actor.id !== actor.id) {
          throw new Error('research_response_request_conflict');
        }
        this.assertReceiptCurrent(receipt);
        return receipt;
      }
      if (!this.canReviewApproved(request.projectId, request.artifactId)) this.research.requireRelationReviewableArtifact(request.artifactId);
      const latest = this.latest(request.projectId, request.artifactId);
      if (latest === null ? request.parent !== null :
        request.parent?.reviewId !== latest.snapshot.id || request.parent.reviewHash !== latest.snapshotHash) {
        throw new Error('research_response_version_conflict');
      }
      if (this.research.inspectArtifact({projectId: request.projectId, artifactId: request.artifactId,
        expectedVersion: request.expectedArtifactVersion}).status !== 'current') throw new Error('research_response_artifact_changed');
      // Retiring an unhandled comment requires an explicit human disposition in a new revision.
      if (latest !== null && latest.snapshot.request.rows.some(row => !request.rows.some(next => next.commentId === row.commentId))) {
        throw new Error('research_response_comment_removed');
      }
      if (latest !== null && latest.snapshot.request.rows.some(row => {
        const next = request.rows.find(next => next.commentId === row.commentId);
        return next?.comment !== row.comment || next.reviewer !== row.reviewer ||
          next.finding?.artifactId !== row.finding?.artifactId || next.finding?.reportHash !== row.finding?.reportHash ||
          next.finding?.findingId !== row.finding?.findingId;
      })) throw new Error('research_response_comment_changed');
      const material = this.captureMaterial(request, request.rows);
      const snapshot = researchResponseMatrixReceiptSchema.shape.snapshot.parse({
        schemaVersion: 1, id: `response_matrix_${randomUUID()}`, version: latest === null ? 1 : latest.snapshot.version + 1,
        request, actor, recordedAt: this.now(), material
      });
      this.assertMaterial(snapshot);
      const issue = this.research.scientificReviews.findingRowsIssue(request.projectId, request.artifactId, request.rows);
      if (issue !== null) throw new Error(issue);
      const json = JSON.stringify(snapshot), snapshotHash = researchContentHash(json);
      this.db.prepare(`INSERT INTO research_response_matrices
        (id,project_id,artifact_id,version,request_id,snapshot_json,snapshot_hash,created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(snapshot.id, request.projectId, request.artifactId, snapshot.version, request.requestId, json, snapshotHash, snapshot.recordedAt);
      return {snapshot, snapshotHash};
    })();
  }

  assertReceiptCurrent(receipt: ResearchResponseMatrixReceipt): void {
    const {request, material} = receipt.snapshot;
    this.scope(request.projectId, request.artifactId);
    if (JSON.stringify(this.captureMaterial(request, request.rows)) !== JSON.stringify(material)) {
      throw new Error('research_response_source_changed');
    }
    const issue = this.research.scientificReviews.findingRowsIssue(request.projectId, request.artifactId, request.rows);
    if (issue !== null) throw new Error(issue);
  }

  history(input: ResearchResponseMatrixHistory) {
    const request = researchResponseMatrixHistorySchema.parse(input);
    this.scope(request.projectId, request.artifactId);
    const rows = this.db.prepare('SELECT * FROM research_response_matrices WHERE artifact_id=? ORDER BY version DESC LIMIT ? OFFSET ?')
      .all(request.artifactId, request.limit, request.offset) as Row[];
    const total = this.db.prepare('SELECT count(*) FROM research_response_matrices WHERE artifact_id=?')
      .pluck().get(request.artifactId) as number;
    return {verification: 'stored_receipt' as const, items: rows.map(row => this.read(row)), total};
  }

  private captureMaterial(scope: {projectId: string; artifactId: string}, rows: ResearchResponseMatrixSave['rows']): ResearchResponseMatrixMaterial {
    const {manuscript, claims} = this.research.manuscripts.inspectBundle(scope);
    const evidence = [...new Set(rows.flatMap(row => row.evidenceIds))]
      .map(evidenceId => this.research.evidence.inspectEvidence(evidenceId, scope.projectId));
    return {manuscript, claims, evidence};
  }

  private assertMaterial(snapshot: ResearchResponseMatrixReceipt['snapshot']): void {
    const {request, material} = snapshot;
    const {manuscript, claims, evidence} = material;
    if (manuscript.projectId !== request.projectId || manuscript.artifactId !== request.artifactId ||
      researchContentHash(manuscript.latex) !== manuscript.contentHash ||
      manuscriptClaimsHash(claims) !== manuscript.claimsHash ||
      JSON.stringify(manuscript.sections.flatMap(section => section.claimIds)) !== JSON.stringify(claims.map(claim => claim.id)) ||
      claims.some(claim => claim.projectId !== request.projectId || claim.artifactId !== request.artifactId) ||
      JSON.stringify([...new Set(request.rows.flatMap(row => row.evidenceIds))]) !== JSON.stringify(evidence.map(source => source.evidence.id))) {
      throw new Error('research_response_snapshot_invalid');
    }
    for (const row of request.rows) {
      for (const location of row.locations) {
        const claim = claims.find(claim => claim.id === location.claimId);
        if (claim === undefined || relationClaimHash(claim) !== location.claimHash ||
          claim.content.slice(location.start, location.end) !== location.text || location.end > claim.content.length) {
          throw new Error('research_response_location_invalid');
        }
      }
      for (const evidenceId of row.evidenceIds) {
        const source = evidence.find(source => source.evidence.id === evidenceId);
        if (source === undefined || source.evidence.projectId !== request.projectId || source.referenceStatus !== 'recorded') {
          throw new Error('research_response_source_changed');
        }
      }
    }
  }

  private read(row: Row): ResearchResponseMatrixReceipt {
    const receipt = researchResponseMatrixReceiptSchema.parse({snapshot: JSON.parse(row.snapshot_json), snapshotHash: row.snapshot_hash});
    const {snapshot} = receipt;
    if (JSON.stringify(snapshot) !== row.snapshot_json || researchContentHash(row.snapshot_json) !== row.snapshot_hash ||
      snapshot.id !== row.id || snapshot.version !== row.version || snapshot.recordedAt !== row.created_at ||
      snapshot.request.projectId !== row.project_id || snapshot.request.artifactId !== row.artifact_id ||
      snapshot.request.requestId !== row.request_id) throw new Error('research_response_snapshot_invalid');
    this.assertMaterial(snapshot);
    const parent = snapshot.request.parent;
    if (parent === null) {
      if (snapshot.version !== 1) throw new Error('research_response_snapshot_invalid');
    } else {
      const previous = this.db.prepare('SELECT * FROM research_response_matrices WHERE id=?').get(parent.reviewId) as Row | undefined;
      if (previous === undefined || previous.project_id !== row.project_id || previous.artifact_id !== row.artifact_id ||
        previous.version !== row.version - 1 || previous.snapshot_hash !== parent.reviewHash ||
        researchContentHash(previous.snapshot_json) !== parent.reviewHash) throw new Error('research_response_snapshot_invalid');
    }
    return receipt;
  }
}
