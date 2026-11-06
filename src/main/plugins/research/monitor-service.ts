import type {z} from 'zod';
import {
  monitorSaveSchema, monitorControlSchema, monitorCheckRequestSchema, monitorCancelSchema,
  type ResearchMonitor, type MonitorCheck, type MonitorSource
} from '../../../shared/schemas/research-monitors';
import {BackgroundDeadlines} from '../../services/background-deadlines';
import {withLiteratureContext} from '../../services/literature-context';
import {requireResearchHuman} from '../../services/research-human-context';
import {monitorUpdateEndpoint, readMonitorUpdates, searchMonitorMaterial} from './monitor-provider-adapter';
import type {LiteratureSearchService} from './literature-service';
import type {LiteratureImportService} from './literature-import-service';
import {ResearchMonitorRepository} from './monitor-repository';

type Job = {check: MonitorCheck; controller: AbortController; pending: Promise<MonitorCheck>};
export class ResearchMonitorService {
  private readonly deadlines = new BackgroundDeadlines();
  private readonly jobs = new Map<string, Job>();
  private closed = false;
  private started = false;
  constructor(private readonly repository: ResearchMonitorRepository,
    private readonly imports: Pick<LiteratureImportService, 'search'>,
    private readonly transport: Pick<LiteratureSearchService, 'readProviderJson'>,
    private readonly reportError: (error: unknown) => void,
    private readonly now: () => string = () => new Date().toISOString()) {}

  start(): void {
    this.repository.recover();
    this.started = true;
    this.reconcile();
  }
  reconcile(): void {
    if (!this.started || this.closed) return;
    this.deadlines.clear();
    for (const monitor of this.repository.schedulable()) {
      if (this.jobs.has(monitor.id)) continue;
      this.deadlines.schedule(monitor.id, monitor.nextCheckAt, () => {
        void this.run(monitor, `scheduled:${monitor.queryVersion}:${monitor.nextCheckAt}`, 'scheduled', monitor.nextCheckAt)
          .catch(error => {
            this.repository.suspend(monitor, error);
            this.reportError(error);
          }).finally(() => this.reconcile()).catch(this.reportError);
      });
    }
  }
  save(input: z.infer<typeof monitorSaveSchema>): ResearchMonitor {
    this.requireOpen();
    const saved = this.repository.save(input);
    this.abortObsolete(saved.projectId, saved.id);
    this.reconcile();
    return saved;
  }
  control(input: z.infer<typeof monitorControlSchema>): ResearchMonitor {
    this.requireOpen();
    const saved = this.repository.control(input);
    this.abortObsolete(saved.projectId, saved.id);
    this.reconcile();
    return saved;
  }
  async check(input: z.infer<typeof monitorCheckRequestSchema>): Promise<MonitorCheck> {
    this.requireOpen();
    const request = monitorCheckRequestSchema.parse(input);
    requireResearchHuman('research.monitors.check', request.projectId);
    const previous = this.repository.findCheck(request.projectId, request.monitorId, `manual:${request.requestId}`);
    if (previous !== null) {
      if (previous.controlRevision !== request.expectedRevision) throw new Error('research_monitor_request_conflict');
      return this.jobs.get(request.monitorId)?.check.id === previous.id ? this.jobs.get(request.monitorId)!.pending : previous;
    }
    const monitor = this.repository.get(request.projectId, request.monitorId);
    if (monitor.revision !== request.expectedRevision) throw new Error('research_monitor_version_changed');
    try {return await this.run(monitor, `manual:${request.requestId}`, 'manual', null);}
    finally {this.reconcile();}
  }
  cancel(input: z.infer<typeof monitorCancelSchema>): {cancelled: boolean} {
    const request = monitorCancelSchema.parse(input);
    requireResearchHuman('research.monitors.cancel', request.projectId);
    this.repository.check(request.projectId, request.monitorId, request.checkId);
    const job = this.jobs.get(request.monitorId);
    if (job === undefined || job.check.id !== request.checkId) return {cancelled: false};
    job.controller.abort(new Error('research_monitor_cancelled'));
    return {cancelled: true};
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    this.deadlines.clear();
    for (const job of this.jobs.values()) job.controller.abort(new Error('research_monitor_interrupted'));
    const settled = await Promise.allSettled([...this.jobs.values()].map(job => job.pending));
    const failures = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length > 0) throw new AggregateError(failures.map(result => result.reason), 'research_monitor_shutdown_failed');
  }
  private requireOpen(): void {
    if (this.closed) throw new Error('research_monitor_service_closed');
  }
  private abortObsolete(projectId: string, monitorId: string): void {
    const current = this.repository.get(projectId, monitorId), job = this.jobs.get(monitorId);
    if (job !== undefined && job.check.controlRevision !== current.revision)
      job.controller.abort(new Error('research_monitor_version_changed'));
  }
  private async run(monitor: ResearchMonitor, key: string, trigger: MonitorCheck['trigger'], scheduledAt: string | null): Promise<MonitorCheck> {
    this.requireOpen();
    const check = this.repository.begin(monitor, key, trigger, scheduledAt);
    if (check.status !== 'running') return check;
    const active = this.jobs.get(monitor.id);
    if (active !== undefined) {
      if (active.check.id !== check.id) throw new Error('research_monitor_check_busy');
      return active.pending;
    }
    const controller = new AbortController();
    const pending = this.execute(monitor, check, controller.signal);
    this.jobs.set(monitor.id, {check, controller, pending});
    try {return await pending;}
    finally {this.jobs.delete(monitor.id);}
  }
  private async execute(monitor: ResearchMonitor, check: MonitorCheck, signal: AbortSignal): Promise<MonitorCheck> {
    const sources: MonitorSource[] = [];
    const assertActive = (): void => {
      this.requireOpen();
      signal.throwIfAborted();
      this.repository.requireActive(monitor);
    };
    try {
      const version = this.repository.version(monitor.projectId, monitor.id, monitor.queryVersion);
      if (version.query.kind === 'search') {
        const query = version.query.search;
        for (const source of query.sources) {
          assertActive();
          const search = await withLiteratureContext({
            owner: `monitor:${monitor.id}`, projectId: monitor.projectId, signal, assertActive
          }, () => this.imports.search({...query,
            sources: [source], projectId: monitor.projectId}));
          const receipt = search.sources[0]!;
          if (search.sources.length !== 1 || receipt.source !== source) throw new Error('research_monitor_source_mismatch');
          sources.push({source, status: search.status === 'complete' ? 'ok' : search.status === 'partial' ? 'partial' : 'error',
            errorCode: receipt.errorCode, retryAfterMs: receipt.retryAfterMs,
            endpoint: null, executionId: search.executionId, fetchedAt: null,
            responseHash: null, cache: null, requests: receipt.requests, governance: receipt.governance,
            search, material: searchMonitorMaterial(search)});
        }
      } else {
        for (const source of ['openalex', 'crossref'] as const) {
          assertActive();
          const offset = this.repository.checkpoint(monitor, source).offset;
          const endpoint = monitorUpdateEndpoint(source, version.query.doi, offset);
          const doi = version.query.doi;
          const result = await this.transport.readProviderJson({
            source, url: endpoint, projectId: monitor.projectId, timeoutMs: 15000
          }, payload => readMonitorUpdates(source, doi, offset, payload), signal);
          const {value: material, ...receipt} = result;
          sources.push({source, ...receipt, status: result.status === 'ok' ? 'ok' : 'error',
            endpoint, executionId: null, search: null, material});
        }
      }
      assertActive();
      const ok = sources.filter(source => source.status === 'ok').length;
      const observed = sources.some(source => source.status !== 'error');
      return this.repository.finish(monitor, {...check, sources, status: ok === sources.length ? 'complete' : observed ? 'partial' : 'failed',
        errorCode: null, finishedAt: this.now()});
    } catch (error) {
      const code = signal.aborted ? signal.reason instanceof Error ? signal.reason.message : 'research_monitor_cancelled' :
        error instanceof Error && error.message.startsWith('research_') ? error.message : 'research_monitor_check_failed';
      try {
        return this.repository.finish(monitor, {...check, sources, finishedAt: this.now(), alertCount: 0,
          status: code === 'research_monitor_cancelled' ? 'cancelled' : code === 'research_monitor_interrupted' ||
            code === 'research_monitor_service_closed' || code === 'research_monitor_version_changed' ? 'interrupted' : 'failed',
          errorCode: code});
      } catch (persistenceError) {
        throw new AggregateError([error, persistenceError], 'research_monitor_record_failed');
      }
    }
  }
}
