import {randomUUID} from 'node:crypto';
import type {z} from 'zod';
import {openReviewCaptureSchema, openReviewCancelSchema, openReviewObservationSchema, type OpenReviewCapture, type OpenReviewSummary} from '../../../shared/schemas/research-openreview';
import {openReviewEndpoint, readOpenReviewPage} from './openreview-adapter';
import type {LiteratureSearchService} from './literature-service';
import {OpenReviewRepository} from './openreview-repository';
import {resourceContentHash} from './resource-repository';

type Job = {request: OpenReviewCapture; controller: AbortController; pending: Promise<OpenReviewSummary>};
export class OpenReviewService {
  private readonly jobs = new Map<string, Job>();
  private closed = false;
  constructor(private readonly repository: OpenReviewRepository,
    private readonly transport: Pick<LiteratureSearchService, 'readProviderJson'>,
    private readonly now: () => string = () => new Date().toISOString()) {}

  async capture(input: OpenReviewCapture): Promise<OpenReviewSummary> {
    if (this.closed) throw new Error('research_openreview_service_closed');
    const request = openReviewCaptureSchema.parse(input);
    const saved = this.repository.findRequest(request);
    if (saved !== null) return saved;
    const key = JSON.stringify([request.projectId, request.requestId]);
    const active = this.jobs.get(key);
    if (active !== undefined) {
      if (JSON.stringify(active.request) !== JSON.stringify(request)) throw new Error('research_openreview_request_conflict');
      return active.pending;
    }
    this.repository.requireCaptureScope(request.projectId);
    const controller = new AbortController();
    const pending = this.execute(request, controller.signal);
    this.jobs.set(key, {request, controller, pending});
    try {return await pending;}
    finally {this.jobs.delete(key);}
  }

  cancel(input: z.infer<typeof openReviewCancelSchema>): {cancelled: boolean} {
    const request = openReviewCancelSchema.parse(input);
    const job = this.jobs.get(JSON.stringify([request.projectId, request.requestId]));
    if (job === undefined) return {cancelled: false};
    job.controller.abort(new Error('research_openreview_capture_cancelled'));
    return {cancelled: true};
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const job of this.jobs.values()) job.controller.abort(new Error('research_openreview_service_closed'));
    await Promise.allSettled([...this.jobs.values()].map(job => job.pending));
  }

  private async execute(request: OpenReviewCapture, signal: AbortSignal): Promise<OpenReviewSummary> {
    const queriedAt = this.now();
    const endpoint = openReviewEndpoint(request.query);
    const result = await this.transport.readProviderJson({
      source: 'openreview', url: endpoint, projectId: request.projectId, timeoutMs: 15000
    }, payload => readOpenReviewPage(request.query, payload), signal);
    signal.throwIfAborted();
    if (this.closed) throw new Error('research_openreview_service_closed');
    const {value: page, ...receipt} = result;
    const snapshot = openReviewObservationSchema.parse({
      id: `openreview_${randomUUID()}`, projectId: request.projectId, request, provider: 'openreview',
      contract: 'openreview-api2-public-notes-edits-v1', queriedAt, endpoint, ...receipt, page, contentHash: '0'.repeat(64)
    });
    const {contentHash: _hash, ...body} = snapshot;
    snapshot.contentHash = resourceContentHash(body);
    return this.repository.save(snapshot);
  }
}
