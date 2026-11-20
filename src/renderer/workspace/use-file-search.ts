import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FileNameSearchResult, FileSearchResult } from '../../shared/types';
import type { IpcLikeResult } from '../app/loaded-state';
import type { RocClient } from '../shared/roc-client';
import { useDebouncedValue } from '../app/use-debounced-value';
import { searchFileContents, searchFileNames } from './workspace-store';

/**
 * File search (P3/T3.4).
 *
 * `files.searchByName` and `files.search` are **different** backend queries, and
 * the plan gives them different entry points:
 *
 *   - the sidebar's file tab searches names (`useFileNameSearch`)
 *   - ⌘K searches both and shows the results as two groups (`useFileSearchGroups`)
 *
 * Both share the same debounce-and-drop-stale discipline: when a query is typed
 * quickly, an earlier response must not overwrite a later one.
 */

const FILE_SEARCH_DEBOUNCE_MS = 180;

export type QueryState<Result> = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  data: Result | null;
  error: string | null;
  reload: () => void;
};

/** The empty payload a failed search degrades to, so `data` stays non-null. */
const EMPTY_NAMES: FileNameSearchResult = { query: '', matches: [], truncated: false };
const EMPTY_CONTENTS: FileSearchResult = { query: '', matches: [], truncated: false };

/**
 * Runs one debounced query against a variable key.
 *
 * `key` is the bound workspace path: when it changes the result resets instead of
 * showing the previous workspace's matches.
 */
function useDebouncedQuery<Result>(
  key: string | null,
  query: string,
  run: (query: string) => Promise<IpcLikeResult<Result>>,
  emptyResult: Result
): QueryState<Result> {
  const debouncedQuery = useDebouncedValue(query, FILE_SEARCH_DEBOUNCE_MS);
  const [state, setState] = useState<{ key: string | null; status: QueryState<Result>['status']; data: Result | null; error: string | null }>({
    key,
    status: 'idle',
    data: null,
    error: null
  });
  const [nonce, setNonce] = useState(0);
  const trimmed = debouncedQuery.trim();

  useEffect(() => {
    if (key === null || trimmed.length === 0) {
      setState({ key, status: 'idle', data: null, error: null });
      return;
    }
    let cancelled = false;
    setState((current) => ({ key, status: 'loading', data: current.key === key ? current.data : null, error: null }));
    void (async () => {
      const result = await run(trimmed);
      if (cancelled) {
        return;
      }
      if (!result.ok) {
        setState({ key, status: 'error', data: emptyResult, error: result.error.message });
        return;
      }
      setState({ key, status: 'ready', data: result.data, error: null });
    })().catch((cause: unknown) => {
      if (cancelled) return;
      setState({ key, status: 'error', data: emptyResult, error: cause instanceof Error ? cause.message : '搜索文件失败' });
    });
    return () => {
      cancelled = true;
    };
  }, [key, trimmed, nonce, run, emptyResult]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return useMemo(() => ({
    status: state.key === key ? state.status : key === null || trimmed.length === 0 ? 'idle' : 'loading',
    data: state.key === key ? state.data : null,
    error: state.key === key ? state.error : null,
    reload
  }), [state, key, trimmed, reload]);
}

/** Sidebar file tab: name-only search. */
export function useFileNameSearch(client: RocClient, key: string | null, query: string): QueryState<FileNameSearchResult> {
  const run = useCallback((value: string) => searchFileNames(client, value), [client]);
  return useDebouncedQuery<FileNameSearchResult>(key, query, run, EMPTY_NAMES);
}

export type FileSearchGroups = {
  names: FileNameSearchResult | null;
  contents: FileSearchResult | null;
  namesError: string | null;
  contentsError: string | null;
  loading: boolean;
};

/**
 * ⌘K file group: both queries at once.
 *
 * The two calls are independent — one failing must not blank the other, which is
 * the palette's "each group degrades on its own" rule.
 */
export function useFileSearchGroups(client: RocClient, key: string | null, query: string): FileSearchGroups {
  const nameRun = useCallback((value: string) => searchFileNames(client, value), [client]);
  const contentRun = useCallback((value: string) => searchFileContents(client, value), [client]);
  const names = useDebouncedQuery<FileNameSearchResult>(key, query, nameRun, EMPTY_NAMES);
  const contents = useDebouncedQuery<FileSearchResult>(key, query, contentRun, EMPTY_CONTENTS);

  return {
    names: names.data,
    contents: contents.data,
    namesError: names.error,
    contentsError: contents.error,
    loading: names.status === 'loading' || contents.status === 'loading'
  };
}
