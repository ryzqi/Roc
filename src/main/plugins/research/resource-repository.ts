import {createHash} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import type {z} from 'zod';
import {
  resourceObservationSchema, resourceHistorySchema, resourceReadSchema,
  type ResourceCapture, type ResourceObservation, type ResourceSummary,
  type resourceHistoryResultSchema, type resourceReadResultSchema
} from '../../../shared/schemas/research-resources';
import {normalizeResearchDoi} from './literature-identity';
import {dataciteEndpoint} from './datacite-adapter';
import type {ResearchRepository} from './repository';

type ResourceRow = {id: string; project_id: string; request_id: string; doi: string; snapshot_json: string};
export const resourceContentHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function resourceSummary(value: ResourceObservation): ResourceSummary {
  const {metadata, ...body} = value;
  if (metadata === null) return {...body, metadata: null, relatedCount: null};
  const {relatedIdentifiers, ...summary} = metadata;
  return {...body, metadata: summary, relatedCount: relatedIdentifiers === null ? null : relatedIdentifiers.length};
}

export class ResearchResourceRepository {
  constructor(private readonly db: Database, private readonly research: ResearchRepository) {}

  requireCaptureScope(projectId: string): void {
    if (this.research.getProject(projectId).status === 'archived') throw new Error('research_project_archived');
  }

  findRequest(request: ResourceCapture): ResourceSummary | null {
    this.research.getProject(request.projectId);
    const row = this.db.prepare('SELECT * FROM research_resource_observations WHERE project_id=? AND request_id=?')
      .get(request.projectId, request.requestId) as ResourceRow | undefined;
    if (row === undefined) return null;
    const snapshot = this.parse(row);
    if (JSON.stringify(snapshot.request) !== JSON.stringify(request)) throw new Error('research_resource_request_conflict');
    return resourceSummary(snapshot);
  }

  save(input: ResourceObservation): ResourceSummary {
    const snapshot = this.parse({id: input.id, project_id: input.projectId, request_id: input.request.requestId,
      doi: input.request.doi, snapshot_json: JSON.stringify(input)});
    return this.db.transaction(() => {
      const replay = this.findRequest(snapshot.request);
      if (replay !== null) return replay;
      this.requireCaptureScope(snapshot.projectId);
      this.db.prepare(`INSERT INTO research_resource_observations
        (id,project_id,request_id,doi,snapshot_json,created_at) VALUES (?,?,?,?,?,?)`)
        .run(snapshot.id, snapshot.projectId, snapshot.request.requestId, snapshot.request.doi, JSON.stringify(snapshot), snapshot.queriedAt);
      return resourceSummary(snapshot);
    })();
  }

  get(projectId: string, resourceId: string): ResourceObservation {
    this.research.getProject(projectId);
    const row = this.db.prepare('SELECT * FROM research_resource_observations WHERE id=? AND project_id=?')
      .get(resourceId, projectId) as ResourceRow | undefined;
    if (row === undefined) throw new Error('research_resource_not_found');
    return this.parse(row);
  }

  history(input: z.infer<typeof resourceHistorySchema>): z.infer<typeof resourceHistoryResultSchema> {
    const request = resourceHistorySchema.parse(input);
    this.research.getProject(request.projectId);
    const doi = request.doi === null ? null : normalizeResearchDoi(request.doi);
    const where = doi === null ? 'project_id=?' : 'project_id=? AND doi=?';
    const args = doi === null ? [request.projectId] : [request.projectId, doi];
    const total = this.db.prepare(`SELECT COUNT(*) FROM research_resource_observations WHERE ${where}`)
      .pluck().get(...args) as number;
    const records = (this.db.prepare(`SELECT * FROM research_resource_observations
      WHERE ${where} ORDER BY rowid DESC LIMIT ? OFFSET ?`).all(...args, request.limit, request.offset) as ResourceRow[])
      .map(row => resourceSummary(this.parse(row)));
    return {records, total, nextOffset: request.offset + records.length < total ? request.offset + records.length : null};
  }

  read(input: z.infer<typeof resourceReadSchema>): z.infer<typeof resourceReadResultSchema> {
    const request = resourceReadSchema.parse(input);
    const snapshot = this.get(request.projectId, request.resourceId);
    const relations = snapshot.metadata?.relatedIdentifiers ?? null;
    const page = relations === null ? [] : relations.slice(request.offset, request.offset + request.limit);
    return {resource: resourceSummary(snapshot), relatedIdentifiers: page, total: relations === null ? null : relations.length,
      nextOffset: relations !== null && request.offset + page.length < relations.length ? request.offset + page.length : null};
  }

  private parse(row: ResourceRow): ResourceObservation {
    const value = resourceObservationSchema.parse(JSON.parse(row.snapshot_json));
    const {contentHash, ...body} = value;
    if (resourceContentHash(body) !== contentHash || value.id !== row.id || value.projectId !== row.project_id ||
      value.projectId !== value.request.projectId || value.request.requestId !== row.request_id ||
      value.request.doi !== row.doi || normalizeResearchDoi(value.request.doi) !== value.request.doi ||
      value.endpoint !== dataciteEndpoint(value.request.doi) || value.governance.host !== 'api.datacite.org' ||
      value.status === 'ok' && (value.metadata.doi !== value.request.doi || value.fetchedAt === null || value.responseHash === null)) {
      throw new Error('research_resource_snapshot_invalid');
    }
    return value;
  }
}
