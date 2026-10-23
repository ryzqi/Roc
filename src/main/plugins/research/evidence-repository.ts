import { createHash, randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';

import {
  researchClaimCreateRequestSchema,
  researchClaimSchema,
  researchClaimUpdateRequestSchema,
  researchEvidenceSchema
} from '../../../shared/schemas/research-evidence';
import type {
  ResearchArtifact,
  ResearchClaim,
  ResearchClaimCreateRequest,
  ResearchClaimListRequest,
  ResearchClaimUpdateRequest,
  ResearchEvidence,
  ResearchEvidenceCaptureRequest
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
    const metadata = parseMetadata(row.metadata_json);
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
    const metadata = parseMetadata(row.metadata_json);
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
      .all(id).map((row) => researchClaimSchema.parse(parseSnapshot((row as { snapshot_json: string }).snapshot_json)));
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

  assertPublishable(artifact: ResearchArtifact): void {
    if (artifact.kind !== 'figure') return;
    const claims = this.listClaims({ projectId: artifact.projectId, artifactId: artifact.id });
    if (!claims.some((claim) => claim.subjectType === 'figure')) throw new Error('research_figure_evidence_required');
    for (const claim of claims) this.assertSupported(claim);
  }

  assertSupported(claim: ResearchClaim): void {
    if (claim.status !== 'supported') throw new Error(`research_claim_unverified:${claim.id}`);
    this.validateSupport(claim);
  }

  evidenceForClaims(claims: ResearchClaim[], projectId: string): ResearchEvidence[] {
    return [...new Set(claims.flatMap((claim) => claim.evidenceIds))].map((id) => this.getEvidence(id, projectId));
  }

  getEvidence(id: string, projectId: string): ResearchEvidence {
    const row = this.db.prepare(`SELECT id, project_id AS projectId, document_id AS documentId, chunk_id AS chunkId,
      source_type AS sourceType, source_id AS sourceId, source_version AS sourceVersion, title,
      locator, excerpt, content_hash AS contentHash, created_at AS createdAt, invalidated_at
      FROM research_evidence WHERE id = ?`).get(id) as (Record<string, unknown> & { invalidated_at?: string | null }) | undefined;
    if (row === undefined) throw new Error('research_evidence_not_found');
    // invalidated_at 是失效标记本身，不属于证据契约（schema 是 strict 的），先摘掉再校验。
    const { invalidated_at: invalidatedAt, ...fields } = row;
    const evidence = researchEvidenceSchema.parse(fields);
    if (evidence.projectId !== projectId) throw new Error('research_evidence_project_mismatch');
    // 引用失效（提案 §8.4）：该证据引用的块已随代际切换或重新解析换掉/删除。原文与证据行都
    // 还在，只是块定位不再成立 —— 必须明确报「引用待重建」，不得静默指向新块，也不得退化成
    // not_found（那会让用户以为证据被删掉了）。失效标记由真正改变块身份的两个事件写入。
    if (invalidatedAt !== null && invalidatedAt !== undefined) throw new Error('research_evidence_reference_superseded');
    if (evidence.contentHash !== hash(evidence.excerpt)) throw new Error('research_evidence_integrity_invalid');
    return evidence;
  }

  /**
   * 某个知识文档（即某次解析结果）被删除：指向它块的证据全部失效（提案 §8.4）。
   *
   * 解析结果的块 id 是 `${knowledgeDocumentId}:chunk:${index}`，且每次解析都是一个新的知识
   * 文档 —— 重解析、归档、删除、代际切换都是“删旧的、建新的”，所以块要么原样留着，要么整批
   * 消失，不存在“同一个块原地改内容”。因此不需要比对内容哈希，也不需要看块是否已不存在：
   * 调用方（删块的那几个点）在删除之前调这里，语义就是“这批块即将消失”。
   */
  invalidateChunksOf(knowledgeDocumentId: string): number {
    return this.db.prepare('UPDATE research_evidence SET invalidated_at = ?\n      WHERE invalidated_at IS NULL AND chunk_id LIKE ?')
      .run(this.now(), `${knowledgeDocumentId}:chunk:%`).changes;
  }

  private validateSupport(claim: Pick<ResearchClaim, 'projectId' | 'status' | 'evidenceIds'>): void {
    if (claim.status === 'supported' && claim.evidenceIds.length === 0) throw new Error('research_claim_evidence_required');
    for (const id of claim.evidenceIds) this.getEvidence(id, claim.projectId);
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

/**
 * `metadata_json` 是捕获证据时写入的键值对，读回来要参与 `sourceVersion` 计算。
 *
 * 坏行只可能来自损坏的库，所以给领域码而不是让 `SyntaxError` 冒到捕获/导出路径。
 */
function parseMetadata(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('research_evidence_metadata_invalid');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('research_evidence_metadata_invalid');
  }
  return parsed as Record<string, unknown>;
}

/**
 * `snapshot_json` 同理：内部写入的快照，坏行给领域码而不是 `SyntaxError`。
 * 返回 `Record<string, unknown>` 而不是 `unknown`：`researchClaimSchema.parse` 本来就要一个对象，
 * 非对象的快照是这个码的唯一结果，所以边界就在这里把形状确定下来。
 */
function parseSnapshot(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('research_claim_snapshot_corrupt');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('research_claim_snapshot_corrupt');
  }
  return parsed as Record<string, unknown>;
}

function parseClaimRow(value: unknown): ResearchClaim {
  const row = value as { evidence_ids_json: string };
  const { evidence_ids_json, ...fields } = row;
  return researchClaimSchema.parse({ ...fields, evidenceIds: parseEvidenceIds(evidence_ids_json) });
}

/**
 * `evidence_ids_json` 是**内部写入**的列，不是外部输入：库里的坏行只能来自写坏的数据/损坏的库。
 *
 * 不包 try/catch 的话，一个坏行会把 `JSON.parse` 的 `SyntaxError` 原样抛到证据列表/导出路径，
 * 用户看到 `Unexpected token` 而不知道是哪个 claim 坏了。换成确定的领域码后，调用方可以
 * 把它归到「数据损坏」而不是「程序错误」。
 */
function parseEvidenceIds(value: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('research_claim_evidence_ids_invalid');
  }
  if (!Array.isArray(parsed) || !parsed.every((id): id is string => typeof id === 'string')) {
    throw new Error('research_claim_evidence_ids_invalid');
  }
  return parsed;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
