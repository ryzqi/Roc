import {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import type {ScientificSearchRequest} from '../../shared/schemas/research-scientific-search';
import type {ScientificQueryResult} from '../../shared/schemas/research-scientific-query';
import {runIpcAction, type IpcLikeResult} from '../app/loaded-state';
import {LatestSearchQueue, type SearchIdentity, type SearchTicket} from './latest-search-queue';

type SearchState = SearchIdentity & {pending: boolean; error: string | null};
type Options = {
  query: string;
  projectId: string | null;
  rerank: 'none' | 'semantic';
  embeddingConfigId: string | null;
  settingsRevision: number;
  indexRevision: number | null;
  indexGeneration: number | null;
  enabled: boolean;
  load: (request: ScientificSearchRequest) => Promise<IpcLikeResult<ScientificQueryResult>>;
  received: (result: ScientificQueryResult) => void;
};

/** Debounce input independently from its displayed value and from explicit assistant handoff. */
export function useRagSearch(options: Options) {
  const {query, projectId, rerank, embeddingConfigId, settingsRevision, indexRevision, indexGeneration, enabled} = options;
  const trimmed = query.trim();
  const key = enabled && projectId !== null && trimmed ? JSON.stringify([
    projectId, trimmed, rerank, embeddingConfigId, settingsRevision, indexRevision, indexGeneration
  ]) : null;
  const request = projectId !== null && trimmed ? {
    query: trimmed, projectId, limit: 20, candidateLimit: 100, documentIds: [], rerank, embeddingConfigId
  } satisfies ScientificSearchRequest : null;
  const liveKey = useRef(key);
  liveKey.current = key;
  const requestRef = useRef(request);
  requestRef.current = request;
  const loadRef = useRef(options.load);
  loadRef.current = options.load;
  const receivedRef = useRef(options.received);
  receivedRef.current = options.received;
  const displayedKey = useRef<string | null>(null);
  const mounted = useRef(true);
  const [state, setState] = useState<SearchState | null>(null);
  const queueRef = useRef<LatestSearchQueue<ScientificSearchRequest, ScientificQueryResult> | null>(null);
  if (queueRef.current === null) queueRef.current = new LatestSearchQueue(
    input => runIpcAction(() => loadRef.current(input)),
    identity => {
      if (mounted.current && identity.key === liveKey.current) setState({...identity, pending: true, error: null});
    },
    ticket => {
      if (!mounted.current || ticket.key !== liveKey.current) return;
      setState({...ticket, pending: false, error: ticket.outcome.ok ? null : ticket.outcome.error});
      if (ticket.outcome.ok) {
        displayedKey.current = ticket.key;
        receivedRef.current(ticket.outcome.data);
      }
    }
  );
  const queue = queueRef.current;

  useLayoutEffect(() => {
    mounted.current = true;
    queue.activate(key);
    return () => {
      mounted.current = false;
      queue.invalidate();
    };
  }, [queue, key, query]);

  useEffect(() => {
    if (key === null) return;
    const timer = window.setTimeout(() => {
      const input = requestRef.current;
      // A retained successful view keeps its selection/scroll on management or view return.
      // Raw input and IME invalidate this marker, so returning to a cleared/edited query refetches.
      if (mounted.current && liveKey.current === key && input && displayedKey.current !== key) void queue.run(key, input);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [queue, key, query]);

  const invalidate = useCallback(() => {
    liveKey.current = null;
    displayedKey.current = null;
    queue.invalidate();
  }, [queue]);
  const run = useCallback((): Promise<SearchTicket<ScientificQueryResult> | null> => {
    const currentKey = liveKey.current, input = requestRef.current;
    if (!mounted.current || currentKey === null || input === null) return Promise.resolve(null);
    queue.activate(currentKey);
    return queue.run(currentKey, input, true);
  }, [queue]);
  const isCurrent = useCallback((identity: SearchIdentity): boolean =>
    mounted.current && liveKey.current === identity.key && queue.isCurrent(identity), [queue]);
  const currentState = state && key === state.key && queue.isCurrent(state) ? state : null;
  return {pending: currentState?.pending ?? false, error: currentState?.error ?? null, run, invalidate, isCurrent};
}
