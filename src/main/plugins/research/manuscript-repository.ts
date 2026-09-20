import { createHash, randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';

import { researchManuscriptSaveRequestSchema, researchManuscriptSchema } from '../../../shared/schemas/research-evidence';
import type {
  ResearchArtifact,
  ResearchClaim,
  ResearchEvidence,
  ResearchExportBundle,
  ResearchExportBundleRequest,
  ResearchManuscript,
  ResearchManuscriptSaveRequest
} from '../../../shared/types';
import { renderManuscriptLatex } from './latex-source';

type ArtifactAccess = {
  get(id: string): ResearchArtifact;
  requireEditable(id: string): ResearchArtifact;
};

type ManuscriptEvidence = {
  getClaim(id: string): ResearchClaim;
  assertSupported(claim: ResearchClaim): void;
  evidenceForClaims(claims: ResearchClaim[], projectId: string): ResearchEvidence[];
};

export class ResearchManuscriptRepository {
  constructor(
    private readonly db: Database,
    private readonly artifacts: ArtifactAccess,
    private readonly evidence: ManuscriptEvidence,
    private readonly now: () => string
  ) {}

  saveManuscript(input: ResearchManuscriptSaveRequest): ResearchManuscript {
    const request = researchManuscriptSaveRequestSchema.parse(input);
    const artifact = this.artifacts.requireEditable(request.artifactId);
    if (artifact.kind !== 'manuscript') throw new Error('research_manuscript_artifact_required');
    const claims = this.resolveManuscriptClaims(artifact, request.sections);
    const latex = renderManuscriptLatex(request.sections, claims, this.evidence.evidenceForClaims(claims, artifact.projectId));
    const record: ResearchManuscript = {
      ...request, projectId: artifact.projectId, latex,
      contentHash: hash(latex), claimsHash: hashClaims(claims), updatedAt: this.now()
    };
    this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO research_manuscripts (artifact_id, project_id, sections_json, latex, content_hash, claims_hash, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(artifact_id) DO UPDATE SET
         sections_json = excluded.sections_json, latex = excluded.latex, content_hash = excluded.content_hash,
         claims_hash = excluded.claims_hash, updated_at = excluded.updated_at`
      ).run(record.artifactId, record.projectId, JSON.stringify(record.sections), record.latex,
        record.contentHash, record.claimsHash, record.updatedAt);
      this.recordChange(artifact, artifact.id, 'manuscript_saved', record.updatedAt);
    })();
    return record;
  }

  getManuscript(artifactId: string): ResearchManuscript | null {
    this.artifacts.get(artifactId);
    const row = this.db.prepare(
      `SELECT artifact_id AS artifactId, project_id AS projectId, sections_json,
       latex, content_hash AS contentHash, claims_hash AS claimsHash, updated_at AS updatedAt
       FROM research_manuscripts WHERE artifact_id = ?`
    ).get(artifactId) as { sections_json: string } | undefined;
    if (row === undefined) return null;
    const { sections_json, ...fields } = row;
    return researchManuscriptSchema.parse({ ...fields, sections: JSON.parse(sections_json) });
  }

  assertPublishable(artifact: ResearchArtifact): void {
    this.requireCurrentManuscript(artifact);
  }

  exportBundle(request: ResearchExportBundleRequest): ResearchExportBundle {
    const artifact = this.artifacts.get(request.artifactId);
    if (artifact.projectId !== request.projectId) throw new Error('research_manuscript_project_mismatch');
    if (artifact.status !== 'approved') throw new Error('research_manuscript_approval_required');
    const { manuscript, claims } = this.requireCurrentManuscript(artifact);
    return {
      ...request, manuscript, claims,
      evidence: this.evidence.evidenceForClaims(claims, request.projectId), generatedAt: this.now()
    };
  }

  private requireCurrentManuscript(artifact: ResearchArtifact): { manuscript: ResearchManuscript; claims: ResearchClaim[] } {
    if (artifact.kind !== 'manuscript') throw new Error('research_manuscript_artifact_required');
    const manuscript = this.getManuscript(artifact.id);
    if (manuscript === null) throw new Error('research_manuscript_required');
    const claims = this.resolveManuscriptClaims(artifact, manuscript.sections);
    if (manuscript.projectId !== artifact.projectId || manuscript.claimsHash !== hashClaims(claims) ||
        manuscript.contentHash !== hash(manuscript.latex) ||
        manuscript.latex !== renderManuscriptLatex(manuscript.sections, claims, this.evidence.evidenceForClaims(claims, artifact.projectId))) {
      throw new Error('research_manuscript_stale');
    }
    return { manuscript, claims };
  }

  private resolveManuscriptClaims(artifact: ResearchArtifact, sections: ResearchManuscript['sections']): ResearchClaim[] {
    return sections.flatMap((section) => section.claimIds).map((id) => {
      const claim = this.evidence.getClaim(id);
      if (claim.artifactId !== artifact.id || claim.projectId !== artifact.projectId) throw new Error('research_claim_artifact_mismatch');
      this.evidence.assertSupported(claim);
      return claim;
    });
  }

  private recordChange(artifact: ResearchArtifact, subjectId: string, type: string, timestamp: string): void {
    this.db.prepare('UPDATE research_artifacts SET updated_at = ? WHERE id = ?').run(timestamp, artifact.id);
    this.db.prepare(
      `INSERT INTO research_workflow_events (id, project_id, stage, type, message, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), artifact.projectId, artifact.stage, type, artifact.title,
      JSON.stringify({ artifactId: artifact.id, subjectId }), timestamp);
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashClaims(claims: ResearchClaim[]): string {
  return hash(JSON.stringify(claims.map(({ id, version, content, status, evidenceIds }) => ({ id, version, content, status, evidenceIds }))));
}
