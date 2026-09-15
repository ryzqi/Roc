export type ResearchJobTask = {
  controller: AbortController;
  promise: Promise<unknown>;
};

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
