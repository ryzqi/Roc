import {useCallback, useEffect, useMemo, useRef, useSyncExternalStore} from 'react';
import type {RocClient} from '../shared/roc-client';
import {useAsyncResource} from '../app/use-async-resource';

type StatusResult = Extract<Awaited<ReturnType<RocClient['api']['research']['getDocumentStatuses']>>, {ok: true}>['data'];
export type LibraryDocumentStatus = StatusResult['items'][number];

/**
 * Each row subscribes to its own receipts. Refreshing a different paper does not
 * re-render its metadata or disturb its focused actions.
 */
export class LibraryDocumentStatusSource {
  private items: ReadonlyMap<string, LibraryDocumentStatus> = new Map();
  private listeners = new Map<string, Set<() => void>>();
  private allListeners = new Set<() => void>();
  snapshot = (): ReadonlyMap<string, LibraryDocumentStatus> => this.items;
  get = (id: string): LibraryDocumentStatus | undefined => this.items.get(id);
  subscribeAll = (listener: () => void): (() => void) => {
    this.allListeners.add(listener);
    return () => {this.allListeners.delete(listener);};
  };
  subscribe = (id: string, listener: () => void): (() => void) => {
    const listeners = this.listeners.get(id) ?? new Set();
    listeners.add(listener);
    this.listeners.set(id, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(id);
    };
  };
  publish(items: readonly LibraryDocumentStatus[]): void {
    const next = new Map<string, LibraryDocumentStatus>();
    const changed = new Set(this.items.keys());
    for (const item of items) {
      const old = this.items.get(item.libraryItemId);
      if (old !== undefined && JSON.stringify(old.documents) === JSON.stringify(item.documents)) {
        next.set(item.libraryItemId, old);
        changed.delete(item.libraryItemId);
      } else {
        next.set(item.libraryItemId, item);
        changed.add(item.libraryItemId);
      }
    }
    if (changed.size === 0) return;
    this.items = next;
    for (const id of changed) for (const listener of this.listeners.get(id) ?? []) listener();
    for (const listener of this.allListeners) listener();
  }
}

export function useLibraryDocumentStatus(source: LibraryDocumentStatusSource | undefined, id: string): LibraryDocumentStatus | undefined {
  const subscribe = useCallback((changed: () => void) => source?.subscribe(id, changed) ?? (() => {}), [source, id]);
  const snapshot = useCallback(() => source?.get(id), [source, id]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** One bounded read per loaded window, with no per-row IPC or index rebuilding. */
export function useLibraryDocumentStatuses(client: RocClient, projectId: string | null, libraryItemIds: readonly string[]) {
  const identity = useRef({client, projectId, nonce: 0});
  if (identity.current.client !== client || identity.current.projectId !== projectId) {
    identity.current = {client, projectId, nonce: identity.current.nonce + 1};
  }
  const source = useMemo(() => new LibraryDocumentStatusSource(), [client, projectId]);
  const supported = typeof client.api.research.getDocumentStatuses === 'function';
  const key = libraryItemIds.length === 0 || !supported ? null
    : JSON.stringify(['library-document-statuses', identity.current.nonce, projectId, libraryItemIds]);
  const currentKey = useRef(key);
  currentKey.current = key;
  const resource = useAsyncResource(key, async () => {
    const items: LibraryDocumentStatus[] = [];
    for (let offset = 0; offset < libraryItemIds.length; offset += 1000) {
      if (currentKey.current !== key) break;
      const result = await client.api.research.getDocumentStatuses({projectId,
        libraryItemIds: libraryItemIds.slice(offset, offset + 1000)});
      if (currentKey.current !== key) break;
      if (!result.ok) return result;
      items.push(...result.data.items);
    }
    return {ok: true as const, data: {items}};
  }, {label: '核验文献处理状态'});
  useEffect(() => {
    if (libraryItemIds.length === 0) source.publish([]);
    else if (resource.data !== null) source.publish(resource.data.items);
  }, [source, resource.data, libraryItemIds.length]);
  const items = useSyncExternalStore(source.subscribeAll, source.snapshot, source.snapshot);
  return {source, items, status: resource.status, error: resource.error, reload: resource.reload};
}
