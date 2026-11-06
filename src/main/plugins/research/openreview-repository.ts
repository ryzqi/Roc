import type {Database} from 'better-sqlite3';
import type {z} from 'zod';
import {
  openReviewObservationSchema, openReviewHistorySchema, openReviewReadSchema, type OpenReviewCapture,
  type OpenReviewObservation, type OpenReviewSummary, type openReviewHistoryResultSchema, type openReviewReadResultSchema
} from '../../../shared/schemas/research-openreview';
import {resourceContentHash} from './resource-repository';
import {openReviewEndpoint, verifyOpenReviewPage} from './openreview-adapter';
import type {ResearchRepository} from './repository';

type Row = {id: string; project_id: string; request_id: string; query_json: string; snapshot_json: string};
export function openReviewSummary(value: OpenReviewObservation): OpenReviewSummary {
  const {page, ...body} = value;
  return {...body, entryCount: page === null ? null : page.entries.length,
    providerTotal: page?.providerTotal ?? null, nextAfter: page?.nextAfter ?? null};
}
export class OpenReviewRepository {
  constructor(private readonly db: Database, private readonly research: ResearchRepository) {}
  requireCaptureScope(projectId: string): void {
    if (this.research.getProject(projectId).status === 'archived') throw new Error('research_project_archived');
  }
  findRequest(request: OpenReviewCapture): OpenReviewSummary | null {
    this.research.getProject(request.projectId);
    const row = this.db.prepare('SELECT * FROM research_openreview_observations WHERE project_id=? AND request_id=?')
      .get(request.projectId, request.requestId) as Row | undefined;
    if (row === undefined) return null;
    const snapshot = this.parse(row);
    if (JSON.stringify(snapshot.request) !== JSON.stringify(request)) throw new Error('research_openreview_request_conflict');
    return openReviewSummary(snapshot);
  }
  save(input: OpenReviewObservation): OpenReviewSummary {
    const snapshot = this.parse({id: input.id, project_id: input.projectId, request_id: input.request.requestId,
      query_json: JSON.stringify(input.request.query), snapshot_json: JSON.stringify(input)});
    return this.db.transaction(() => {
      const replay = this.findRequest(snapshot.request);
      if (replay !== null) return replay;
      this.requireCaptureScope(snapshot.projectId);
      this.db.prepare(`INSERT INTO research_openreview_observations
        (id,project_id,request_id,query_json,snapshot_json,created_at) VALUES (?,?,?,?,?,?)`)
        .run(snapshot.id, snapshot.projectId, snapshot.request.requestId, JSON.stringify(snapshot.request.query),
          JSON.stringify(snapshot), snapshot.queriedAt);
      this.requireCaptureScope(snapshot.projectId);
      return openReviewSummary(this.get(snapshot.projectId, snapshot.id));
    })();
  }
  get(projectId: string, observationId: string): OpenReviewObservation {
    this.research.getProject(projectId);
    const row = this.db.prepare('SELECT * FROM research_openreview_observations WHERE id=? AND project_id=?')
      .get(observationId, projectId) as Row | undefined;
    if (row === undefined) throw new Error('research_openreview_not_found');
    return this.parse(row);
  }
  history(input: z.infer<typeof openReviewHistorySchema>): z.infer<typeof openReviewHistoryResultSchema> {
    const request = openReviewHistorySchema.parse(input);
    this.research.getProject(request.projectId);
    const total = this.db.prepare('SELECT COUNT(*) FROM research_openreview_observations WHERE project_id=?')
      .pluck().get(request.projectId) as number;
    const records = (this.db.prepare(`SELECT * FROM research_openreview_observations WHERE project_id=?
      ORDER BY rowid DESC LIMIT ? OFFSET ?`).all(request.projectId, request.limit, request.offset) as Row[])
      .map(row => openReviewSummary(this.parse(row)));
    return {records, total, nextOffset: request.offset + records.length < total ? request.offset + records.length : null};
  }
  read(input: z.infer<typeof openReviewReadSchema>): z.infer<typeof openReviewReadResultSchema> {
    const request = openReviewReadSchema.parse(input), snapshot = this.get(request.projectId, request.observationId);
    const entries = snapshot.page?.entries ?? null, page = entries === null ? [] : entries.slice(request.offset, request.offset + request.limit);
    return {observation: openReviewSummary(snapshot), entries: page, total: entries === null ? null : entries.length,
      nextOffset: entries !== null && request.offset + page.length < entries.length ? request.offset + page.length : null};
  }
  private parse(row: Row): OpenReviewObservation {
    try {
      const value = openReviewObservationSchema.parse(JSON.parse(row.snapshot_json)), {contentHash, ...body} = value;
      if (resourceContentHash(body) !== contentHash || value.id !== row.id || value.projectId !== row.project_id ||
        value.projectId !== value.request.projectId || value.request.requestId !== row.request_id ||
        JSON.stringify(value.request.query) !== row.query_json || value.endpoint !== openReviewEndpoint(value.request.query) ||
        value.governance.host !== 'api2.openreview.net' || value.status === 'ok' && (value.fetchedAt === null || value.responseHash === null))
        throw new Error('research_openreview_snapshot_invalid');
      if (value.status === 'ok') verifyOpenReviewPage(value.request.query, value.page);
      return value;
    } catch (cause) {throw new Error('research_openreview_snapshot_invalid', {cause});}
  }
}
