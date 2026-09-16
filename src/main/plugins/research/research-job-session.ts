export type ResearchJobTask = {
  controller: AbortController;
  promise: Promise<unknown>;
};

export type ResearchBackgroundJob<TMeta> = ResearchJobTask & TMeta;

export class ResearchJobSession {
  private closed = false;
  private readonly tasks = new Set<ResearchJobTask>();

  constructor(private readonly closedCode: string) {}

  get isClosed(): boolean {
    return this.closed;
  }

  requireOpen(): void {
    if (this.closed) throw new Error(this.closedCode);
  }

  async run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.requireOpen();
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => {
      this.requireOpen();
      return operation(controller.signal);
    });
    const task: ResearchJobTask = { controller, promise };
    this.tasks.add(task);
    try {
      return await promise as T;
    } finally {
      this.tasks.delete(task);
    }
  }

  async guard<T>(operation: () => Promise<T>): Promise<T> {
    return await this.run(async (signal) => {
      signal.throwIfAborted();
      return await operation();
    });
  }

  track(task: ResearchJobTask): void {
    this.tasks.add(task);
  }

  untrack(task: ResearchJobTask): void {
    this.tasks.delete(task);
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const task of this.tasks) task.controller.abort();
    await Promise.allSettled([...this.tasks].map((task) => task.promise));
  }
}

export class ResearchBackgroundJobs<TMeta> {
  private readonly jobs = new Map<string, ResearchBackgroundJob<TMeta>>();

  constructor(
    private readonly session: ResearchJobSession,
    private readonly onLost: (id: string, error: unknown) => void
  ) {}

  has(id: string): boolean {
    return this.jobs.has(id);
  }

  get(id: string): ResearchBackgroundJob<TMeta> | undefined {
    return this.jobs.get(id);
  }

  start(id: string, meta: TMeta, work: (signal: AbortSignal) => Promise<void>): void {
    if (this.jobs.has(id)) return;
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => work(controller.signal));
    const task = { controller, promise, ...meta };
    this.session.track(task);
    this.jobs.set(id, task);
    void promise.catch((error: unknown) => this.onLost(id, error))
      .finally(() => { this.session.untrack(task); this.jobs.delete(id); });
  }

  abort(id: string): void {
    this.jobs.get(id)?.controller.abort();
  }

  abortMatching(match: (id: string, job: ResearchBackgroundJob<TMeta>) => boolean): void {
    for (const [id, job] of this.jobs) if (match(id, job)) job.controller.abort();
  }

  async wait(id: string): Promise<void> {
    const task = this.jobs.get(id);
    if (task !== undefined) await task.promise;
  }
}
