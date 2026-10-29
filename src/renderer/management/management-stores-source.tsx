import { useLayoutEffect, useState } from 'react';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ManagementScope } from './management-scope';
import { useManagementStoresSource } from './use-management-stores';
import type { ManagementStores, ManagementStoresApi } from './management-stores-types';

export function ManagementStoresSource({
  scope,
  scopeKey,
  onReady
}: {
  scope: ManagementScope;
  scopeKey: string;
  onReady: (scopeKey: string, store: ManagementStoresApi) => void;
}): null {
  const snapshot = useManagementStoresSource(scope);
  const [store] = useState<StoreApi<ManagementStores | null>>(() => createStore<ManagementStores | null>()(() => snapshot));

  useLayoutEffect(() => {
    store.setState(snapshot, true);
    onReady(scopeKey, store);
  }, [onReady, scopeKey, snapshot, store]);

  return null;
}