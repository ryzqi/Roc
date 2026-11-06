import {randomUUID} from 'node:crypto';
import type {z} from 'zod';
import {
  scholarlyCaptureSchema, scholarlyCancelSchema, scholarlySnapshotSchema,
  type ScholarlyCapture, type ScholarlySnapshotSummary, type ScholarlySourceSummary
} from '../../../shared/schemas/research-scholarly-relations';
import type {LiteratureSearchService} from './literature-service';
import {readScholarlyMaterial, scholarlyEndpoint} from './scholarly-provider-adapters';
import {ScholarlyRelationsRepository, scholarlyContentHash} from './scholarly-relations-repository';

type Job = {request: ScholarlyCapture; controller: AbortController; pending: Promise<ScholarlySnapshotSummary>};

export class ScholarlyRelationsService {
  private readonly jobs = new Map<string, Job>();
  private closed = false;
  constructor(private readonly repository: ScholarlyRelationsRepository,
    private readonly literature: Pick<LiteratureSearchService, 'readProviderJson'>,
    private readonly now: () => string = () => new Date().toISOString()) {}

  async capture(input: ScholarlyCapture): Promise<ScholarlySnapshotSummary> {
    if (this.closed) throw new Error('scholarly_service_closed');
    const request = scholarlyCaptureSchema.parse(input);
    const replay = this.repository.findRequest(request);
    if (replay !== null) return replay;
    const key = JSON.stringify([request.projectId, request.requestId]);
    const active = this.jobs.get(key);
    if (active !== undefined) {
      if (JSON.stringify(active.request) !== JSON.stringify(request)) throw new Error('scholarly_request_conflict');
      return active.pending;
    }
    const doi = this.repository.requireCaptureScope(request);
    const controller = new AbortController();
    const pending = this.execute(request, doi, controller.signal);
    this.jobs.set(key, {request, controller, pending});
    try {return await pending;}
    finally {this.jobs.delete(key);}
  }

  cancel(input: z.infer<typeof scholarlyCancelSchema>): {cancelled: boolean} {
    const request = scholarlyCancelSchema.parse(input);
    const job = this.jobs.get(JSON.stringify([request.projectId, request.requestId]));
    if (job === undefined) return {cancelled: false};
    if (job.request.itemId !== request.itemId) throw new Error('scholarly_item_project_mismatch');
    job.controller.abort(new Error('scholarly_capture_cancelled'));
    return {cancelled: true};
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const job of this.jobs.values()) job.controller.abort(new Error('scholarly_service_closed'));
    await Promise.allSettled([...this.jobs.values()].map(job => job.pending));
  }

  private async execute(request: ScholarlyCapture, doi: string, signal: AbortSignal): Promise<ScholarlySnapshotSummary> {
    const queriedAt = this.now();
    const results = await Promise.allSettled(request.sources.map(async source => {
      const endpoint = scholarlyEndpoint(source, doi, request.offset, request.limit);
      const result = await this.literature.readProviderJson({source, url: endpoint, projectId: request.projectId, timeoutMs: 15_000},
        payload => readScholarlyMaterial(source, doi, request.offset, request.limit, payload), signal);
      const {value, ...receipt} = result;
      const summary: ScholarlySourceSummary = {
        source, endpoint, ...receipt, relationCount: value === null ? 0 : value.relations.length,
        unmappedReferences: value === null ? null : value.unmappedReferences,
        referencesReported: value === null ? null : value.referencesReported,
        relationsReported: value === null ? null : value.relationsReported,
        updatesReported: value === null ? null : value.updatesReported,
        retraction: value === null ? 'unknown' : value.retraction, nextOffset: value === null ? null : value.nextOffset
      };
      return {summary, relations: value === null ? [] : value.relations.map(relation => ({source, relation}))};
    }));
    signal.throwIfAborted();
    if (this.closed) throw new Error('scholarly_service_closed');
    const outcomes = results.map(result => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });
    const sources = outcomes.map(value => value.summary);
    const ok = sources.filter(source => source.status === 'ok').length;
    const body = {id: `scholarly_${randomUUID()}`, projectId: request.projectId, itemId: request.itemId,
      doi, itemRevision: request.expectedRevision, request, queriedAt,
      status: ok === sources.length ? 'complete' : ok === 0 ? 'failed' : 'partial',
      sources, relations: outcomes.flatMap(value => value.relations)};
    const snapshot = scholarlySnapshotSchema.parse({...body, contentHash: '0'.repeat(64)});
    const {contentHash: _hash, ...canonical} = snapshot;
    snapshot.contentHash = scholarlyContentHash(canonical);
    return this.repository.save(snapshot);
  }
}
