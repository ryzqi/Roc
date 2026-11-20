import {createHash, randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {
  researchReviewProtocolSaveRequestSchema, researchReviewProtocolFreezeRequestSchema,
  researchReviewProtocolVersionSchema, researchReviewProtocolFreezeSchema, researchReviewProtocolInspectionSchema,
  researchReviewProtocolGetRequestSchema, researchReviewProtocolHistoryRequestSchema, researchReviewProtocolListRequestSchema,
  type ResearchReviewProtocolSaveRequest, type ResearchReviewProtocolFreezeRequest,
  type ResearchReviewProtocolInspection, type ResearchReviewProtocolVersion
} from '../../../shared/schemas/research-systematic-review';
import {researchRelationReviewerSchema, type ResearchRelationReviewer} from '../../../shared/schemas/research-evidence-relations';
import type {ResearchRepository} from './repository';

type VersionRow = {
  id: string; protocol_id: string; project_id: string; version: number; parent_version_id: string | null;
  request_id: string; snapshot_json: string; snapshot_hash: string; freeze_hash: string | null; created_at: string
};
type FreezeRow = {
  version_id: string; project_id: string; request_id: string;
  snapshot_json: string; snapshot_hash: string; created_at: string
};
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Append-only protocol revisions and separate human confirmation receipts. */
export class ResearchSystematicReviewRepository {
  constructor(private readonly db: Database, private readonly repository: ResearchRepository, private readonly now: () => string) {}

  save(input: ResearchReviewProtocolSaveRequest, createdBy: ResearchRelationReviewer): ResearchReviewProtocolInspection {
    const request = researchReviewProtocolSaveRequestSchema.parse(input);
    const actor = researchRelationReviewerSchema.parse(createdBy);
    return this.db.transaction(() => {
      this.requireWritableProject(request.projectId);
      const requestHash = hash(JSON.stringify(request));
      const replay = this.db.prepare('SELECT * FROM research_review_protocol_versions WHERE project_id=? AND request_id=?')
        .get(request.projectId, request.requestId) as VersionRow | undefined;
      if (replay !== undefined) {
        const existing = this.inspect(replay);
        if (existing.version.requestHash !== requestHash || existing.version.actor.id !== actor.id) {
          throw new Error('research_review_request_conflict');
        }
        return existing;
      }
      const parent = request.protocolId === null ? null : this.latest(request.protocolId, request.projectId);
      if (parent !== null && (parent.version.id !== request.expectedVersionId || parent.versionHash !== request.expectedVersionHash)) {
        throw new Error('research_review_version_conflict');
      }
      const version = researchReviewProtocolVersionSchema.parse({
        id: `review_protocol_version_${randomUUID()}`, protocolId: parent === null ? `review_protocol_${randomUUID()}` : parent.version.protocolId,
        projectId: request.projectId, version: parent === null ? 1 : parent.version.version + 1,
        parentVersionId: parent === null ? null : parent.version.id, parentVersionHash: parent === null ? null : parent.versionHash,
        body: request.body, deviationReason: request.deviationReason, requestId: request.requestId, requestHash,
        actor, recordedAt: this.now()
      });
      const snapshot = JSON.stringify(version);
      this.db.prepare(`INSERT INTO research_review_protocol_versions
        (id,protocol_id,project_id,version,parent_version_id,request_id,snapshot_json,snapshot_hash,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(version.id, version.protocolId, version.projectId, version.version,
          version.parentVersionId, version.requestId, snapshot, hash(snapshot), version.recordedAt);
      return this.get({projectId: request.projectId, versionId: version.id});
    })();
  }

  freeze(input: ResearchReviewProtocolFreezeRequest, reviewedBy: ResearchRelationReviewer): ResearchReviewProtocolInspection {
    const request = researchReviewProtocolFreezeRequestSchema.parse(input);
    const actor = researchRelationReviewerSchema.parse(reviewedBy);
    return this.db.transaction(() => {
      this.requireWritableProject(request.projectId);
      const selected = this.get({projectId: request.projectId, versionId: request.versionId});
      if (selected.versionHash !== request.expectedVersionHash) throw new Error('research_review_version_conflict');
      const requestHash = hash(JSON.stringify(request));
      const replay = this.db.prepare('SELECT * FROM research_review_protocol_freezes WHERE project_id=? AND request_id=?')
        .get(request.projectId, request.requestId) as FreezeRow | undefined;
      if (replay !== undefined) {
        const previous = this.get({projectId: request.projectId, versionId: replay.version_id});
        if (previous.freeze?.requestHash !== requestHash || previous.freeze.actor.id !== actor.id) {
          throw new Error('research_review_request_conflict');
        }
        return previous;
      }
      if (!selected.isLatest) throw new Error('research_review_version_conflict');
      if (selected.freeze !== null) throw new Error('research_review_already_frozen');
      const freeze = researchReviewProtocolFreezeSchema.parse({request, requestHash, actor, frozenAt: this.now()});
      const snapshot = JSON.stringify(freeze);
      this.db.prepare(`INSERT INTO research_review_protocol_freezes
        (version_id,project_id,request_id,snapshot_json,snapshot_hash,created_at) VALUES (?,?,?,?,?,?)`)
        .run(request.versionId, request.projectId, request.requestId, snapshot, hash(snapshot), freeze.frozenAt);
      this.db.prepare('UPDATE research_review_protocol_versions SET freeze_hash=? WHERE id=? AND freeze_hash IS NULL')
        .run(hash(snapshot), request.versionId);
      return this.get({projectId: request.projectId, versionId: request.versionId});
    })();
  }

  get(input: {projectId: string; versionId: string}): ResearchReviewProtocolInspection {
    const request = researchReviewProtocolGetRequestSchema.parse(input);
    this.repository.getProject(request.projectId);
    const row = this.db.prepare('SELECT * FROM research_review_protocol_versions WHERE id=?').get(request.versionId) as VersionRow | undefined;
    if (row === undefined) throw new Error('research_review_protocol_not_found');
    if (row.project_id !== request.projectId) throw new Error('research_review_project_mismatch');
    return this.inspect(row);
  }

  history(input: {projectId: string; protocolId: string}): ResearchReviewProtocolInspection[] {
    const request = researchReviewProtocolHistoryRequestSchema.parse(input);
    this.latest(request.protocolId, request.projectId);
    const rows = this.db.prepare('SELECT * FROM research_review_protocol_versions WHERE protocol_id=? ORDER BY version')
      .all(request.protocolId) as VersionRow[];
    return rows.map(row => {
      if (row.project_id !== request.projectId) throw new Error('research_review_project_mismatch');
      return this.inspect(row);
    });
  }

  list(input: {projectId: string; limit: number}): ResearchReviewProtocolInspection[] {
    const request = researchReviewProtocolListRequestSchema.parse(input);
    this.repository.getProject(request.projectId);
    const rows = this.db.prepare(`SELECT * FROM research_review_protocol_versions v WHERE project_id=? AND
      version=(SELECT MAX(version) FROM research_review_protocol_versions WHERE protocol_id=v.protocol_id)
      ORDER BY rowid DESC LIMIT ?`).all(request.projectId, request.limit) as VersionRow[];
    return rows.map(row => this.inspect(row));
  }

  requireFrozen(projectId: string, versionId: string, expectedFreezeHash: string): ResearchReviewProtocolInspection {
    const current = this.get({projectId, versionId});
    if (current.freeze === null) throw new Error('research_review_protocol_not_frozen');
    if (!current.isLatest || current.freezeHash !== expectedFreezeHash) throw new Error('research_review_version_conflict');
    return current;
  }

  private latest(protocolId: string, projectId: string): ResearchReviewProtocolInspection {
    this.repository.getProject(projectId);
    const row = this.db.prepare('SELECT * FROM research_review_protocol_versions WHERE protocol_id=? ORDER BY version DESC LIMIT 1')
      .get(protocolId) as VersionRow | undefined;
    if (row === undefined) throw new Error('research_review_protocol_not_found');
    if (row.project_id !== projectId) throw new Error('research_review_project_mismatch');
    return this.inspect(row);
  }

  private inspect(row: VersionRow): ResearchReviewProtocolInspection {
    const version = this.readVersion(row);
    const parent = version.parentVersionId === null ? null : this.db.prepare('SELECT * FROM research_review_protocol_versions WHERE id=?')
      .get(version.parentVersionId) as VersionRow | undefined;
    if (parent === undefined) throw new Error('research_review_snapshot_invalid');
    if (parent !== null) {
      const previous = this.readVersion(parent);
      if (parent.snapshot_hash !== version.parentVersionHash || previous.protocolId !== version.protocolId ||
          previous.projectId !== version.projectId || previous.version !== version.version - 1) {
        throw new Error('research_review_snapshot_invalid');
      }
    }
    const receipt = this.db.prepare('SELECT * FROM research_review_protocol_freezes WHERE version_id=?').get(row.id) as FreezeRow | undefined;
    if ((receipt === undefined) !== (row.freeze_hash === null) ||
        (receipt !== undefined && receipt.snapshot_hash !== row.freeze_hash)) throw new Error('research_review_snapshot_invalid');
    let freeze: ResearchReviewProtocolInspection['freeze'] = null;
    if (receipt !== undefined) {
      freeze = researchReviewProtocolFreezeSchema.parse(JSON.parse(receipt.snapshot_json));
      if (hash(receipt.snapshot_json) !== receipt.snapshot_hash || JSON.stringify(freeze) !== receipt.snapshot_json ||
          freeze.request.versionId !== row.id || freeze.request.projectId !== row.project_id ||
          freeze.request.expectedVersionHash !== row.snapshot_hash || freeze.request.requestId !== receipt.request_id ||
          freeze.requestHash !== hash(JSON.stringify(freeze.request)) || freeze.frozenAt !== receipt.created_at ||
          receipt.project_id !== row.project_id) throw new Error('research_review_snapshot_invalid');
    }
    const latest = this.db.prepare('SELECT id FROM research_review_protocol_versions WHERE protocol_id=? ORDER BY version DESC LIMIT 1')
      .pluck().get(row.protocol_id);
    return researchReviewProtocolInspectionSchema.parse({
      version, versionHash: row.snapshot_hash, freeze, freezeHash: receipt === undefined ? null : receipt.snapshot_hash,
      isLatest: latest === row.id
    });
  }

  private readVersion(row: VersionRow): ResearchReviewProtocolVersion {
    const version = researchReviewProtocolVersionSchema.parse(JSON.parse(row.snapshot_json));
    const request = {projectId: version.projectId, requestId: version.requestId,
      protocolId: version.version === 1 ? null : version.protocolId, expectedVersionId: version.parentVersionId,
      expectedVersionHash: version.parentVersionHash, body: version.body, deviationReason: version.deviationReason};
    if (hash(row.snapshot_json) !== row.snapshot_hash || JSON.stringify(version) !== row.snapshot_json ||
        version.id !== row.id || version.protocolId !== row.protocol_id || version.projectId !== row.project_id ||
        version.version !== row.version || version.parentVersionId !== row.parent_version_id ||
        version.requestId !== row.request_id || version.recordedAt !== row.created_at ||
        version.requestHash !== hash(JSON.stringify(request))) throw new Error('research_review_snapshot_invalid');
    return version;
  }

  private requireWritableProject(projectId: string): void {
    if (this.repository.getProject(projectId).status === 'archived') throw new Error('research_project_archived');
  }
}
