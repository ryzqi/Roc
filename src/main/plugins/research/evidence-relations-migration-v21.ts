import {createHash} from 'node:crypto';
import type {Database as DatabaseConnection} from 'better-sqlite3';
import {researchClaimSchema, researchEvidenceSchema} from '../../../shared/schemas/research-evidence';
import {researchSourceLocatorSchema} from '../../../shared/schemas/research-source-locator';
import {researchEvidenceRelationSchema, researchEvidenceRelationRevisionSchema} from '../../../shared/schemas/research-evidence-relations';

/** Frozen DB21 transformation: old evidenceIds are historical associations, never reviewed scientific relations. */
export function migrateHistoricalEvidenceRelationsV21(db: DatabaseConnection): void {
  const claims = db.prepare(`SELECT id,project_id AS projectId,artifact_id AS artifactId,subject_type AS subjectType,
    content,status,evidence_ids_json,version,created_at AS createdAt,updated_at AS updatedAt FROM research_claims ORDER BY rowid`).all();
  const recordedAt = new Date().toISOString();
  for (const value of claims) {
    const {evidence_ids_json: evidenceIdsJson, ...fields} = value as Record<string, unknown> & {evidence_ids_json: string};
    const claim = researchClaimSchema.parse({...fields, evidenceIds: JSON.parse(evidenceIdsJson)});
    const artifact = db.prepare('SELECT project_id FROM research_artifacts WHERE id=?')
      .get(claim.artifactId) as {project_id: string} | undefined;
    if (artifact?.project_id !== claim.projectId) throw new Error('research_relation_historical_project_mismatch');
    for (const evidenceId of claim.evidenceIds) {
      const row = db.prepare(`SELECT id,project_id AS projectId,document_id AS documentId,chunk_id AS chunkId,
        source_type AS sourceType,source_id AS sourceId,source_version AS sourceVersion,title,locator,excerpt,
        content_hash AS contentHash,created_at AS createdAt,invalidated_at FROM research_evidence WHERE id=?`)
        .get(evidenceId) as Record<string, unknown> & {invalidated_at: string | null} | undefined;
      if (row === undefined) throw new Error('research_relation_historical_endpoint_missing');
      const {invalidated_at: invalidatedAt, ...evidenceFields} = row;
      const evidence = researchEvidenceSchema.parse(evidenceFields);
      if (evidence.projectId !== claim.projectId) throw new Error('research_relation_historical_project_mismatch');
      if (hash(evidence.excerpt) !== evidence.contentHash) throw new Error('research_relation_historical_source_invalid');
      const savedLocator = db.prepare('SELECT locator_json FROM research_evidence_source_locators WHERE evidence_id=?')
        .get(evidenceId) as {locator_json: string} | undefined;
      const source = {evidence, referenceStatus: invalidatedAt === null ? 'recorded' : 'superseded', invalidatedAt,
        sourceLocator: savedLocator === undefined ? null : researchSourceLocatorSchema.parse(JSON.parse(savedLocator.locator_json))};
      const relation = researchEvidenceRelationSchema.parse({
        id: `historical_relation_${hash(JSON.stringify([claim.id, claim.version, evidenceId]))}`,
        projectId: claim.projectId, artifactId: claim.artifactId, claimId: claim.id, claimVersion: claim.version,
        claimHash: hash(JSON.stringify(claim)), evidenceId, source, sourceDigest: hash(JSON.stringify(source)),
        kind: 'historical', condition: null, supersedesRelationId: null, proposer: null,
        status: invalidatedAt === null ? 'historical' : 'invalidated', version: 1, reviewer: null,
        reviewedAt: null, decisionNote: null, invalidatedReason: invalidatedAt === null ? null : 'evidence_invalidated',
        createdAt: claim.updatedAt, updatedAt: claim.updatedAt
      });
      db.prepare(`INSERT INTO research_evidence_relations
        (id,project_id,claim_id,evidence_id,claim_version,kind,status,version,snapshot_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(relation.id, relation.projectId, relation.claimId, relation.evidenceId,
          relation.claimVersion, relation.kind, relation.status, relation.version, JSON.stringify(relation),
          relation.createdAt, relation.updatedAt);
      const revision = researchEvidenceRelationRevisionSchema.parse({relation, actor: null, event: 'historical', recordedAt});
      db.prepare('INSERT INTO research_evidence_relation_revisions (relation_id,version,snapshot_json) VALUES (?,?,?)')
        .run(relation.id, 1, JSON.stringify(revision));
    }
  }
}
function hash(value: string): string {return createHash('sha256').update(value).digest('hex');}
