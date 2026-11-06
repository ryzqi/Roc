import type {Database} from 'better-sqlite3';
import type {z} from 'zod';
import {
  hfObservationSchema, hfHistorySchema, hfReadSchema, type HfCapture, type HfObservation, type HfSummary,
  type hfHistoryResultSchema, type hfReadResultSchema
} from '../../../shared/schemas/research-huggingface';
import {resourceContentHash} from './resource-repository';
import {huggingFaceEndpoint} from './huggingface-adapter';
import type {ResearchRepository} from './repository';

type HfRow = {
  id: string; project_id: string; request_id: string; kind: string; repo: string; revision: string; snapshot_json: string
};
export function huggingFaceSummary(value: HfObservation): HfSummary {
  const {metadata, ...body} = value;
  if (metadata === null) return {...body, metadata: null, fileCount: null};
  const {files, ...summary} = metadata;
  return {...body, metadata: summary, fileCount: files.length};
}

export class HuggingFaceRepository {
  constructor(private readonly db: Database, private readonly research: ResearchRepository) {}

  requireCaptureScope(projectId: string): void {
    if (this.research.getProject(projectId).status === 'archived') throw new Error('research_project_archived');
  }

  findRequest(request: HfCapture): HfSummary | null {
    this.research.getProject(request.projectId);
    const row = this.db.prepare('SELECT * FROM research_hf_observations WHERE project_id=? AND request_id=?')
      .get(request.projectId, request.requestId) as HfRow | undefined;
    if (row === undefined) return null;
    const snapshot = this.parse(row);
    if (JSON.stringify(snapshot.request) !== JSON.stringify(request)) throw new Error('research_hf_request_conflict');
    return huggingFaceSummary(snapshot);
  }

  save(input: HfObservation): HfSummary {
    const snapshot = this.parse({id: input.id, project_id: input.projectId, request_id: input.request.requestId,
      kind: input.request.kind, repo: input.request.repo, revision: input.request.revision, snapshot_json: JSON.stringify(input)});
    return this.db.transaction(() => {
      const replay = this.findRequest(snapshot.request);
      if (replay !== null) return replay;
      this.requireCaptureScope(snapshot.projectId);
      this.db.prepare(`INSERT INTO research_hf_observations
        (id,project_id,request_id,kind,repo,revision,snapshot_json,created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(snapshot.id, snapshot.projectId, snapshot.request.requestId, snapshot.request.kind,
          snapshot.request.repo, snapshot.request.revision, JSON.stringify(snapshot), snapshot.queriedAt);
      return huggingFaceSummary(snapshot);
    })();
  }

  get(projectId: string, observationId: string): HfObservation {
    this.research.getProject(projectId);
    const row = this.db.prepare('SELECT * FROM research_hf_observations WHERE id=? AND project_id=?')
      .get(observationId, projectId) as HfRow | undefined;
    if (row === undefined) throw new Error('research_hf_not_found');
    return this.parse(row);
  }

  history(input: z.infer<typeof hfHistorySchema>): z.infer<typeof hfHistoryResultSchema> {
    const request = hfHistorySchema.parse(input);
    this.research.getProject(request.projectId);
    const where = request.identity === null ? 'project_id=?' : 'project_id=? AND kind=? AND repo=? AND revision=?';
    const args = request.identity === null ? [request.projectId] :
      [request.projectId, request.identity.kind, request.identity.repo, request.identity.revision];
    const total = this.db.prepare(`SELECT COUNT(*) FROM research_hf_observations WHERE ${where}`).pluck().get(...args) as number;
    const records = (this.db.prepare(`SELECT * FROM research_hf_observations WHERE ${where}
      ORDER BY rowid DESC LIMIT ? OFFSET ?`).all(...args, request.limit, request.offset) as HfRow[]).map(row => huggingFaceSummary(this.parse(row)));
    return {records, total, nextOffset: request.offset + records.length < total ? request.offset + records.length : null};
  }

  read(input: z.infer<typeof hfReadSchema>): z.infer<typeof hfReadResultSchema> {
    const request = hfReadSchema.parse(input);
    const snapshot = this.get(request.projectId, request.observationId);
    const files = snapshot.metadata?.files ?? null;
    const page = files === null ? [] : files.slice(request.offset, request.offset + request.limit);
    return {observation: huggingFaceSummary(snapshot), files: page, total: files === null ? null : files.length,
      nextOffset: files !== null && request.offset + page.length < files.length ? request.offset + page.length : null};
  }

  private parse(row: HfRow): HfObservation {
    const value = hfObservationSchema.parse(JSON.parse(row.snapshot_json));
    const {contentHash, ...body} = value;
    const request = value.request;
    if (resourceContentHash(body) !== contentHash || value.id !== row.id || value.projectId !== row.project_id ||
      value.projectId !== request.projectId || request.requestId !== row.request_id || request.kind !== row.kind ||
      request.repo !== row.repo || request.revision !== row.revision || value.endpoint !== huggingFaceEndpoint(request) ||
      value.governance.host !== 'huggingface.co' || value.status === 'ok' &&
        (value.metadata.kind !== request.kind || value.metadata.repo !== request.repo || value.metadata.revision !== request.revision ||
          value.fetchedAt === null || value.responseHash === null)) throw new Error('research_hf_snapshot_invalid');
    return value;
  }
}
