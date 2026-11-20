import type { ResearchWorkflowSnapshot, ResearchWorkflowTransitionRequest } from '../../../shared/types';
import type { CapabilityDescriptor, RocPluginContext, RocPluginHealth } from '../../kernel/types';
import { ResearchCapabilityProvider } from './capability-provider';
import type { ResearchExportService } from './export-service';

type ShutdownService = { shutdown(): Promise<void> } | null;
type RootServices = Parameters<typeof shutdownResearchPlugin>[0];
const providerShutdownOwners = {
  prose: 'prose', scholarly: 'scholarly', openreview: 'openreview',
  huggingface: 'huggingface', 'huggingface-downloads': 'huggingfaceDownloads',
  resources: 'resources', monitors: 'monitors', documents: 'documents'
} as const satisfies Record<string, keyof RootServices>;
type ProviderDomain = keyof typeof providerShutdownOwners | 'diagram' | 'reading' | 'reference-check' | 'systematic-review';

/** One owner for eager services, lazy providers and the plugin's startup/shutdown fence. */
export class ResearchPluginLifecycle {
  private readonly providers: ResearchCapabilityProvider<unknown>[] = [];
  private readonly services: RootServices = {
    monitors: null, zenodo: null, literature: null, scholarly: null, resources: null,
    openreview: null, huggingface: null, huggingfaceDownloads: null, zotero: null,
    literatureImports: null, productionInputs: null, exports: null, figures: null,
    experiments: null, pythonEnvironments: null, indexer: null, embeddings: null,
    stageRuntime: null, reviewSearch: null, templates: null, documents: null, library: null, prose: null
  };
  private backgroundServices: readonly ShutdownService[] = [];
  private readonly auxiliaryServices = new Map<'reading' | 'diagram', ShutdownService>();
  private initialized = false;
  private closing = false;
  private initializePending: Promise<void> | null = null;

  own<T extends NonNullable<ShutdownService>>(name: keyof RootServices, service: T): T {
    if (this.services[name] !== null) throw new Error('research_service_already_owned');
    this.services[name] = service;
    return service;
  }

  ownBackgroundServices(services: readonly ShutdownService[]): void {
    this.backgroundServices = [...new Set([...this.backgroundServices, ...services])];
  }

  provide<T>(
    context: RocPluginContext,
    domain: ProviderDomain,
    descriptors: readonly CapabilityDescriptor[],
    initialize: (child: RocPluginContext, signal: AbortSignal) => T | Promise<T>,
    cleanup?: () => Promise<void>
  ): ResearchCapabilityProvider<T> {
    // Provider.close fences and awaits initialization; ready service cleanup stays
    // in the original plugin order, after parent/provider fencing.
    if (cleanup !== undefined) {
      const service = { shutdown: cleanup };
      if (domain === 'reading' || domain === 'diagram') {
        this.auxiliaryServices.set(domain, service);
      } else if (domain !== 'reference-check' && domain !== 'systematic-review') {
        this.own(providerShutdownOwners[domain], service);
      }
    }
    const provider = new ResearchCapabilityProvider(context, domain, descriptors, initialize, cleanup);
    this.providers.push(provider);
    return provider;
  }

  initialize(work: () => Promise<void>): Promise<void> {
    if (this.closing) return Promise.reject(new Error('research_capability_provider_closed'));
    if (this.initializePending !== null) return this.initializePending;
    this.initializePending = (async () => {
      await work();
      if (process.env.ROC_PERF_RESEARCH_LAZY_INIT === '0') {
        for (const provider of this.providers) await provider.get();
      }
      if (this.closing) throw new Error('research_capability_provider_closed');
      this.initialized = true;
    })();
    return this.initializePending;
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    const errors: unknown[] = [];
    try { await this.initializePending; } catch { /* The loader retains the initialization failure. */ }
    // Abort the parent synchronously before closing providers can reject pending tools.
    const parentShutdown = this.services.stageRuntime?.shutdown();
    const stopped = await Promise.allSettled([parentShutdown, ...this.providers.map(provider => provider.close())]);
    errors.push(...stopped.flatMap(result => result.status === 'rejected' ? [result.reason] : []));
    try {
      await shutdownResearchServices([
        this.auxiliaryServices.get('reading') ?? null,
        this.auxiliaryServices.get('diagram') ?? null,
        ...this.backgroundServices,
        { shutdown: () => shutdownResearchPlugin({ ...this.services, stageRuntime: null }) }
      ]);
    } catch (error) {
      errors.push(error);
    } finally {
      this.initialized = false;
      this.backgroundServices = [];
      this.auxiliaryServices.clear();
      this.providers.length = 0;
      for (const name of Object.keys(this.services) as Array<keyof RootServices>) this.services[name] = null;
    }
    if (errors.length > 0) throw new AggregateError(errors, 'research_shutdown_failed');
  }

  health(): RocPluginHealth {
    if (!this.initialized || this.closing) return { status: 'unhealthy', reason: 'research_plugin_not_initialized' };
    return this.providers.map(provider => provider.health()).find(health => health.status !== 'healthy') ?? { status: 'healthy' };
  }
}

export async function shutdownResearchServices(services: readonly ShutdownService[]): Promise<void> {
  const errors: unknown[] = [];
  for (const service of services) {
    try { await service?.shutdown(); } catch (error) { errors.push(error); }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'research_shutdown_failed');
}

export async function applyResearchWorkflowTransition(input: {
  request: ResearchWorkflowTransitionRequest;
  gate: {
    complete(request: ResearchWorkflowTransitionRequest): Promise<ResearchWorkflowSnapshot>;
    approve(request: ResearchWorkflowTransitionRequest): Promise<ResearchWorkflowSnapshot>;
    reject(request: ResearchWorkflowTransitionRequest): Promise<ResearchWorkflowSnapshot>;
  };
  runtime: { transition(request: ResearchWorkflowTransitionRequest): Promise<ResearchWorkflowSnapshot> };
  exports: Pick<ResearchExportService, 'projectChanged'>;
}): Promise<ResearchWorkflowSnapshot> {
  const request = input.request;
  const snapshot = request.action === 'complete' || request.action === 'approve' || request.action === 'reject'
    ? await input.gate[request.action](request)
    : await input.runtime.transition(request);
  input.exports.projectChanged(request.projectId);
  return snapshot;
}

export async function shutdownResearchPlugin(services: {
  monitors: ShutdownService;
  zenodo: ShutdownService;
  literature: ShutdownService;
  scholarly: ShutdownService;
  resources: ShutdownService;
  openreview: ShutdownService;
  huggingface: ShutdownService;
  huggingfaceDownloads: ShutdownService;
  zotero: ShutdownService;
  literatureImports: ShutdownService;
  productionInputs: ShutdownService;
  exports: ShutdownService;
  figures: ShutdownService;
  experiments: ShutdownService;
  pythonEnvironments: ShutdownService;
  indexer: ShutdownService;
  embeddings: ShutdownService;
  stageRuntime: ShutdownService;
  reviewSearch: ShutdownService;
  templates: ShutdownService;
  documents: ShutdownService;
  library: ShutdownService;
  prose: ShutdownService;
}): Promise<void> {
  const ordered = [
    // Abort the parent before child cleanup can reject its pending tool calls.
    services.stageRuntime,
    services.reviewSearch,
    services.monitors,
    services.zenodo,
    services.scholarly,
    services.resources,
    services.openreview,
    services.huggingface,
    services.huggingfaceDownloads,
    services.literature,
    services.zotero,
    services.literatureImports,
    services.productionInputs,
    services.exports,
    services.figures,
    services.experiments,
    services.pythonEnvironments,
    services.indexer,
    services.embeddings,
    services.templates,
    services.documents,
    services.library,
    services.prose
  ];
  await shutdownResearchServices(ordered);
}
