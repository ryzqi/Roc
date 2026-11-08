import { createContext, useContext, useEffect, useEffectEvent, useRef, useSyncExternalStore, type ReactNode } from 'react';

const ViewActivityContext = createContext(true);

/** CSS-hidden views stay mounted to retain drafts, selection and native sessions. */
export function ViewActivity({ active, children }: { active: boolean; children: ReactNode }): React.JSX.Element {
  const parentActive = useContext(ViewActivityContext);
  return <ViewActivityContext value={parentActive && active}>{children}</ViewActivityContext>;
}

function subscribeVisibility(changed: () => void): () => void {
  document.addEventListener('visibilitychange', changed);
  return () => document.removeEventListener('visibilitychange', changed);
}
const documentVisible = (): boolean => document.visibilityState === 'visible';

export function useViewActive(): boolean {
  const active = useContext(ViewActivityContext);
  const visible = useSyncExternalStore(subscribeVisibility, documentVisible);
  return active && visible;
}

/** Initial reads belong to the resource; refresh immediately only on returning to a view. */
export function useVisiblePolling(refresh: () => void, intervalMs: number, enabled = true): void {
  const active = useViewActive();
  const wasActive = useRef(active);
  const tick = useEffectEvent(refresh);
  useEffect(() => {
    const resumed = active && !wasActive.current;
    wasActive.current = active;
    if (!active || !enabled) return;
    if (resumed) tick();
    const timer = window.setInterval(() => tick(), intervalMs);
    return () => window.clearInterval(timer);
  }, [active, enabled, intervalMs]);
}
