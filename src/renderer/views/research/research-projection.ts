export type ProjectionStatus = {
  working: boolean;
  error: string | null;
};

export function createProjectionController<T extends ProjectionStatus>(input: {
  empty(): T;
  copy(value: T): T;
  same?(left: T, right: T): boolean;
}): ProjectionController<T> {
  let snapshot = input.empty();
  let generation = 0;
  const listeners = new Set<(snapshot: T) => void>();
  const same = input.same ?? ((left, right) => left === right);

  function emit(): void {
    const next = input.copy(snapshot);
    for (const listener of listeners) listener(input.copy(next));
  }

  function assign(patch: Partial<T>): void {
    const next = { ...snapshot, ...patch };
    if (same(snapshot, next)) return;
    snapshot = next;
    emit();
  }

  return {
    getSnapshot() {
      return input.copy(snapshot);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    peek() {
      return snapshot;
    },
    assign,
    isCurrent(token: number) {
      return token === generation;
    },
    fail(message: string, extra: Partial<T> = {}) {
      assign({ ...extra, error: message, working: false } as Partial<T>);
    },
    bump(): number {
      return ++generation;
    },
    async runExclusive(action: (token: number) => Promise<void>, messages: { busy: string; failed: string }): Promise<void> {
      if (snapshot.working) {
        assign({ error: messages.busy } as Partial<T>);
        return;
      }
      const token = ++generation;
      assign({ working: true, error: null } as Partial<T>);
      try {
        await action(token);
        if (token !== generation) return;
        assign({ working: false } as Partial<T>);
      } catch (error) {
        if (token !== generation) return;
        const message = error instanceof Error ? error.message : messages.failed;
        assign({ working: false, error: message } as Partial<T>);
      }
    },
    clearError() {
      if (snapshot.error !== null) assign({ error: null } as Partial<T>);
    }
  };
}

export type ProjectionController<T extends ProjectionStatus> = {
  getSnapshot(): T;
  subscribe(listener: (snapshot: T) => void): () => void;
  peek(): T;
  assign(patch: Partial<T>): void;
  isCurrent(token: number): boolean;
  fail(message: string, extra?: Partial<T>): void;
  bump(): number;
  runExclusive(action: (token: number) => Promise<void>, messages: { busy: string; failed: string }): Promise<void>;
  clearError(): void;
};
