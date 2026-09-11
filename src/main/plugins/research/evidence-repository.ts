import { createHash, randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';

import {
  researchClaimCreateRequestSchema,
  researchClaimSchema,
  researchClaimUpdateRequestSchema,
  researchEvidenceSchema,
  researchManuscriptSaveRequestSchema,
  researchManuscriptSchema
} from '../../../shared/schemas/research-evidence';
import type {
  ResearchArtifact,
  ResearchClaim,
  ResearchClaimCreateRequest,
  ResearchClaimListRequest,
  ResearchClaimUpdateRequest,
  ResearchEvidence,
  ResearchEvidenceCaptureRequest,
  ResearchExportBundle,
  ResearchExportBundleRequest,
  ResearchManuscript,
  ResearchManuscriptSaveRequest
} from '../../../shared/types';

type ArtifactAccess = {
  get(id: string): ResearchArtifact;
  requireEditable(id: string): ResearchArtifact;
};

const evidenceColumns = `id, project_id AS projectId, document_id AS documentId, chunk_id AS chunkId,
  source_type AS sourceType, source_id AS sourceId, source_version AS sourceVersion, title,
  locator, excerpt, content_hash AS contentHash, created_at AS createdAt`;
const claimColumns = `id, project_id AS projectId, artifact_id AS artifactId, subject_type AS subjectType,
  content, status, evidence_ids_json, version, created_at AS createdAt, updated_at AS updatedAt`;

export class ResearchEvidenceRepository {
  constructor(
    private readonly db: Database,
    private readonly artifacts: ArtifactAccess,
    private readonly now: () => string
  ) {}

  capture(request: ResearchEvidenceCaptureRequest): ResearchEvidence {
    this.requireProject(request.projectId);
    const row = this.db.prepare(
      `SELECT c.id AS chunk_id, c.document_id, d.project_id, d.source_type, d.source_id,
       d.content_hash AS source_version, d.title, d.metadata_json, c.locator, c.content, c.content_hash
       FROM research_knowledge_chunks c JOIN research_knowledge_documents d ON d.id = c.document_id
       WHERE c.id = ?`
    ).get(request.chunkId) as {
      chunk_id: string; document_id: string; project_id: string | null; source_type: string; source_id: string;
      source_version: string; title: string; metadata_json: string; locator: string | null; content: string; content_hash: string;
    } | undefined;
    if (row === undefined) throw new Error('research_evidence_chunk_not_found');
    if (row.project_id !== null && row.project_id !== request.projectId) throw new Error('research_evidence_project_mismatch');
    if (row.source_type === 'note') throw new Error('research_evidence_source_unsupported');
    if (row.locator === null || row.locator.trim().length === 0) throw new Error('research_evidence_locator_required');
    if (row.content_hash !== hash(row.content)) throw new Error('research_evidence_integrity_invalid');
    const metadata: unknown = JSON.parse(row.metadata_json);
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('research_evidence_metadata_invalid');
    const hasMetadata = Object.keys(metadata).length > 0;
    const sourceIdentity: unknown[] = [row.source_version, row.source_type, row.source_id, row.title];
    if (hasMetadata) sourceIdentity.push(metadata);
    const record = researchEvidenceSchema.parse({
      id: `evidence_${randomUUID()}`, projectId: request.projectId, documentId: row.document_id, chunkId: row.chunk_id,
      sourceType: row.source_type, sourceId: row.source_id,
      sourceVersion: hash(JSON.stringify(sourceIdentity)),
      title: row.title, locator: row.locator, excerpt: row.content, contentHash: row.content_hash, createdAt: this.now()
    });
    return this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO research_evidence (id, project_id, document_id, chunk_id, source_type, source_id,
         source_version, title, locator, excerpt, content_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, chunk_id, source_version, locator, content_hash) DO NOTHING`
      ).run(record.id, record.projectId, record.documentId, record.chunkId, record.sourceType, record.sourceId,
        record.sourceVersion, record.title, record.locator, record.excerpt, record.contentHash, record.createdAt);
      const stored = researchEvidenceSchema.parse(this.db.prepare(
        `SELECT ${evidenceColumns} FROM research_evidence
         WHERE project_id = ? AND chunk_id = ? AND source_version = ? AND locator = ? AND content_hash = ?`
      ).get(record.projectId, record.chunkId, record.sourceVersion, record.locator, record.contentHash));
      if (hasMetadata) this.db.prepare('INSERT INTO research_evidence_source_metadata (evidence_id,metadata_json) VALUES (?,?) ON CONFLICT DO NOTHING')
        .run(stored.id, JSON.stringify(metadata));
      return stored;
    })();
  }

  sourceMetadata(projectId: string, evidenceId: string): Record<string, unknown> | null {
    this.requireProject(projectId);
    const exists = this.db.prepare('SELECT id FROM research_evidence WHERE id = ? AND project_id = ?').get(evidenceId, projectId);
    if (exists === undefined) throw new Error('research_evidence_not_found');
    const row = this.db.prepare('SELECT metadata_json FROM research_evidence_source_metadata WHERE evidence_id = ?').get(evidenceId) as { metadata_json: string } | undefined;
    if (row === undefined) return null;
    const metadata: unknown = JSON.parse(row.metadata_json);
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('research_evidence_metadata_invalid');
    return metadata as Record<string, unknown>;
  }

  list(projectId: string): ResearchEvidence[] {
    this.requireProject(projectId);
    return this.db.prepare(`SELECT ${evidenceColumns} FROM research_evidence WHERE project_id = ? ORDER BY rowid DESC`)
      .all(projectId).map((row) => researchEvidenceSchema.parse(row));
  }

  createClaim(input: ResearchClaimCreateRequest): ResearchClaim {
    const request = researchClaimCreateRequestSchema.parse(input);
    const artifact = this.artifacts.requireEditable(request.artifactId);
    if (artifact.projectId !== request.projectId) throw new Error('research_claim_project_mismatch');
    this.validateSupport(request);
    const timestamp = this.now();
    const claim: ResearchClaim = { ...request, id: `claim_${randomUUID()}`, version: 1, createdAt: timestamp, updatedAt: timestamp };
    this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO research_claims (id, project_id, artifact_id, subject_type, content, status, evidence_ids_json, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(claim.id, claim.projectId, claim.artifactId, claim.subjectType, claim.content, claim.status,
        JSON.stringify(claim.evidenceIds), claim.version, timestamp, timestamp);
      this.recordClaimRevision(claim);
      this.recordClaimProvenance(claim);
      this.recordChange(artifact, claim.id, 'claim_created', timestamp);
    })();
    return claim;
  }

  updateClaim(input: ResearchClaimUpdateRequest): ResearchClaim {
    const request = researchClaimUpdateRequestSchema.parse(input);
    const current = this.getClaim(request.id);
    if (request.expectedVersion !== current.version) throw new Error('research_claim_version_conflict');
    const artifact = this.artifacts.requireEditable(current.artifactId);
    const { expectedVersion, ...fields } = request;
    const claim = { ...current, ...fields, version: expectedVersion + 1, updatedAt: this.now() };
    this.validateSupport(claim);
    this.db.transaction(() => {
      this.db.prepare('UPDATE research_claims SET content = ?, status = ?, evidence_ids_json = ?, version = ?, updated_at = ? WHERE id = ?')
        .run(claim.content, claim.status, JSON.stringify(claim.evidenceIds), claim.version, claim.updatedAt, claim.id);
      this.recordClaimRevision(claim);
      this.recordClaimProvenance(claim);
      this.recordChange(artifact, claim.id, 'claim_updated', claim.updatedAt);
    })();
    return claim;
  }

  getClaim(id: string): ResearchClaim {
    const row = this.db.prepare(`SELECT ${claimColumns} FROM research_claims WHERE id = ?`).get(id);
    if (row === undefined) throw new Error('research_claim_not_found');
    return parseClaimRow(row);
  }

  claimHistory(id: string): ResearchClaim[] {
    this.getClaim(id);
    return this.db.prepare('SELECT snapshot_json FROM research_claim_revisions WHERE claim_id = ? ORDER BY version DESC')
      .all(id).map((row) => researchClaimSchema.parse(JSON.parse((row as { snapshot_json: string }).snapshot_json)));
  }

  listClaims(request: ResearchClaimListRequest): ResearchClaim[] {
    this.requireProject(request.projectId);
    if (request.artifactId !== undefined && this.artifacts.get(request.artifactId).projectId !== request.projectId) {
      throw new Error('research_claim_project_mismatch');
    }
    const rows = request.artifactId === undefined
      ? this.db.prepare(`SELECT ${claimColumns} FROM research_claims WHERE project_id = ? ORDER BY rowid`).all(request.projectId)
      : this.db.prepare(`SELECT ${claimColumns} FROM research_claims WHERE project_id = ? AND artifact_id = ? ORDER BY rowid`)
        .all(request.projectId, request.artifactId);
    return rows.map(parseClaimRow);
  }

  saveManuscript(input: ResearchManuscriptSaveRequest): ResearchManuscript {
    const request = researchManuscriptSaveRequestSchema.parse(input);
    const artifact = this.artifacts.requireEditable(request.artifactId);
    if (artifact.kind !== 'manuscript') throw new Error('research_manuscript_artifact_required');
    const claims = this.resolveManuscriptClaims(artifact, request.sections);
    const latex = renderLatex(request.sections, claims, this.evidenceForClaims(claims, artifact.projectId));
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
    if (artifact.kind === 'manuscript') this.requireCurrentManuscript(artifact);
    if (artifact.kind === 'figure') {
      const claims = this.listClaims({ projectId: artifact.projectId, artifactId: artifact.id });
      if (!claims.some((claim) => claim.subjectType === 'figure')) throw new Error('research_figure_evidence_required');
      for (const claim of claims) this.requireSupported(claim);
    }
  }

  exportBundle(request: ResearchExportBundleRequest): ResearchExportBundle {
    const artifact = this.artifacts.get(request.artifactId);
    if (artifact.projectId !== request.projectId) throw new Error('research_manuscript_project_mismatch');
    if (artifact.status !== 'approved') throw new Error('research_manuscript_approval_required');
    const { manuscript, claims } = this.requireCurrentManuscript(artifact);
    return {
      ...request, manuscript, claims,
      evidence: this.evidenceForClaims(claims, request.projectId), generatedAt: this.now()
    };
  }

  private requireCurrentManuscript(artifact: ResearchArtifact): { manuscript: ResearchManuscript; claims: ResearchClaim[] } {
    if (artifact.kind !== 'manuscript') throw new Error('research_manuscript_artifact_required');
    const manuscript = this.getManuscript(artifact.id);
    if (manuscript === null) throw new Error('research_manuscript_required');
    const claims = this.resolveManuscriptClaims(artifact, manuscript.sections);
    if (manuscript.projectId !== artifact.projectId || manuscript.claimsHash !== hashClaims(claims) ||
        manuscript.contentHash !== hash(manuscript.latex) ||
        manuscript.latex !== renderLatex(manuscript.sections, claims, this.evidenceForClaims(claims, artifact.projectId))) {
      throw new Error('research_manuscript_stale');
    }
    return { manuscript, claims };
  }

  private resolveManuscriptClaims(artifact: ResearchArtifact, sections: ResearchManuscript['sections']): ResearchClaim[] {
    return sections.flatMap((section) => section.claimIds).map((id) => {
      const claim = this.getClaim(id);
      if (claim.artifactId !== artifact.id || claim.projectId !== artifact.projectId) throw new Error('research_claim_artifact_mismatch');
      this.requireSupported(claim);
      return claim;
    });
  }

  private requireSupported(claim: ResearchClaim): void {
    if (claim.status !== 'supported') throw new Error(`research_claim_unverified:${claim.id}`);
    this.validateSupport(claim);
  }

  private evidenceForClaims(claims: ResearchClaim[], projectId: string): ResearchEvidence[] {
    return [...new Set(claims.flatMap((claim) => claim.evidenceIds))].map((id) => this.getEvidence(id, projectId));
  }

  private validateSupport(claim: Pick<ResearchClaim, 'projectId' | 'status' | 'evidenceIds'>): void {
    if (claim.status === 'supported' && claim.evidenceIds.length === 0) throw new Error('research_claim_evidence_required');
    for (const id of claim.evidenceIds) this.getEvidence(id, claim.projectId);
  }

  private getEvidence(id: string, projectId: string): ResearchEvidence {
    const row = this.db.prepare(`SELECT ${evidenceColumns} FROM research_evidence WHERE id = ?`).get(id);
    if (row === undefined) throw new Error('research_evidence_not_found');
    const evidence = researchEvidenceSchema.parse(row);
    if (evidence.projectId !== projectId) throw new Error('research_evidence_project_mismatch');
    if (evidence.contentHash !== hash(evidence.excerpt)) throw new Error('research_evidence_integrity_invalid');
    return evidence;
  }

  private requireProject(id: string): void {
    if (this.db.prepare('SELECT id FROM research_projects WHERE id = ?').get(id) === undefined) {
      throw new Error('research_project_not_found');
    }
  }

  private recordClaimProvenance(claim: ResearchClaim): void {
    for (const evidenceId of claim.evidenceIds) {
      const evidence = this.getEvidence(evidenceId, claim.projectId);
      const subjectType = claim.subjectType === 'figure' ? 'figure_claim' : claim.subjectType;
      // 审计边只追加；当前引用以主张版本中的 evidenceIds 为准。
      const existing = this.db.prepare(
        `SELECT id FROM research_provenance WHERE project_id = ? AND artifact_id = ? AND subject_id = ?
         AND subject_type = ? AND source_type = ? AND source_id = ? AND locator = ? AND excerpt = ?`
      ).get(claim.projectId, claim.artifactId, claim.id, subjectType, evidence.sourceType,
        evidence.sourceId, evidence.locator, evidence.excerpt);
      if (existing !== undefined) continue;
      this.db.prepare(
        `INSERT INTO research_provenance (id, project_id, artifact_id, subject_type, subject_id, source_type, source_id, locator, excerpt, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(randomUUID(), claim.projectId, claim.artifactId, subjectType, claim.id,
        evidence.sourceType, evidence.sourceId, evidence.locator, evidence.excerpt, claim.updatedAt);
    }
  }

  private recordClaimRevision(claim: ResearchClaim): void {
    this.db.prepare('INSERT INTO research_claim_revisions (claim_id, version, snapshot_json) VALUES (?, ?, ?)')
      .run(claim.id, claim.version, JSON.stringify(claim));
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

function parseClaimRow(value: unknown): ResearchClaim {
  const row = value as { evidence_ids_json: string };
  const { evidence_ids_json, ...fields } = row;
  return researchClaimSchema.parse({ ...fields, evidenceIds: JSON.parse(evidence_ids_json) });
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashClaims(claims: ResearchClaim[]): string {
  return hash(JSON.stringify(claims.map(({ id, version, content, status, evidenceIds }) => ({ id, version, content, status, evidenceIds }))));
}

function renderLatex(sections: ResearchManuscript['sections'], claims: ResearchClaim[], evidence: ResearchEvidence[]): string {
  const byId = new Map(claims.map((claim) => [claim.id, claim]));
  const body = sections.map((section) => [
    `\\section{${escapeLatex(section.title)}}`,
    ...section.claimIds.map((id) => {
      const claim = byId.get(id);
      if (claim === undefined) throw new Error('research_claim_not_found');
      return `% claim: ${id}; version: ${claim.version}\n${escapeLatex(claim.content)}\\cite{${claim.evidenceIds.join(',')}}`;
    })
  ].join('\n\n')).join('\n\n');
  const bibliography = evidence.map((source) =>
    `% source-version: ${source.sourceVersion}; excerpt-hash: ${source.contentHash}\n` +
    `\\bibitem{${source.id}} ${escapeLatex(source.title)}. ${escapeLatex(source.sourceId)}. ${escapeLatex(source.locator)}.`
  ).join('\n');
  return `${body}\n\n\\begin{thebibliography}{99}\n${bibliography}\n\\end{thebibliography}\n`;
}

function escapeLatex(text: string): string {
  const replacements: Record<string, string> = {
    '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '%': '\\%', '&': '\\&',
    '#': '\\#', '_': '\\_', '$': '\\$', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}'
  };
  return text.replace(/[\\{}%&#_$~^]/gu, (character) => replacements[character]);
}
