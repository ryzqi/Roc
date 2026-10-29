import { createContext, useCallback, useContext, useLayoutEffect, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ManagementScope } from './management-scope';
import { useManagementStoresSource, type ManagementStores } from './use-management-stores';

type ManagementStoresSnapshot = ManagementStores | null;
type ManagementStoresApi = StoreApi<ManagementStoresSnapshot>;

type ManagementStoresRegistration = {
  scopeKey: string;
  store: ManagementStoresApi;
};

const EMPTY_MANAGEMENT_STORES = createStore<ManagementStoresSnapshot>()(() => null);
const ManagementStoresContext = createContext<ManagementStoresApi>(EMPTY_MANAGEMENT_STORES);

/**
 * Shares one lazily-created management source-hook set between the drawer and canvas.
 * The keyed source owner resets data when the project/workspace changes without remounting the app shell.
 */
export function ManagementStoresProvider({
  enabled,
  scope,
  scopeKey,
  children
}: {
  enabled: boolean;
  scope: ManagementScope;
  scopeKey: string;
  children: ReactNode;
}): React.JSX.Element {
  const [registration, setRegistration] = useState<ManagementStoresRegistration | null>(null);
  const register = useCallback((nextScopeKey: string, store: ManagementStoresApi) => {
    setRegistration((current) => {
      if (current?.scopeKey === nextScopeKey && current.store === store) {
        return current;
      }
      return { scopeKey: nextScopeKey, store };
    });
  }, []);
  const store = enabled && registration?.scopeKey === scopeKey ? registration.store : EMPTY_MANAGEMENT_STORES;

  return (
    <ManagementStoresContext.Provider value={store}>
      {enabled ? <ManagementStoresSource key={scopeKey} scope={scope} scopeKey={scopeKey} onReady={register} /> : null}
      {children}
    </ManagementStoresContext.Provider>
  );
}

function ManagementStoresSource({
  scope,
  scopeKey,
  onReady
}: {
  scope: ManagementScope;
  scopeKey: string;
  onReady: (scopeKey: string, store: ManagementStoresApi) => void;
}): null {
  const snapshot = useManagementStoresSource(scope);
  const [store] = useState<ManagementStoresApi>(() => createStore<ManagementStoresSnapshot>()(() => snapshot));

  useLayoutEffect(() => {
    store.setState(snapshot, true);
    onReady(scopeKey, store);
  }, [onReady, scopeKey, snapshot, store]);

  return null;
}

/** Selects a stable slice from the current project's shared management store. */
export function useManagementStores<Selected>(selector: (stores: ManagementStores) => Selected): Selected | null {
  const store = useContext(ManagementStoresContext);
  return useStore(store, (snapshot) => (snapshot === null ? null : selector(snapshot)));
}
