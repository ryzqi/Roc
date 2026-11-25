type Mode = 'read' | 'write';
type Waiter = {mode: Mode; signal: AbortSignal; resolve: (release: () => void) => void; reject: (reason: unknown) => void; abort: () => void};
type State = {readers: number; writer: boolean; queue: Waiter[]};
/** Realpath keys cover two projects that point at the same directory. Queued writers cannot starve. */
export class PythonEnvironmentLeases {
  private readonly workspaces = new Map<string, State>();
  acquire(workspace: string, mode: Mode, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    const state = this.workspaces.get(workspace) ?? {readers: 0, writer: false, queue: []};
    this.workspaces.set(workspace, state);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {mode, signal, resolve, reject, abort: () => {
        const index = state.queue.indexOf(waiter);
        if (index >= 0) state.queue.splice(index, 1);
        reject(signal.reason); this.drain(workspace, state);
      }};
      state.queue.push(waiter); signal.addEventListener('abort', waiter.abort, {once: true});
      this.drain(workspace, state);
    });
  }
  private drain(workspace: string, state: State): void {
    if (state.writer) return;
    while (state.queue.length > 0) {
      const next = state.queue[0]!;
      if (next.mode === 'write' && state.readers > 0) return;
      state.queue.shift(); next.signal.removeEventListener('abort', next.abort);
      if (next.signal.aborted) { next.reject(next.signal.reason); continue; }
      if (next.mode === 'write') state.writer = true; else state.readers++;
      let released = false;
      next.resolve(() => {
        if (released) return;
        released = true;
        if (next.mode === 'write') state.writer = false; else state.readers--;
        this.drain(workspace, state);
      });
      if (state.writer) return;
    }
    if (state.readers === 0) this.workspaces.delete(workspace);
  }
}
export const pythonEnvironmentLeases = new PythonEnvironmentLeases();
