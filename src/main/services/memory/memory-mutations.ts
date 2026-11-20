import { AsyncLocalStorage } from 'node:async_hooks';

/** Serializes whole read/modify/write operations in the main process, including nested writes. */
export class MemoryMutationCoordinator {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly active = new AsyncLocalStorage<{ open: boolean }>();

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active.getStore()?.open === true) return operation();
    const result = this.tail.then(() => {
      const token = { open: true };
      return this.active.run(token, async () => {
        try { return await operation(); }
        finally { token.open = false; }
      });
    });
    // A failed write must not poison subsequent writes.
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

const coordinators = new WeakMap<object, MemoryMutationCoordinator>();

export function memoryMutationsFor(identity: object): MemoryMutationCoordinator {
  let coordinator = coordinators.get(identity);
  if (coordinator === undefined) {
    coordinator = new MemoryMutationCoordinator();
    coordinators.set(identity, coordinator);
  }
  return coordinator;
}

export function withStoreMemoryMutation<T>(
  store: object & { memoryMutations?: MemoryMutationCoordinator },
  operation: () => Promise<T>
): Promise<T> {
  return (store.memoryMutations ?? memoryMutationsFor(store)).run(operation);
}
