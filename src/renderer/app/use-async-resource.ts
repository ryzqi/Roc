import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { errorMessage, type IpcLikeResult } from './loaded-state';

/**
 * Uniform IPC resource loading.
 *
 * Every view in P2–P9 loads backend data the same way, so this is the single
 * place that decides what "loading", "ready" and "error" mean:
 *
 *   - the caller supplies a `key`; when it changes (new project, new workspace,
 *     new filter) the resource **drops the previous scope's data immediately**
 *     rather than showing it until the new call resolves
 *   - `{ ok: false }` becomes `status: 'error'` carrying the backend's own
 *     message — no component invents its own error text
 *   - a stale response never wins: results are dropped if the key changed or the
 *     component unmounted while the call was in flight
 *   - `reload()` re-runs the same call, which is what the error bar's retry does
 *
 * Components must not `try/catch` around IPC; they render `status` and `error`.
 */

export type AsyncStatus = 'idle' | 'loading' | 'ready' | 'error';

export type AsyncResource<T> = {
  status: AsyncStatus;
  data: T | null;
  error: string | null;
  reload: () => void;
};

export type AsyncResourceOptions = {
  /** Human label used in the error message prefix, e.g. "读取科研项目". */
  label: string;
};

export function useAsyncResource<T>(
  key: string | null,
  load: () => Promise<IpcLikeResult<T>>,
  { label }: AsyncResourceOptions
): AsyncResource<T> {
  /**
   * Data is stored together with the key that produced it.
   *
   * Keeping them apart allowed a stale-scope flash: after a key change the old
   * value was still returned while the new call was in flight, so a direct
   * project→project switch could briefly show the previous project's name and
   * writability. Tagging the value makes staleness unrepresentable.
   */
  const [snapshot, setSnapshot] = useState<{ key: string; value: T } | null>(null);
  const [status, setStatus] = useState<AsyncStatus>(key === null ? 'idle' : 'loading');
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  // Kept in a ref so `load` identity churn does not refetch on every render.
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (key === null) {
      setStatus('idle');
      setError(null);
      return;
    }

    let cancelled = false;
    setStatus('loading');
    setError(null);

    void (async () => {
      try {
        const result = await loadRef.current();
        if (cancelled) {
          return;
        }
        if (!result.ok) {
          setStatus('error');
          setError(result.error.message);
          return;
        }
        setStatus('ready');
        setSnapshot({ key, value: result.data });
      } catch (caught) {
        if (cancelled) {
          return;
        }
        setStatus('error');
        setError(errorMessage(caught));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [key, nonce, label]);

  const reload = useCallback(() => {
    setNonce((current) => current + 1);
  }, []);

  const data = snapshot !== null && snapshot.key === key ? snapshot.value : null;

  // Memoised so `useEffect(..., [resource])` in a consumer cannot loop on a fresh
  // object identity every render.
  return useMemo(() => ({ status, data, error, reload }), [status, data, error, reload]);
}

/**
 * Imperative variant for writes (create / update / delete).
 *
 * Writes are user-initiated, so they expose a pending flag and a result rather
 * than a status machine. The caller renders field-level or bar-level errors; the
 * backend message is passed through untouched.
 */
export type AsyncAction<Args extends unknown[], Result> = {
  pending: boolean;
  error: string | null;
  run: (...args: Args) => Promise<Result | null>;
  reset: () => void;
};

export function useAsyncAction<Args extends unknown[], Result>(
  action: (...args: Args) => Promise<IpcLikeResult<Result>>,
  { label }: AsyncResourceOptions
): AsyncAction<Args, Result> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const actionRef = useRef(action);
  actionRef.current = action;
  const mountedRef = useRef(true);

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    []
  );

  const run = useCallback(
    async (...args: Args): Promise<Result | null> => {
      setPending(true);
      setError(null);
      try {
        const result = await actionRef.current(...args);
        if (!result.ok) {
          // A rejection or failure can outlive the component; do not touch state.
          if (mountedRef.current) {
            setError(result.error.message);
          }
          return null;
        }
        return result.data;
      } catch (caught) {
        if (mountedRef.current) {
          setError(errorMessage(caught));
        }
        return null;
      } finally {
        if (mountedRef.current) {
          setPending(false);
        }
      }
    },
    [label]
  );

  const reset = useCallback(() => {
    setError(null);
  }, []);

  // Memoised for the same reason as `useAsyncResource`.
  return useMemo(() => ({ pending, error, run, reset }), [pending, error, run, reset]);
}
