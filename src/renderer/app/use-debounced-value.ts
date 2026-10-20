import { useEffect, useState } from 'react';

/**
 * Debounces a value for IPC-keyed queries (P5/T5.8).
 *
 * The ⌘K palette fans out to several backends on every keystroke, so the query
 * that reaches them is debounced — but only the *query*: the input stays fully
 * controlled by React state, so typing never lags. The debounce belongs to the
 * caller's key, which is what makes a stale response unrepresentable (the
 * key-tagged `useAsyncResource`).
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
