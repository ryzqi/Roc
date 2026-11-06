/** Main-process deadline timers. Owners supply reconciliation and durable occurrences. */
export class BackgroundDeadlines {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly maxDelayMs = 24 * 60 * 60 * 1000) {}

  schedule(key: string, deadline: string, fire: () => void): void {
    this.remove(key);
    const arm = (): void => {
      const remaining = Date.parse(deadline) - Date.now();
      const timer = setTimeout(() => {
        this.timers.delete(key);
        if (Date.parse(deadline) > Date.now()) arm();
        else fire();
      }, Math.min(Math.max(0, remaining), this.maxDelayMs));
      timer.unref();
      this.timers.set(key, timer);
    };
    arm();
  }

  remove(key: string): void {
    const timer = this.timers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(key);
  }

  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
