import {useCallback, useEffect, useRef, useState} from 'react';
import type {ResearchLibraryItem} from '../../shared/types';
import type {LiteratureStore} from './use-literature-store';
import {requestReadingChange} from './reading-interactions';

type RemovalScope = {client: LiteratureStore['client']; projectId: string | null; writable: boolean; busy: boolean; request: number};
type RemovalState = {
  scope: RemovalScope;
  pending: boolean;
  hiddenIds: ReadonlySet<string>;
  undoItems: readonly ResearchLibraryItem[];
  deadline: number;
  error: string | null;
};
const EMPTY_IDS: ReadonlySet<string> = new Set();
const UNDO_WINDOW_MS = 6000;

/** Project membership is reversible; the global paper and its sources stay intact. */
export function useLibraryRemoval(literature: LiteratureStore) {
  const writable = literature.writable ?? true;
  const scopeRef = useRef<RemovalScope>({client: literature.client, projectId: literature.projectId, writable, busy: false, request: 0});
  if (scopeRef.current.client !== literature.client || scopeRef.current.projectId !== literature.projectId ||
    scopeRef.current.writable !== writable) {
    scopeRef.current = {client: literature.client, projectId: literature.projectId, writable, busy: false, request: 0};
  }
  const scope = scopeRef.current;
  const literatureRef = useRef(literature);
  literatureRef.current = literature;
  const mounted = useRef(false);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const [state, setState] = useState<RemovalState | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const current = state?.scope === scope ? state : null;
  const active = useCallback(() => mounted.current && scopeRef.current === scope, [scope]);

  useEffect(() => {
    if (current === null || current.undoItems.length === 0) return;
    const timer = window.setTimeout(() => {
      setState(previous => previous?.scope === scope ? {...previous, undoItems: []} : previous);
    }, Math.max(0, current.deadline - Date.now()));
    return () => window.clearTimeout(timer);
  }, [scope, current?.deadline, current?.undoItems.length]);
  useEffect(() => {
    if (current === null || current.hiddenIds.size === 0) return;
    const listed = new Set(literature.items.map(item => item.id));
    const remaining = new Set([...current.hiddenIds].filter(id => listed.has(id)));
    if (remaining.size === current.hiddenIds.size) return;
    setState(previous => previous?.scope === scope ? {...previous, hiddenIds: remaining} : previous);
  }, [literature.items, current?.hiddenIds, scope]);

  const remove = useCallback((items: readonly ResearchLibraryItem[]): void => {
    if (!active() || !scope.writable || scope.projectId === null || scope.busy) return;
    const candidates = items.filter(item => item.projectIds.includes(scope.projectId!));
    if (candidates.length === 0) return;
    const request = ++scope.request;
    // A reader/editor can defer this operation until its draft is safely kept.
    requestReadingChange(scope.projectId, () => {
      if (!active() || scope.busy || scope.request !== request) return;
      scope.busy = true;
      setState(previous => ({scope, pending: true, hiddenIds: previous?.scope === scope ? previous.hiddenIds : EMPTY_IDS,
        undoItems: previous?.scope === scope ? previous.undoItems : [], deadline: previous?.scope === scope ? previous.deadline : 0, error: null}));
      void (async () => {
        const removed: ResearchLibraryItem[] = [];
        let failed = 0;
        try {
          for (const item of candidates) {
            if (!active()) return;
            let unlinked = false;
            try {unlinked = await literature.linkItem(item, false);} catch { /* Retain partial successes and a retryable failure. */ }
            if (unlinked) {
              if (!active()) return;
              removed.push(item);
              setState(previous => previous?.scope === scope
                ? {...previous, hiddenIds: new Set([...previous.hiddenIds, item.id])} : previous);
            } else failed++;
          }
          if (!active()) return;
          setState(previous => {
            if (previous?.scope !== scope) return previous;
            const undoItems = [...new Map([...previous.undoItems, ...removed].map(item => [item.id, item])).values()];
            return {...previous, pending: false, undoItems,
              deadline: removed.length === 0 ? previous.deadline : Date.now() + UNDO_WINDOW_MS,
              error: failed === 0 ? null : `${failed.toLocaleString('zh-CN')} 篇未能移除，请重试。`};
          });
          const latest = literatureRef.current;
          if (removed.some(item => item.id === latest.selectedId)) latest.select(null);
        } finally {
          scope.busy = false;
          if (active()) setState(previous => previous?.scope === scope ? {...previous, pending: false} : previous);
        }
      })();
    });
  }, [active, scope, literature.linkItem]);

  const undo = useCallback(async (): Promise<readonly string[]> => {
    const snapshot = stateRef.current;
    if (!active() || scope.busy || !scope.writable || snapshot?.scope !== scope || snapshot.undoItems.length === 0 ||
      snapshot.deadline < Date.now()) return [];
    scope.busy = true;
    setState(previous => previous?.scope === scope ? {...previous, pending: true, error: null} : previous);
    const failed: ResearchLibraryItem[] = [];
    const restoredIds: string[] = [];
    try {
      for (const item of snapshot.undoItems) {
        if (!active()) return [];
        let restored = false;
        try {restored = await literature.linkItem(item, true);} catch { /* This item remains available for Undo retry. */ }
        if (!active()) return [];
        if (!restored) failed.push(item);
        else {
          restoredIds.push(item.id);
          setState(previous => {
            if (previous?.scope !== scope) return previous;
            const hiddenIds = new Set(previous.hiddenIds); hiddenIds.delete(item.id);
            return {...previous, hiddenIds};
          });
        }
      }
      if (!active()) return [];
      setState(previous => previous?.scope === scope ? {...previous, pending: false, undoItems: failed,
        deadline: failed.length > 0 ? Date.now() + UNDO_WINDOW_MS : 0,
        error: failed.length === 0 ? null : `${failed.length.toLocaleString('zh-CN')} 篇未能恢复，可再次撤销。`} : previous);
      return restoredIds;
    } finally {
      scope.busy = false;
      if (active()) setState(previous => previous?.scope === scope ? {...previous, pending: false} : previous);
    }
  }, [active, scope, literature.linkItem]);
  const dismiss = useCallback(() => {
    if (!active()) return;
    setState(previous => previous?.scope === scope ? {...previous, undoItems: []} : previous);
  }, [active, scope]);
  return {remove, undo, dismiss, pending: current?.pending ?? false,
    hiddenIds: current?.hiddenIds ?? EMPTY_IDS, undoCount: current?.undoItems.length ?? 0, error: current?.error ?? null};
}
