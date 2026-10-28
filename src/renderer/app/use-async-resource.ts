import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { errorMessage, runIpcAction, type ActionOutcome, type IpcLikeResult } from './loaded-state';

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
  run: (...args: Args) => Promise<ActionOutcome<Result>>;
  reset: () => void;
};

type AsyncActionState = {
  pendingCount: number;
  latestRequestId: number;
  error: string | null;
};

type AsyncActionEvent =
  | { type: 'start'; requestId: number }
  | { type: 'finish'; requestId: number; error: string | null }
  | { type: 'reset'; requestId: number };

const INITIAL_ASYNC_ACTION_STATE: AsyncActionState = { pendingCount: 0, latestRequestId: 0, error: null };

function reduceAsyncActionState(state: AsyncActionState, event: AsyncActionEvent): AsyncActionState {
  switch (event.type) {
    case 'start':
      return { pendingCount: state.pendingCount + 1, latestRequestId: event.requestId, error: null };
    case 'finish':
      return {
        pendingCount: Math.max(0, state.pendingCount - 1),
        latestRequestId: state.latestRequestId,
        error: event.requestId === state.latestRequestId ? event.error : state.error
      };
    case 'reset':
      return { ...state, latestRequestId: event.requestId, error: null };
  }
}

export function useAsyncAction<Args extends unknown[], Result>(
  action: (...args: Args) => Promise<IpcLikeResult<Result>>,
  _options: AsyncResourceOptions
): AsyncAction<Args, Result> {
  const [state, dispatch] = useReducer(reduceAsyncActionState, INITIAL_ASYNC_ACTION_STATE);
  const requestSequenceRef = useRef(0);
  const actionRef = useRef(action);
  actionRef.current = action;
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const run = useCallback(
    async (...args: Args): Promise<ActionOutcome<Result>> => {
      const requestId = ++requestSequenceRef.current;
      if (mountedRef.current) {
        dispatch({ type: 'start', requestId });
      }

      const result = await runIpcAction(() => actionRef.current(...args));
      if (mountedRef.current) {
        dispatch({ type: 'finish', requestId, error: result.ok ? null : result.error });
      }
      return result;
    },
    []
  );

  const reset = useCallback(() => {
    const requestId = ++requestSequenceRef.current;
    if (mountedRef.current) {
      dispatch({ type: 'reset', requestId });
    }
  }, []);

  const pending = state.pendingCount > 0;
  return useMemo(() => ({ pending, error: state.error, run, reset }), [pending, state.error, run, reset]);
}
