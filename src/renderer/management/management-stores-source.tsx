import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ManagementScope } from './management-scope';
import { useManagementStoresSource } from './use-management-stores';
import type { ManagementStores, ManagementStoresApi } from './management-stores-types';
import { BEFORE_NAVIGATE, type NavigationRequest } from '../app/navigation-guard';
import { ConfirmDialog } from '../shell/ConfirmDialog';
import { discardManagementDrafts, managementDraftState } from './management-draft-state';

export function ManagementStoresSource({
  scope,
  scopeKey,
  onReady
}: {
  scope: ManagementScope;
  scopeKey: string;
  onReady: (scopeKey: string, store: ManagementStoresApi) => void;
}): React.JSX.Element {
  const snapshot = useManagementStoresSource(scope);
  const [store] = useState<StoreApi<ManagementStores | null>>(() => createStore<ManagementStores | null>()(() => snapshot));
  const latest = useRef(snapshot);
  latest.current = snapshot;
  const pendingNavigation = useRef<(() => void) | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const drafts = managementDraftState(snapshot);

  useLayoutEffect(() => {
    store.setState(snapshot, true);
    onReady(scopeKey, store);
  }, [onReady, scopeKey, snapshot, store]);

  useEffect(() => {
    const navigate = (event: Event): void => {
      const request = event as CustomEvent<NavigationRequest>;
      if (request.detail.next.projectId === scope.projectId) return;
      const current = managementDraftState(latest.current);
      if (current.busy) {
        request.preventDefault();
        return;
      }
      if (current.sections.length === 0) return;
      pendingNavigation.current = request.detail.defer();
      setDiscardOpen(true);
    };
    const unload = (event: BeforeUnloadEvent): void => {
      const current = managementDraftState(latest.current);
      if (!current.busy && current.sections.length === 0) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener(BEFORE_NAVIGATE, navigate);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener(BEFORE_NAVIGATE, navigate);
      window.removeEventListener('beforeunload', unload);
    };
  }, [scope.projectId]);

  // A successful save may make the deferred transition safe without discarding.
  useEffect(() => {
    if (!discardOpen || drafts.busy || drafts.sections.length > 0) return;
    const resume = pendingNavigation.current;
    pendingNavigation.current = null;
    setDiscardOpen(false);
    resume?.();
  }, [discardOpen, drafts.busy, drafts.sections.length]);

  return <ConfirmDialog
    open={discardOpen}
    title="切换项目前处理管理改动"
    message={drafts.busy ? '当前操作尚未完成，请等待结果。' : `${drafts.sections.join('、')} 尚未保存。`}
    detail="放弃后这些改动不会保存。"
    confirmLabel="放弃修改并切换"
    cancelLabel="继续编辑"
    tone="destructive"
    confirmDisabled={drafts.busy}
    testId="mgmt-navigation-discard"
    onCancel={() => { pendingNavigation.current = null; setDiscardOpen(false); }}
    onConfirm={() => {
      if (managementDraftState(latest.current).busy) return;
      const resume = pendingNavigation.current;
      pendingNavigation.current = null;
      setDiscardOpen(false);
      discardManagementDrafts(latest.current);
      resume?.();
    }}
  />;
}
