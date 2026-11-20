import {randomUUID} from 'node:crypto';
import type {z} from 'zod';
import {hfCaptureSchema, hfCancelSchema, hfObservationSchema, type HfCapture, type HfSummary} from '../../../shared/schemas/research-huggingface';
import {huggingFaceEndpoint, readHuggingFaceMetadata} from './huggingface-adapter';
import type {LiteratureSearchService} from './literature-service';
import {HuggingFaceRepository} from './huggingface-repository';
import {resourceContentHash} from './resource-repository';

type Job = {request: HfCapture; controller: AbortController; pending: Promise<HfSummary>};
export class HuggingFaceService {
  private readonly jobs = new Map<string, Job>();
  private closed = false;
  constructor(private readonly repository: HuggingFaceRepository,
    private readonly transport: Pick<LiteratureSearchService, 'readProviderJson'>,
    private readonly now: () => string = () => new Date().toISOString()) {}

  async capture(input: HfCapture): Promise<HfSummary> {
    if (this.closed) throw new Error('research_hf_service_closed');
    const request = hfCaptureSchema.parse(input);
    const saved = this.repository.findRequest(request);
    if (saved !== null) return saved;
    const key = JSON.stringify([request.projectId, request.requestId]);
    const active = this.jobs.get(key);
    if (active !== undefined) {
      if (JSON.stringify(active.request) !== JSON.stringify(request)) throw new Error('research_hf_request_conflict');
      return active.pending;
    }
    this.repository.requireCaptureScope(request.projectId);
    const controller = new AbortController();
    const pending = this.execute(request, controller.signal);
    this.jobs.set(key, {request, controller, pending});
    try {return await pending;}
    finally {this.jobs.delete(key);}
  }

  cancel(input: z.infer<typeof hfCancelSchema>): {cancelled: boolean} {
    const request = hfCancelSchema.parse(input);
    const job = this.jobs.get(JSON.stringify([request.projectId, request.requestId]));
    if (job === undefined) return {cancelled: false};
    job.controller.abort(new Error('research_hf_capture_cancelled'));
    return {cancelled: true};
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const job of this.jobs.values()) job.controller.abort(new Error('research_hf_service_closed'));
    await Promise.allSettled([...this.jobs.values()].map(job => job.pending));
  }

  private async execute(request: HfCapture, signal: AbortSignal): Promise<HfSummary> {
    const queriedAt = this.now();
    const endpoint = huggingFaceEndpoint(request);
    const result = await this.transport.readProviderJson({
      source: 'huggingface', url: endpoint, projectId: request.projectId, timeoutMs: 15000
    }, payload => readHuggingFaceMetadata(request, payload), signal);
    signal.throwIfAborted();
    if (this.closed) throw new Error('research_hf_service_closed');
    const {value: metadata, ...receipt} = result;
    const snapshot = hfObservationSchema.parse({
      id: `hf_${randomUUID()}`, projectId: request.projectId, request, provider: 'huggingface',
      contract: 'hf-revision-info-blobs-v1', queriedAt, endpoint, ...receipt, metadata, contentHash: '0'.repeat(64)
    });
    const {contentHash: _hash, ...body} = snapshot;
    snapshot.contentHash = resourceContentHash(body);
    return this.repository.save(snapshot);
  }
}
