export type ResourceActivityKind = 'capability' | 'agent' | 'research' | 'research_process';

/** Count promised work without retaining requests, prompts, task IDs or their results. */
export class ResourceActivity {
  private readonly counts = new Map<ResourceActivityKind, number>();
  private readonly listeners = new Set<() => void>();
  private total = 0;

  get busy(): boolean {
    return this.total > 0;
  }

  snapshot(): Readonly<{ total: number; counts: Partial<Record<ResourceActivityKind, number>> }> {
    return { total: this.total, counts: Object.fromEntries(this.counts) };
  }

  begin(kind: ResourceActivityKind): () => void {
    this.counts.set(kind, (this.counts.get(kind) ?? 0) + 1);
    this.total += 1;
    if (this.total === 1) this.changed();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.counts.get(kind) ?? 0) - 1;
      if (count === 0) this.counts.delete(kind);
      else this.counts.set(kind, count);
      this.total -= 1;
      if (this.total === 0) this.changed();
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.error('resource_activity_observer_failed', error);
      }
    }
  }
}

// Process-wide policy: detached jobs and ordinary Agent runs outlive their initiating IPC.
export const mainResourceActivity = new ResourceActivity();
