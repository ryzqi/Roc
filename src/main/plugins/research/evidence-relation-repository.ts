import {createHash, randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import type {ResearchArtifact, ResearchClaim} from '../../../shared/types';
import {researchInspectedEvidenceSchema, type ResearchInspectedEvidence} from '../../../shared/schemas/research-evidence-source';
import {researchClaimSchema} from '../../../shared/schemas/research-evidence';
import {
  researchEvidenceRelationProposalSchema, researchEvidenceRelationReviewSchema,
  researchEvidenceRelationSchema, researchEvidenceRelationRevisionSchema,
  researchEvidenceRelationListSchema, researchRelationActorSchema, researchRelationReviewerSchema,
  type ResearchEvidenceRelation, type ResearchEvidenceRelationProposal, type ResearchEvidenceRelationReview,
  type ResearchRelationActor, type ResearchRelationReviewer, type ResearchEvidenceRelationRevision
} from '../../../shared/schemas/research-evidence-relations';

type EvidenceAccess = {
  getClaim(id: string): ResearchClaim;
  inspectEvidence(id: string, projectId: string): ResearchInspectedEvidence;
};
type ArtifactAccess = {
  get(id: string): ResearchArtifact;
  requireEditable(id: string): ResearchArtifact;
  requireReviewable(id: string): ResearchArtifact;
};

export const relationSourceDigest = (source: ResearchInspectedEvidence): string => hash(JSON.stringify(researchInspectedEvidenceSchema.parse(source)));
export const relationClaimHash = (claim: ResearchClaim): string => hash(JSON.stringify(researchClaimSchema.parse(claim)));

/** Scientific relations are proposed facts until an explicit human decision binds the captured versions. */
export class ResearchEvidenceRelationRepository {
  constructor(
    private readonly db: Database,
    private readonly evidence: EvidenceAccess,
    private readonly artifacts: ArtifactAccess,
    private readonly now: () => string
  ) {}

  propose(input: ResearchEvidenceRelationProposal, proposedBy: ResearchRelationActor): ResearchEvidenceRelation {
    const request = researchEvidenceRelationProposalSchema.parse(input);
    const proposer = researchRelationActorSchema.parse(proposedBy);
    return this.db.transaction(() => {
      const claim = this.evidence.getClaim(request.claimId);
      if (claim.projectId !== request.projectId) throw new Error('research_relation_project_mismatch');
      const artifact = proposer.kind === 'agent' ? this.artifacts.requireEditable(claim.artifactId) :
        this.artifacts.requireReviewable(claim.artifactId);
      if (artifact.projectId !== request.projectId) throw new Error('research_relation_project_mismatch');
      if (proposer.kind === 'agent' && this.db.prepare('SELECT id FROM research_stage_runs WHERE id=? AND project_id=?')
        .get(proposer.id, request.projectId) === undefined) throw new Error('research_relation_proposer_invalid');
      if (claim.version !== request.expectedClaimVersion) throw new Error('research_relation_claim_changed');
      const source = this.evidence.inspectEvidence(request.evidenceId, request.projectId);
      if (source.referenceStatus !== 'recorded') throw new Error('research_relation_source_invalidated');
      const sourceDigest = relationSourceDigest(source);
      if (sourceDigest !== request.expectedSourceDigest) throw new Error('research_relation_source_changed');
      if (request.supersedesRelationId !== null) {
        const previous = this.get(request.supersedesRelationId, request.projectId);
        if (previous.claimId !== claim.id || previous.claimVersion !== claim.version ||
            !['confirmed', 'historical'].includes(previous.status)) throw new Error('research_relation_supersedes_invalid');
      }
      const timestamp = this.now();
      const relation = researchEvidenceRelationSchema.parse({
        id: `relation_${randomUUID()}`, projectId: request.projectId, artifactId: artifact.id, claimId: claim.id,
        claimVersion: claim.version, claimHash: relationClaimHash(claim), evidenceId: request.evidenceId,
        source, sourceDigest, kind: request.kind, condition: request.condition,
        supersedesRelationId: request.supersedesRelationId, proposer, status: 'proposed', version: 1,
        reviewer: null, reviewedAt: null, decisionNote: null, invalidatedReason: null,
        createdAt: timestamp, updatedAt: timestamp
      });
      this.write(relation);
      this.record(relation, proposer, 'proposed');
      return relation;
    })();
  }

  review(input: ResearchEvidenceRelationReview, reviewedBy: ResearchRelationReviewer): ResearchEvidenceRelation {
    const request = researchEvidenceRelationReviewSchema.parse(input);
    const reviewer = researchRelationReviewerSchema.parse(reviewedBy);
    return this.db.transaction(() => {
      const current = this.get(request.relationId, request.projectId);
      if (current.version !== request.expectedVersion) throw new Error('research_relation_version_conflict');
      if (current.status !== 'proposed') throw new Error('research_relation_not_proposed');
      this.artifacts.requireReviewable(current.artifactId);
      this.requireCurrent(current, request.expectedClaimVersion, request.expectedSourceDigest);
      const timestamp = this.now();
      if (request.decision === 'confirm' && current.supersedesRelationId !== null) {
        const previous = this.get(current.supersedesRelationId, current.projectId);
        if (previous.claimId !== current.claimId || previous.claimVersion !== current.claimVersion ||
            !['confirmed', 'historical'].includes(previous.status)) throw new Error('research_relation_supersedes_invalid');
        this.invalidate(previous, 'superseded', reviewer, timestamp);
      }
      const relation = researchEvidenceRelationSchema.parse({...current, version: current.version + 1,
        status: request.decision === 'confirm' ? 'confirmed' : 'rejected', reviewer,
        reviewedAt: timestamp, decisionNote: request.note, updatedAt: timestamp});
      this.write(relation);
      this.record(relation, reviewer, relation.status === 'confirmed' ? 'confirmed' : 'rejected');
      return relation;
    })();
  }

  get(id: string, projectId: string): ResearchEvidenceRelation {
    const row = this.db.prepare('SELECT project_id,snapshot_json FROM research_evidence_relations WHERE id=?')
      .get(id) as {project_id: string; snapshot_json: string} | undefined;
    if (row === undefined) throw new Error('research_relation_not_found');
    if (row.project_id !== projectId) throw new Error('research_relation_project_mismatch');
    const relation = parseRelation(row.snapshot_json);
    if (relation.id !== id || relation.projectId !== projectId) throw new Error('research_relation_snapshot_invalid');
    return relation;
  }

  list(input: {projectId: string; claimId: string | null}): ResearchEvidenceRelation[] {
    const request = researchEvidenceRelationListSchema.parse(input);
    if (this.db.prepare('SELECT id FROM research_projects WHERE id=?').get(request.projectId) === undefined) {
      throw new Error('research_project_not_found');
    }
    if (request.claimId !== null && this.evidence.getClaim(request.claimId).projectId !== request.projectId) {
      throw new Error('research_relation_project_mismatch');
    }
    const rows = request.claimId === null ?
      this.db.prepare('SELECT snapshot_json FROM research_evidence_relations WHERE project_id=? ORDER BY rowid')
        .all(request.projectId) :
      this.db.prepare('SELECT snapshot_json FROM research_evidence_relations WHERE project_id=? AND claim_id=? ORDER BY rowid')
        .all(request.projectId, request.claimId);
    return rows.map(row => {
      const relation = parseRelation((row as {snapshot_json: string}).snapshot_json);
      if (relation.projectId !== request.projectId || (request.claimId !== null && relation.claimId !== request.claimId)) {
        throw new Error('research_relation_snapshot_invalid');
      }
      return relation;
    });
  }

  forArtifact(artifactId: string, projectId: string): ResearchEvidenceRelation[] {
    if (this.artifacts.get(artifactId).projectId !== projectId) throw new Error('research_relation_project_mismatch');
    return this.db.prepare(`SELECT r.snapshot_json FROM research_evidence_relations r
      JOIN research_claims c ON c.id=r.claim_id WHERE r.project_id=? AND c.artifact_id=? ORDER BY r.rowid`)
      .all(projectId, artifactId).map(row => {
        const relation = parseRelation((row as {snapshot_json: string}).snapshot_json);
        if (relation.projectId !== projectId || relation.artifactId !== artifactId) throw new Error('research_relation_snapshot_invalid');
        return relation;
      });
  }

  history(id: string, projectId: string): ResearchEvidenceRelationRevision[] {
    this.get(id, projectId);
    return this.db.prepare('SELECT snapshot_json FROM research_evidence_relation_revisions WHERE relation_id=? ORDER BY version')
      .all(id).map(row => {
        const revision = researchEvidenceRelationRevisionSchema.parse(JSON.parse((row as {snapshot_json: string}).snapshot_json));
        validateRelationSource(revision.relation);
        if (revision.relation.id !== id || revision.relation.projectId !== projectId) throw new Error('research_relation_snapshot_invalid');
        return revision;
      });
  }

  /** Called in the claim/source writer's transaction, never as a side effect of reading. */
  invalidateClaim(claimId: string): void {
    this.invalidateRows('claim_id', claimId, 'claim_changed');
  }
  invalidateEvidence(evidenceId: string): void {
    this.invalidateRows('evidence_id', evidenceId, 'evidence_invalidated');
  }

  assertCurrent(relation: ResearchEvidenceRelation): void {
    this.requireCurrent(relation, relation.claimVersion, relation.sourceDigest);
    if (relation.status === 'invalidated') throw new Error('research_relation_invalidated');
  }

  private requireCurrent(relation: ResearchEvidenceRelation, expectedClaimVersion: number, expectedSourceDigest: string): void {
    const claim = this.evidence.getClaim(relation.claimId);
    if (claim.projectId !== relation.projectId || claim.artifactId !== relation.artifactId) {
      throw new Error('research_relation_project_mismatch');
    }
    if (this.artifacts.get(relation.artifactId).projectId !== relation.projectId) throw new Error('research_relation_project_mismatch');
    if (claim.version !== relation.claimVersion || claim.version !== expectedClaimVersion ||
        relationClaimHash(claim) !== relation.claimHash) throw new Error('research_relation_claim_changed');
    const source = this.evidence.inspectEvidence(relation.evidenceId, relation.projectId);
    if (source.referenceStatus !== 'recorded') throw new Error('research_relation_source_invalidated');
    if (relationSourceDigest(source) !== relation.sourceDigest || expectedSourceDigest !== relation.sourceDigest) {
      throw new Error('research_relation_source_changed');
    }
  }

  private invalidateRows(column: 'claim_id' | 'evidence_id', id: string,
    reason: 'claim_changed' | 'evidence_invalidated'): void {
    if (!this.db.inTransaction) throw new Error('research_relation_transaction_required');
    const rows = this.db.prepare(`SELECT snapshot_json FROM research_evidence_relations
      WHERE ${column}=? AND status IN ('proposed','confirmed','historical')`).all(id);
    const timestamp = this.now();
    for (const row of rows) this.invalidate(parseRelation((row as {snapshot_json: string}).snapshot_json),
      reason, {kind: 'system', id: reason}, timestamp);
  }

  private invalidate(relation: ResearchEvidenceRelation, reason: NonNullable<ResearchEvidenceRelation['invalidatedReason']>,
    actor: ResearchEvidenceRelationRevision['actor'], timestamp: string): void {
    const invalidated = researchEvidenceRelationSchema.parse({...relation, status: 'invalidated',
      invalidatedReason: reason, version: relation.version + 1, updatedAt: timestamp});
    this.write(invalidated);
    this.record(invalidated, actor, 'invalidated');
  }

  private write(relation: ResearchEvidenceRelation): void {
    this.db.prepare(`INSERT INTO research_evidence_relations
      (id,project_id,claim_id,evidence_id,claim_version,kind,status,version,snapshot_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      status=excluded.status,version=excluded.version,snapshot_json=excluded.snapshot_json,updated_at=excluded.updated_at`)
      .run(relation.id, relation.projectId, relation.claimId, relation.evidenceId, relation.claimVersion,
        relation.kind, relation.status, relation.version, JSON.stringify(relation), relation.createdAt, relation.updatedAt);
  }

  private record(relation: ResearchEvidenceRelation, actor: ResearchEvidenceRelationRevision['actor'],
    event: ResearchEvidenceRelationRevision['event']): void {
    const revision = researchEvidenceRelationRevisionSchema.parse({relation, actor, event, recordedAt: this.now()});
    this.db.prepare('INSERT INTO research_evidence_relation_revisions (relation_id,version,snapshot_json) VALUES (?,?,?)')
      .run(relation.id, relation.version, JSON.stringify(revision));
  }
}

function parseRelation(json: string): ResearchEvidenceRelation {
  const relation = researchEvidenceRelationSchema.parse(JSON.parse(json));
  validateRelationSource(relation);
  return relation;
}
function validateRelationSource(relation: ResearchEvidenceRelation): void {
  if (relation.evidenceId !== relation.source.evidence.id || relation.projectId !== relation.source.evidence.projectId ||
      relation.sourceDigest !== relationSourceDigest(relation.source)) throw new Error('research_relation_snapshot_invalid');
}
function hash(value: string): string {return createHash('sha256').update(value).digest('hex');}
