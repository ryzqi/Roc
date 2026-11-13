import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { LazyBoundary, retryableLazy } from '../shell/LazyBoundary';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { ManagementStores, ManagementStoresApi, ManagementStoresSnapshot } from './management-stores-types';
import type { ManagementScope } from './management-scope';

const ManagementStoresSource = retryableLazy(async () => ({
  default: (await import('./management-stores-source')).ManagementStoresSource
}));

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
      {enabled ? (
        <LazyBoundary fallback={null}>
          <ManagementStoresSource key={scopeKey} scope={scope} scopeKey={scopeKey} onReady={register} />
        </LazyBoundary>
      ) : null}
      {children}
    </ManagementStoresContext.Provider>
  );
}

/** Selects a stable slice from the current project's shared management store. */
export function useManagementStores<Selected>(selector: (stores: ManagementStores) => Selected): Selected | null {
  const store = useContext(ManagementStoresContext);
  return useStore(store, (snapshot) => (snapshot === null ? null : selector(snapshot)));
}
