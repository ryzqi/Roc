import { useEffect, useRef } from 'react';
import { idleLazyLoadState } from './empty-states';
import type { LazyLoadState } from './types';

export type LazyStartupTransition =
  | {
      cancelActiveRequest: boolean;
      nextLoadState: LazyLoadState | null;
      shouldStartLoad: false;
    }
  | {
      cancelActiveRequest: boolean;
      nextLoadState: LazyLoadState;
      shouldStartLoad: true;
    };

export function planLazyStartupTransition(input: {
  cacheKey: string | null;
  enabled: boolean;
  loadState: LazyLoadState;
}): LazyStartupTransition {
  if (!input.enabled || input.cacheKey === null) {
    return {
      cancelActiveRequest: true,
      nextLoadState: input.loadState.status === 'loading' ? idleLazyLoadState(input.cacheKey) : null,
      shouldStartLoad: false
    };
  }
  if (input.loadState.key === input.cacheKey && input.loadState.status !== 'idle') {
    return {
      cancelActiveRequest: false,
      nextLoadState: null,
      shouldStartLoad: false
    };
  }

  return {
    cancelActiveRequest: false,
    nextLoadState: {
      status: 'loading',
      error: null,
      key: input.cacheKey
    },
    shouldStartLoad: true
  };
}

export function useLazyStartupResource<T>({
  apply,
  cacheKey,
  enabled,
  load,
  loadState,
  setLoadState
}: {
  apply: (result: T) => void;
  cacheKey: string | null;
  enabled: boolean;
  load: () => Promise<T>;
  loadState: LazyLoadState;
  setLoadState: (next: LazyLoadState) => void;
}): void {
  const activeRequestIdRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeRequestIdRef.current += 1;
    };
  }, []);

  useEffect(() => {
    const transition = planLazyStartupTransition({
      cacheKey,
      enabled,
      loadState
    });

    if (transition.cancelActiveRequest) {
      activeRequestIdRef.current += 1;
    }
    if (transition.nextLoadState !== null) {
      setLoadState(transition.nextLoadState);
    }
    if (!transition.shouldStartLoad) {
      return;
    }

    const requestId = activeRequestIdRef.current + 1;
    activeRequestIdRef.current = requestId;
    void load()
      .then((result) => {
        if (!mountedRef.current || activeRequestIdRef.current !== requestId) {
          return;
        }
        apply(result);
        setLoadState({
          status: 'ready',
          error: null,
          key: cacheKey
        });
      })
      .catch((loadError: unknown) => {
        if (!mountedRef.current || activeRequestIdRef.current !== requestId) {
          return;
        }
        setLoadState({
          status: 'error',
          error: loadError instanceof Error ? loadError.message : 'resource failed to load.',
          key: cacheKey
        });
      });
  }, [apply, cacheKey, enabled, load, loadState, setLoadState]);
}
