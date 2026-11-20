import type { ResourceActivity } from './resource-activity';

export type ResourceState = 'foreground_active' | 'background_busy' | 'background_idle' | 'memory_pressure';
export type ResourceBudgetSnapshot = Readonly<{ state: ResourceState; hidden: boolean; pressure: boolean }>;
type Options = {
  activity: ResourceActivity;
  mainRssBudgetBytes: number;
  sampleMainRss: () => number;
  setProcessPolicy: (policy: { background: boolean; pressure: boolean }) => void;
  reclaimIdleDatabaseMemory: () => void;
  onState: (snapshot: ResourceBudgetSnapshot) => void;
  onError: (error: unknown) => void;
  sampleIntervalMs?: number;
  idleDelayMs?: number;
  reclaimCooldownMs?: number;
};

/** This is a process budget signal, not an estimate of macOS system pressure or exclusive footprint. */
export class MainResourceBudget {
  private hidden = false;
  private pressure = false;
  private suspended = false;
  private started = false;
  private state: ResourceState = 'foreground_active';
  private sampleTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;
  private lastReclaimAt = -Infinity;

  constructor(private readonly options: Options) {
    if (!Number.isFinite(options.mainRssBudgetBytes) || options.mainRssBudgetBytes <= 0) {
      throw new Error('main_rss_budget_invalid');
    }
  }

  snapshot(): ResourceBudgetSnapshot {
    return { state: this.state, hidden: this.hidden, pressure: this.pressure };
  }

  start(): void {
    if (this.started) throw new Error('resource_budget_already_started');
    this.started = true;
    this.unsubscribe = this.options.activity.subscribe(() => this.update());
    this.sample();
    this.startSampling();
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    if (this.started) this.update();
  }

  suspend(): void {
    this.suspended = true;
    this.clearTimers();
  }

  resume(): void {
    if (!this.started) return;
    this.suspended = false;
    this.sample();
    this.startSampling();
  }

  stop(): void {
    this.started = false;
    this.clearTimers();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.options.setProcessPolicy({ background: false, pressure: false });
  }

  sample(): void {
    if (!this.started || this.suspended) return;
    try {
      const rss = this.options.sampleMainRss();
      if (!Number.isFinite(rss) || rss < 0) throw new Error('main_rss_sample_invalid');
      // A 25% recovery margin prevents alternating admission policy around the budget.
      this.pressure = rss >= this.options.mainRssBudgetBytes ||
        (this.pressure && rss > this.options.mainRssBudgetBytes * 0.75);
      this.update();
    } catch (error) {
      this.options.onError(error);
    }
  }

  private update(): void {
    if (!this.started || this.suspended) return;
    const state: ResourceState = this.pressure ? 'memory_pressure' : !this.hidden ? 'foreground_active' :
      this.options.activity.busy ? 'background_busy' : 'background_idle';
    const changed = state !== this.state;
    this.state = state;
    // Admission only constrains future leases; it never aborts an admitted task.
    this.options.setProcessPolicy({ background: this.hidden, pressure: this.pressure });
    if (changed) this.options.onState(this.snapshot());
    if (this.options.activity.busy || (!this.hidden && !this.pressure)) {
      if (this.idleTimer !== null) clearTimeout(this.idleTimer);
      this.idleTimer = null;
      return;
    }
    if (this.idleTimer !== null) return;
    const cooldown = Math.max(0, this.lastReclaimAt + (this.options.reclaimCooldownMs ?? 300_000) - performance.now());
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.started || this.suspended || this.options.activity.busy || (!this.hidden && !this.pressure)) return;
      this.lastReclaimAt = performance.now();
      try {
        this.options.reclaimIdleDatabaseMemory();
      } catch (error) {
        this.options.onError(error);
      }
    }, Math.max(this.options.idleDelayMs ?? 5000, cooldown));
    this.idleTimer.unref();
  }

  private startSampling(): void {
    if (this.sampleTimer !== null || this.suspended) return;
    this.sampleTimer = setInterval(() => this.sample(), this.options.sampleIntervalMs ?? 30_000);
    this.sampleTimer.unref();
  }

  private clearTimers(): void {
    if (this.sampleTimer !== null) clearInterval(this.sampleTimer);
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.sampleTimer = null;
    this.idleTimer = null;
  }
}
