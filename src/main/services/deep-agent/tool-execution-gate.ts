/** Fair, abortable reader/writer admission. Waiting work holds no budget reservation. */
export class ToolExecutionGate {
  private readers = 0;
  private writer = false;
  private readonly waiting: { write: boolean; signal?: AbortSignal; start: () => void }[] = [];

  acquire(write: boolean, signal?: AbortSignal, limit = Number.POSITIVE_INFINITY): Promise<() => void> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const item = { write, signal, start: () => {
        signal?.removeEventListener('abort', abort);
        if (write) this.writer = true; else this.readers++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          if (write) this.writer = false; else this.readers--;
          this.drain(limit);
        });
      } };
      const abort = () => {
        const index = this.waiting.indexOf(item);
        if (index !== -1) this.waiting.splice(index, 1);
        reject(signal?.reason ?? new Error('tool_admission_aborted'));
        this.drain(limit);
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.waiting.push(item);
      this.drain(limit);
    });
  }

  private drain(limit: number): void {
    while (!this.writer && this.waiting.length > 0) {
      const next = this.waiting[0];
      if (next.write && this.readers > 0 || !next.write && this.readers >= limit) return;
      this.waiting.shift();
      next.start();
    }
  }
}
