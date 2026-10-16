import { useCallback, useMemo, useState } from 'react';

/**
 * Optimistic switch state for toggles whose truth lives in the backend (P9).
 *
 * A checkbox whose `checked` comes straight from a backend snapshot has a visible flaw: the click
 * round-trips to the main process, the list re-reads, and only then does the box move. Playwright's
 * `uncheck()` even refuses to accept the click ("Clicking the checkbox did not change its state" —
 * the P9 gate hit it), and a user clicking twice quickly would toggle twice.
 *
 * So a toggle records the intended value here **immediately**, the UI reads `flags[id] ?? snapshot`,
 * and the flag is dropped as soon as a fresh read arrives (the read is the authority again). The
 * hook is shared by the skills and MCP toggles so the two behave identically.
 */
export type OptimisticFlags = {
  /** The value to render for an id: the pending intent, or undefined when the snapshot is authoritative. */
  valueFor: (id: string, fallback: boolean) => boolean;
  set: (id: string, value: boolean) => void;
  /** Called after every successful list/config read: the snapshot is the truth again. */
  clear: () => void;
};

export function useOptimisticFlags(): OptimisticFlags {
  const [flags, setFlags] = useState<Record<string, boolean>>({});

  const valueFor = useCallback((id: string, fallback: boolean): boolean => flags[id] ?? fallback, [flags]);
  const set = useCallback((id: string, value: boolean) => {
    setFlags((current) => ({ ...current, [id]: value }));
  }, []);
  const clear = useCallback(() => {
    // Returning the *same* object when there is nothing to clear matters: `clear()` runs inside a
    // list-load effect, and a fresh `{}` on every call would change this hook's identity, re-run
    // that effect, call `clear()` again — a read loop (the reason the value is kept in one place
    // and the effect depends on `clear` alone).
    setFlags((current) => (Object.keys(current).length === 0 ? current : {}));
  }, []);

  return useMemo(() => ({ valueFor, set, clear }), [valueFor, set, clear]);
}
