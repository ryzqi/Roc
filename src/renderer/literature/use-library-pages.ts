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
  refreshing: boolean;
  loadMoreError: string | null;
};

function emptyState(scope: PageScope): PageState {
  return {scope, items: EMPTY_ITEMS, total: null, nextCursor: null, hasMore: false,
    status: scope.projectId === null ? 'idle' : 'loading', error: null, loadingMore: false, refreshing: false, loadMoreError: null};
}

function retainUnchangedItems(next: ResearchLibraryItem[], previous: ResearchLibraryItem[]): ResearchLibraryItem[] {
  const byId = new Map(previous.map(item => [item.id, item]));
  return next.map(item => {
    const old = byId.get(item.id);
    // Metadata edits advance revision; association edits also advance updatedAt.
    // Preserve references for untouched rows across a background status refresh.
    return old !== undefined && old.revision === item.revision && old.updatedAt === item.updatedAt &&
      old.archived === item.archived && old.projectIds.join('\0') === item.projectIds.join('\0') ? old : item;
  });
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
  const queuedRefresh = useRef<PageScope | null>(null);

  const readPage = useCallback((append: boolean, background = false): void => {
    if (scope.projectId === null || scope.queryPending || currentScope.current !== scope) return;
    const current = stateRef.current;
    if (activeRequest.current !== null) {
      if (background) queuedRefresh.current = scope;
      return;
    }
    if (append && (current.scope !== scope || !current.hasMore || current.nextCursor === null)) return;
    const requestId = ++sequence.current;
    activeRequest.current = requestId;
    const cursor = append ? current.nextCursor : null;
    const retain = background && current.scope === scope && current.items.length > 0;
    setState(append ? {...current, loadingMore: true, loadMoreError: null}
      : retain ? {...current, refreshing: true, error: null} : emptyState(scope));
    // A background refresh rereads the explicitly loaded window as one snapshot.
    // Keep its rows mounted until all pages arrive; parsing must not reset focus,
    // scroll position, or a user's already loaded second page.
    void runIpcAction(async () => {
      const read = (nextCursor: ResearchLibraryPage['nextCursor']) => listLibraryPage(scope.client, {
        projectId: scope.projectId, query: scope.query, includeArchived: scope.includeArchived,
        limit: PAGE_LIMIT, cursor: nextCursor
      });
      let result = await read(cursor);
      if (!result.ok || !retain) return result;
      let data = result.data;
      while (data.items.length < current.items.length && data.hasMore && data.nextCursor !== null) {
        if (currentScope.current !== scope || sequence.current !== requestId) return {ok: true as const, data};
        const next = await read(data.nextCursor);
        if (!next.ok) return next;
        if (next.data.nextCursor?.id === data.nextCursor.id &&
          next.data.nextCursor?.updatedAt === data.nextCursor.updatedAt) {
          throw new Error('文献库分页未前进，请重试。');
        }
        data = {...next.data, items: [...new Map([...data.items, ...next.data.items].map(item => [item.id, item])).values()]};
      }
      return {ok: true as const, data};
    }).then(result => {
      if (currentScope.current !== scope || sequence.current !== requestId) return;
      activeRequest.current = null;
      if (queuedRefresh.current === scope) {
        // A refresh may follow a mutation. Do not publish the older snapshot,
        // including a page that was still in flight when refresh was requested.
        // Trigger the queued read while preserving only already committed rows.
        setState(previous => ({...previous, loadingMore: false, refreshing: false}));
        return;
      }
      if (!result.ok) {
        setState(previous => append ? {...previous, loadingMore: false, loadMoreError: result.error}
          : retain ? {...previous, refreshing: false, error: result.error}
          : {...emptyState(scope), status: 'error', error: result.error});
        return;
      }
      setState(previous => ({scope, items: append
        ? [...new Map([...previous.items, ...result.data.items].map(item => [item.id, item])).values()]
        : retainUnchangedItems(result.data.items, previous.scope === scope ? previous.items : []),
      total: result.data.total, hasMore: result.data.hasMore, nextCursor: result.data.nextCursor,
      status: 'ready', error: null, loadingMore: false, refreshing: false, loadMoreError: null}));
    });
  }, [scope]);
  const reload = useCallback(() => readPage(false, true), [readPage]);
  const loadMore = useCallback(() => readPage(true), [readPage]);
  useEffect(() => {
    activeRequest.current = null;
    if (scope.projectId === null || scope.queryPending) setState(emptyState(scope));
    else readPage(false);
    return () => {sequence.current++; activeRequest.current = null;};
  }, [readPage, scope]);
  useEffect(() => {
    if (queuedRefresh.current !== scope || activeRequest.current !== null) return;
    queuedRefresh.current = null;
    readPage(false, true);
  }, [state, scope, readPage]);

  const visible = state.scope === scope ? state : emptyState(scope);
  return {...visible, reload, loadMore};
}
