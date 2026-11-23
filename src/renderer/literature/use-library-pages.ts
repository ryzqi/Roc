import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import type {ResearchLibraryItem, ResearchLibraryPage} from '../../shared/types';
import type {AsyncStatus} from '../app/use-async-resource';
import {runIpcAction} from '../app/loaded-state';
import type {RocClient} from '../shared/roc-client';
import {listLibraryPage} from './library-store';

const PAGE_LIMIT = 200;
const EMPTY_ITEMS: ResearchLibraryItem[] = [];
type PageScope = {client: RocClient; projectId: string | null; query: string; includeArchived: boolean; queryPending: boolean};
type PageState = {
  scope: PageScope;
  items: ResearchLibraryItem[];
  total: number | null;
  nextCursor: ResearchLibraryPage['nextCursor'];
  hasMore: boolean;
  status: AsyncStatus;
  error: string | null;
  loadingMore: boolean;
  loadMoreError: string | null;
};

function emptyState(scope: PageScope): PageState {
  return {scope, items: EMPTY_ITEMS, total: null, nextCursor: null, hasMore: false,
    status: scope.projectId === null ? 'idle' : 'loading', error: null, loadingMore: false, loadMoreError: null};
}

/** Keeps only the current query's explicitly requested pages; late replies never cross scopes. */
export function useLibraryPages(client: RocClient, projectId: string | null, query: string,
  includeArchived: boolean, queryPending: boolean): Omit<PageState, 'scope' | 'nextCursor'> & {
    reload: () => void; loadMore: () => void;
  } {
  const scope = useMemo(() => ({client, projectId, query, includeArchived, queryPending}),
    [client, projectId, query, includeArchived, queryPending]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [state, setState] = useState(() => emptyState(scope));
  const stateRef = useRef(state);
  stateRef.current = state;
  const sequence = useRef(0);
  const activeRequest = useRef<number | null>(null);

  const readPage = useCallback((append: boolean): void => {
    if (scope.projectId === null || scope.queryPending || currentScope.current !== scope) return;
    const current = stateRef.current;
    if (append && (activeRequest.current !== null || current.scope !== scope || !current.hasMore || current.nextCursor === null)) return;
    const requestId = ++sequence.current;
    activeRequest.current = requestId;
    const cursor = append ? current.nextCursor : null;
    setState(append ? {...current, loadingMore: true, loadMoreError: null} : emptyState(scope));
    void runIpcAction(() => listLibraryPage(scope.client, {projectId: scope.projectId,
      query: scope.query, includeArchived: scope.includeArchived, limit: PAGE_LIMIT, cursor})).then(result => {
      if (currentScope.current !== scope || sequence.current !== requestId) return;
      activeRequest.current = null;
      if (!result.ok) {
        setState(previous => append ? {...previous, loadingMore: false, loadMoreError: result.error}
          : {...emptyState(scope), status: 'error', error: result.error});
        return;
      }
      setState(previous => ({scope, items: append
        ? [...new Map([...previous.items, ...result.data.items].map(item => [item.id, item])).values()]
        : result.data.items,
      total: result.data.total, hasMore: result.data.hasMore, nextCursor: result.data.nextCursor,
      status: 'ready', error: null, loadingMore: false, loadMoreError: null}));
    });
  }, [scope]);
  const reload = useCallback(() => readPage(false), [readPage]);
  const loadMore = useCallback(() => readPage(true), [readPage]);
  useEffect(() => {
    activeRequest.current = null;
    if (scope.projectId === null || scope.queryPending) setState(emptyState(scope));
    else readPage(false);
    return () => {sequence.current++; activeRequest.current = null;};
  }, [readPage, scope]);

  const visible = state.scope === scope ? state : emptyState(scope);
  return {...visible, reload, loadMore};
}
