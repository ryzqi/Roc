import {createHash} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import type {z} from 'zod';
import {
  scholarlySnapshotSchema, scholarlyHistorySchema, scholarlyReadSchema,
  type ScholarlyCapture, type ScholarlySnapshot, type ScholarlySnapshotSummary,
  type scholarlyHistoryResultSchema, type scholarlyReadResultSchema
} from '../../../shared/schemas/research-scholarly-relations';
import type {ResearchRepository} from './repository';

type SnapshotRow = {id: string; project_id: string; item_id: string; request_id: string; snapshot_json: string};
export const scholarlyContentHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function scholarlySummary(snapshot: ScholarlySnapshot): ScholarlySnapshotSummary {
  const {relations: _relations, ...summary} = snapshot;
  return summary;
}

export class ScholarlyRelationsRepository {
  constructor(private readonly db: Database, private readonly research: ResearchRepository) {}

  findRequest(request: ScholarlyCapture): ScholarlySnapshotSummary | null {
    this.research.getProject(request.projectId);
    const row = this.db.prepare('SELECT * FROM research_scholarly_snapshots WHERE project_id=? AND request_id=?')
      .get(request.projectId, request.requestId) as SnapshotRow | undefined;
    if (row === undefined) return null;
    const snapshot = this.parse(row);
    if (JSON.stringify(snapshot.request) !== JSON.stringify(request)) throw new Error('scholarly_request_conflict');
    return scholarlySummary(snapshot);
  }

  requireCaptureScope(request: ScholarlyCapture): string {
    if (this.research.getProject(request.projectId).status === 'archived') throw new Error('research_project_archived');
    const item = this.research.library.get(request.itemId);
    if (!item.projectIds.includes(request.projectId)) throw new Error('scholarly_item_project_mismatch');
    if (item.archived) throw new Error('research_library_item_archived');
    if (item.revision !== request.expectedRevision) throw new Error('research_library_revision_conflict');
    if (item.metadata.doi === null) throw new Error('scholarly_doi_required');
    return item.metadata.doi;
  }

  save(input: ScholarlySnapshot): ScholarlySnapshotSummary {
    const snapshot = this.parse({id: input.id, project_id: input.projectId, item_id: input.itemId,
      request_id: input.request.requestId, snapshot_json: JSON.stringify(input)});
    return this.db.transaction(() => {
      const replay = this.findRequest(snapshot.request);
      if (replay !== null) return replay;
      if (this.requireCaptureScope(snapshot.request) !== snapshot.doi) throw new Error('scholarly_source_changed');
      this.db.prepare(`INSERT INTO research_scholarly_snapshots
        (id,project_id,item_id,request_id,snapshot_json,created_at) VALUES (?,?,?,?,?,?)`)
        .run(snapshot.id, snapshot.projectId, snapshot.itemId, snapshot.request.requestId, JSON.stringify(snapshot), snapshot.queriedAt);
      return scholarlySummary(snapshot);
    })();
  }

  history(input: z.infer<typeof scholarlyHistorySchema>): z.infer<typeof scholarlyHistoryResultSchema> {
    const request = scholarlyHistorySchema.parse(input);
    this.research.getProject(request.projectId);
    this.research.library.get(request.itemId);
    const total = this.db.prepare('SELECT COUNT(*) FROM research_scholarly_snapshots WHERE project_id=? AND item_id=?')
      .pluck().get(request.projectId, request.itemId) as number;
    const records = (this.db.prepare(`SELECT * FROM research_scholarly_snapshots
      WHERE project_id=? AND item_id=? ORDER BY rowid DESC LIMIT ? OFFSET ?`)
      .all(request.projectId, request.itemId, request.limit, request.offset) as SnapshotRow[])
      .map(row => scholarlySummary(this.parse(row)));
    return {records, total, nextOffset: request.offset + records.length < total ? request.offset + records.length : null};
  }

  read(input: z.infer<typeof scholarlyReadSchema>): z.infer<typeof scholarlyReadResultSchema> {
    const request = scholarlyReadSchema.parse(input);
    this.research.getProject(request.projectId);
    const row = this.db.prepare(`SELECT * FROM research_scholarly_snapshots WHERE id=? AND project_id=? AND item_id=?`)
      .get(request.snapshotId, request.projectId, request.itemId) as SnapshotRow | undefined;
    if (row === undefined) throw new Error('scholarly_snapshot_not_found');
    const snapshot = this.parse(row);
    if (!snapshot.request.sources.includes(request.source)) throw new Error('scholarly_source_not_captured');
    const relations = snapshot.relations.filter(row => row.source === request.source).map(row => row.relation);
    const page = relations.slice(request.offset, request.offset + request.limit);
    return {snapshot: scholarlySummary(snapshot), source: request.source, relations: page, total: relations.length,
      nextOffset: request.offset + page.length < relations.length ? request.offset + page.length : null};
  }

  private parse(row: SnapshotRow): ScholarlySnapshot {
    const snapshot = scholarlySnapshotSchema.parse(JSON.parse(row.snapshot_json));
    const {contentHash, ...body} = snapshot;
    const ok = snapshot.sources.filter(source => source.status === 'ok').length;
    const status = ok === snapshot.sources.length ? 'complete' : ok === 0 ? 'failed' : 'partial';
    if (scholarlyContentHash(body) !== contentHash || snapshot.id !== row.id || snapshot.projectId !== row.project_id ||
      snapshot.itemId !== row.item_id || snapshot.request.requestId !== row.request_id || snapshot.projectId !== snapshot.request.projectId ||
      snapshot.itemId !== snapshot.request.itemId || snapshot.itemRevision !== snapshot.request.expectedRevision ||
      status !== snapshot.status || JSON.stringify(snapshot.sources.map(source => source.source)) !== JSON.stringify(snapshot.request.sources) ||
      snapshot.relations.some(row => !snapshot.request.sources.includes(row.source)) ||
      snapshot.sources.some(source => source.relationCount !== snapshot.relations.filter(row => row.source === source.source).length ||
        (source.status === 'ok' ? source.errorCode !== null : source.errorCode === null || source.relationCount !== 0))) {
      throw new Error('scholarly_snapshot_invalid');
    }
    return snapshot;
  }
}
