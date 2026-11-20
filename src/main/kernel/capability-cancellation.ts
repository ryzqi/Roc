import { AsyncLocalStorage } from 'node:async_hooks';

// Cancellation is independent of effect receipts. Nested invocations inherit
// their caller's signal without changing the publication/lease context.
const cancellation = new AsyncLocalStorage<AbortSignal>();

export function getCapabilityAbortSignal(): AbortSignal | undefined {
  return cancellation.getStore();
}

export function runWithCapabilityCancellation<T>(signal: AbortSignal | undefined, work: () => T): T {
  const parent = cancellation.getStore();
  const active = signal === undefined ? parent : parent === undefined || parent === signal
    ? signal : AbortSignal.any([parent, signal]);
  return active === undefined ? work() : cancellation.run(active, work);
}
