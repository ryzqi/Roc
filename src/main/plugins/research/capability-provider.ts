import type { CapabilityDescriptor, CapabilityHandler, RocPluginContext, RocPluginHealth } from '../../kernel/types';
import { getCapabilityAbortSignal } from '../../kernel/capability-cancellation';

type ProviderState = 'idle' | 'initializing' | 'ready' | 'failed' | 'closed';

/**
 * Register the public contract immediately, then collect its real handlers once.
 * Input/output validation and operation context remain owned by the real registry.
 */
export class ResearchCapabilityProvider<T> {
  private state: ProviderState = 'idle';
  private pending: Promise<T> | null = null;
  private value: T | undefined;
  private handlers = new Map<string, CapabilityHandler>();
  private readonly controller = new AbortController();
  private cleanupFailed = false;
  private closePending: Promise<void> | null = null;

  constructor(
    private readonly context: RocPluginContext,
    private readonly domain: string,
    private readonly descriptors: readonly CapabilityDescriptor[],
    private readonly initialize: (context: RocPluginContext, signal: AbortSignal) => T | Promise<T>,
    private readonly cleanup: () => Promise<void> = async () => {}
  ) {
    for (const descriptor of descriptors) {
      context.capabilities.register(context.pluginId, descriptor, async (input, operationContext) => {
        if (this.state !== 'ready') {
          await this.get();
          this.controller.signal.throwIfAborted();
          getCapabilityAbortSignal()?.throwIfAborted();
          // Initialization is an asynchronous boundary: shared-reference inputs
          // must be checked again before domain handling. Ready calls have no gap.
          input = descriptor.inputSchema.parse(input);
        }
        this.controller.signal.throwIfAborted();
        getCapabilityAbortSignal()?.throwIfAborted();
        const handler = this.handlers.get(descriptor.name);
        if (handler === undefined) throw new Error('research_capability_provider_incomplete');
        return await handler(input, operationContext);
      });
    }
  }

  get(): Promise<T> {
    if (this.controller.signal.aborted) return Promise.reject(this.controller.signal.reason);
    if (this.cleanupFailed) return Promise.reject(new Error('research_capability_cleanup_failed'));
    if (this.state === 'ready') return Promise.resolve(this.value as T);
    if (this.pending !== null) return this.pending;
    this.state = 'initializing';
    const started = performance.now();
    const handlers = new Map<string, CapabilityHandler>();
    const declarations = new Map(this.descriptors.map(descriptor => [descriptor.name, descriptor]));
    const registry = this.context.capabilities;
    const childContext: RocPluginContext = {
      ...this.context,
      capabilities: {
        declare: registry.declare.bind(registry),
        unregister: registry.unregister.bind(registry),
        invoke: registry.invoke.bind(registry),
        list: registry.list.bind(registry),
        register: (pluginId, descriptor, handler) => {
          const declared = declarations.get(descriptor.name);
          if (pluginId !== this.context.pluginId || declared === undefined ||
              descriptor.version !== declared.version || descriptor.effectReceipt !== declared.effectReceipt ||
              descriptor.inputSchema !== declared.inputSchema || descriptor.outputSchema !== declared.outputSchema) {
            throw new Error('capability_descriptor_mismatch');
          }
          if (handlers.has(descriptor.name)) throw new Error('capability_already_registered');
          handlers.set(descriptor.name, handler as CapabilityHandler);
        }
      }
    };
    // Defer even synchronous construction until pending is installed for reentrant callers.
    this.pending = Promise.resolve().then(async () => {
      this.controller.signal.throwIfAborted();
      const value = await this.initialize(childContext, this.controller.signal);
      this.controller.signal.throwIfAborted();
      if (handlers.size !== declarations.size) throw new Error('research_capability_provider_incomplete');
      this.handlers = handlers;
      this.value = value;
      this.state = 'ready';
      this.observe(started, 'ready');
      return value;
    }).catch(async error => {
      try {
        await this.cleanup();
      } catch (cleanupError) {
        this.cleanupFailed = true;
        error = new AggregateError([error, cleanupError], 'research_capability_cleanup_failed');
      }
      this.handlers.clear();
      this.value = undefined;
      this.state = this.controller.signal.aborted ? 'closed' : 'failed';
      this.observe(started, this.state);
      throw error;
    }).finally(() => { this.pending = null; });
    return this.pending;
  }

  health(): RocPluginHealth {
    return this.state === 'failed' || this.cleanupFailed
      ? { status: 'unhealthy', reason: `research_capability_initialization_failed:${this.domain}` }
      : { status: 'healthy' };
  }

  /** Fence every provider before waiting, so shutdown cannot create a new dependency. */
  close(): Promise<void> {
    if (this.closePending !== null) return this.closePending;
    this.controller.abort(new Error('research_capability_provider_closed'));
    this.closePending = (async () => {
      try { await this.pending; } catch { /* Failed initialization already cleaned its partial services. */ }
      this.state = 'closed';
      this.handlers.clear();
      this.value = undefined;
      if (this.cleanupFailed) throw new Error('research_capability_cleanup_failed');
    })();
    return this.closePending;
  }

  private observe(started: number, outcome: ProviderState): void {
    this.context.logger.info('Research capability initialization.', {
      domain: this.domain, phase: 'initialize', outcome, durationMs: performance.now() - started,
      capabilityCount: this.descriptors.length
    });
  }
}
