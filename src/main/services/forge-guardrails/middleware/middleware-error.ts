import { MiddlewareError } from 'langchain';

export function unwrapMiddlewareError(error: unknown): unknown {
  let current = error;
  const seen = new Set<unknown>();
  while (MiddlewareError.isInstance(current) && current.cause !== undefined) {
    if (seen.has(current)) {
      return current;
    }
    seen.add(current);
    current = current.cause;
  }
  return current;
}
