import type {PaperAcquisitionJob, ChangePaperAcquisition, ListPaperAcquisition, ListPaperAcquisitionResult} from '../../../shared/schemas/literature-acquisition';
import {assertLiteratureActive, literatureContext} from '../../services/literature-context';
import {mainResourceActivity} from '../../services/resource-activity';
import {LiteratureAcquisitionRepository, type AcquisitionClaim, type AcquisitionOutcome} from './literature-acquisition-repository';

export type AcquisitionStep = (job: AcquisitionClaim, signal: AbortSignal, requireCurrent: () => void) => Promise<AcquisitionOutcome>;

/** Each claim advances one durable stage; workers never inherit an Agent run's lifetime. */
export class LiteratureAcquisitionService {
  private processor: AcquisitionStep | null = null;
  private readonly active = new Map<string, {libraryItemId: string; controller: AbortController; run: Promise<void>}>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private reconcile: (() => void) | undefined;
  constructor(readonly repository: LiteratureAcquisitionRepository, private readonly onError: () => void = () => {},
    private readonly concurrency = 3) {}

  start(processor: AcquisitionStep, reconcile?: () => void): void {
    if (this.closed || this.processor !== null) throw new Error('literature_acquisition_worker_unavailable');
    this.repository.recover();
    this.processor = processor;
    this.reconcile = reconcile;
    this.wake();
  }

  list(request: ListPaperAcquisition): ListPaperAcquisitionResult {
    const context = literatureContext();
    assertLiteratureActive(context);
    this.reconcile?.();
    this.wake();
    return this.repository.list(context, request);
  }

  change(request: ChangePaperAcquisition, action: 'retry' | 'cancel'): PaperAcquisitionJob {
    const context = literatureContext();
    assertLiteratureActive(context);
    const job = this.repository.getScoped(context, request.destination, request.jobId);
    this.repository.change(job, request.generation, action, request.replacementDocumentId);
    if (action === 'cancel') this.active.get(job.id)?.controller.abort();
    this.wake();
    return this.repository.getScoped(context, request.destination, request.jobId);
  }

  /** Called when the lazy document provider becomes available after startup. */
  resumeDocumentPipeline(): void {
    this.repository.resumeBlockedImports();
    this.repository.resumeBlockedIndexes();
    this.repository.resumeBlockedWiki();
    this.wake();
  }

  wake(): void {
    if (this.closed || this.processor === null) return;
    clearTimeout(this.timer);
    // Import and other source owners may request a wake inside their transaction.
    this.timer = setTimeout(() => {
      this.timer = undefined;
      try { this.drain(); }
      catch { this.onError(); }
    }, 0);
    this.timer.unref();
  }

  async releaseItem(libraryItemId: string): Promise<void> {
    const tasks = [...this.active.values()].filter(task => task.libraryItemId === libraryItemId);
    for (const task of tasks) task.controller.abort();
    await Promise.all(tasks.map(task => task.run));
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    for (const task of this.active.values()) task.controller.abort();
    await Promise.all([...this.active.values()].map(task => task.run));
  }

  private drain(): void {
    const processor = this.processor;
    if (this.closed || processor === null) return;
    this.reconcile?.();
    this.repository.resumeBlockedIndexes();
    while (this.active.size < this.concurrency) {
      const job = this.repository.claim();
      if (job === null) {
        const retry = this.repository.nextRetryAt();
        if (retry) {
          const delay = Date.parse(retry) - Date.parse(this.repository.now());
          this.timer = setTimeout(() => this.wake(), Math.max(1, Math.min(delay, 2_147_483_647)));
          this.timer.unref();
        }
        return;
      }
      const controller = new AbortController();
      const run = Promise.resolve().then(() => this.advance(job, controller.signal, processor))
        .catch(() => this.onError()).finally(() => { this.active.delete(job.id); this.wake(); });
      this.active.set(job.id, {libraryItemId: job.libraryItemId, controller, run});
    }
  }

  private async advance(job: AcquisitionClaim, signal: AbortSignal, processor: AcquisitionStep): Promise<void> {
    const requireCurrent = (): void => {
      signal.throwIfAborted();
      this.repository.requireCurrent(job);
    };
    const end = mainResourceActivity.begin('research');
    try {
      let outcome: AcquisitionOutcome;
      try {
        requireCurrent();
        outcome = await processor(job, signal, requireCurrent);
        requireCurrent();
      } catch {
        // Expected stage errors are returned as typed outcomes. Never surface provider bodies or local paths.
        outcome = this.closed ? {status: 'queued'} : {status: 'failed', errorCode: 'literature_acquisition_stage_failed'};
      }
      this.repository.complete(job, outcome);
    } finally { end(); }
  }
}
