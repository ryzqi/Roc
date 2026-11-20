import {randomUUID} from 'node:crypto';
import type {z} from 'zod';
import {resourceCaptureSchema, resourceCancelSchema, resourceObservationSchema,
  type ResourceCapture, type ResourceSummary} from '../../../shared/schemas/research-resources';
import {normalizeResearchDoi} from './literature-identity';
import {dataciteEndpoint, readDataCiteMetadata} from './datacite-adapter';
import type {LiteratureSearchService} from './literature-service';
import {ResearchResourceRepository, resourceContentHash} from './resource-repository';

type Job = {request: ResourceCapture; controller: AbortController; pending: Promise<ResourceSummary>};
export class ResearchResourceService {
  private readonly jobs = new Map<string, Job>();
  private closed = false;
  constructor(private readonly repository: ResearchResourceRepository,
    private readonly transport: Pick<LiteratureSearchService, 'readProviderJson'>,
    private readonly now: () => string = () => new Date().toISOString()) {}

  async capture(input: ResourceCapture): Promise<ResourceSummary> {
    if (this.closed) throw new Error('research_resource_service_closed');
    const parsed = resourceCaptureSchema.parse(input);
    const request = {...parsed, doi: normalizeResearchDoi(parsed.doi)};
    const saved = this.repository.findRequest(request);
    if (saved !== null) return saved;
    const key = JSON.stringify([request.projectId, request.requestId]);
    const active = this.jobs.get(key);
    if (active !== undefined) {
      if (JSON.stringify(active.request) !== JSON.stringify(request)) throw new Error('research_resource_request_conflict');
      return active.pending;
    }
    this.repository.requireCaptureScope(request.projectId);
    const controller = new AbortController();
    const pending = this.execute(request, controller.signal);
    this.jobs.set(key, {request, controller, pending});
    try {return await pending;}
    finally {this.jobs.delete(key);}
  }

  cancel(input: z.infer<typeof resourceCancelSchema>): {cancelled: boolean} {
    const request = resourceCancelSchema.parse(input);
    const job = this.jobs.get(JSON.stringify([request.projectId, request.requestId]));
    if (job === undefined) return {cancelled: false};
    job.controller.abort(new Error('research_resource_capture_cancelled'));
    return {cancelled: true};
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const job of this.jobs.values()) job.controller.abort(new Error('research_resource_service_closed'));
    await Promise.allSettled([...this.jobs.values()].map(job => job.pending));
  }

  private async execute(request: ResourceCapture, signal: AbortSignal): Promise<ResourceSummary> {
    const queriedAt = this.now();
    const endpoint = dataciteEndpoint(request.doi);
    const result = await this.transport.readProviderJson({
      source: 'datacite', url: endpoint, projectId: request.projectId, timeoutMs: 15000
    }, payload => readDataCiteMetadata(request.doi, payload), signal);
    signal.throwIfAborted();
    if (this.closed) throw new Error('research_resource_service_closed');
    const {value: metadata, ...receipt} = result;
    const snapshot = resourceObservationSchema.parse({
      id: `resource_${randomUUID()}`, projectId: request.projectId, request, provider: 'datacite',
      contract: 'datacite-jsonapi-v2/schema-4.7', queriedAt, endpoint, ...receipt, metadata, contentHash: '0'.repeat(64)
    });
    const {contentHash: _hash, ...body} = snapshot;
    snapshot.contentHash = resourceContentHash(body);
    return this.repository.save(snapshot);
  }
}
