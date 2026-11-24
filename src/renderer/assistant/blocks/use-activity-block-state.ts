import { useCallback, useEffect, useRef, useState } from 'react';
import {useBlockDisclosure, type ActivityDisclosureKind} from './disclosure-state';

export function useActivityBlockState(input: {
  defaultOpen: boolean;
  /** Retain disclosure through virtual unmounts within the current message window. */
  disclosureKey?: string;
  disclosureKind?: ActivityDisclosureKind;
  /** Reveal a newly important receipt once; later updates preserve manual disclosure. */
  revealOn?: boolean;
  forceOpenWhileStreaming?: boolean;
  isStreaming?: boolean;
  autoCloseDelayMs?: number;
}): {
  open: boolean;
  setOpen: (open: boolean) => void;
} {
  const retained = useBlockDisclosure(input.disclosureKey, input.disclosureKind);
  const owner = retained?.state;
  const key = retained?.key;
  const previous = owner === undefined || key === undefined ? undefined : owner.blocks.get(key);
  const revealOn = Boolean(input.revealOn);
  const streaming = Boolean(input.isStreaming);
  const [open, setOpenState] = useState(() =>
    Boolean(input.forceOpenWhileStreaming && streaming) ||
    (revealOn && !previous?.revealOn) ||
    (previous === undefined ? input.defaultOpen :
      previous.open && (previous.autoCloseAt === null || previous.autoCloseAt > Date.now()))
  );
  const openRef = useRef(open);
  const autoCloseAtRef = useRef(previous?.autoCloseAt ?? null);
  const wasStreamingRef = useRef(previous?.streaming ?? streaming);
  const wasRevealedRef = useRef(previous?.revealOn ?? false);
  const persist = useCallback((next: boolean): void => {
    if (owner !== undefined && key !== undefined) {
      owner.blocks.set(key, {open: next, revealOn, streaming, autoCloseAt: autoCloseAtRef.current});
    }
  }, [owner, key, revealOn, streaming]);
  const setOpen = useCallback((next: boolean): void => {
    // Native details also emits toggle when React restores its open attribute.
    // That notification must not cancel a pending completion collapse.
    if (next === openRef.current) return;
    openRef.current = next;
    autoCloseAtRef.current = null;
    persist(next);
    setOpenState(next);
  }, [persist]);

  useEffect(() => {
    persist(open);
  }, [persist, open]);

  useEffect(() => {
    // Depend on the condition's edge, not on open or the changing receipt payload:
    // a new failure is revealed, then the user's choice to collapse it is retained.
    const wasRevealed = wasRevealedRef.current;
    wasRevealedRef.current = revealOn;
    if (revealOn && !wasRevealed) setOpen(true);
  }, [revealOn, setOpen]);

  useEffect(() => {
    if (input.forceOpenWhileStreaming && input.isStreaming && !open) {
      setOpen(true);
    }
  }, [input.forceOpenWhileStreaming, input.isStreaming, open, setOpen]);

  useEffect(() => {
    const wasStreaming = wasStreamingRef.current;
    wasStreamingRef.current = Boolean(input.isStreaming);

    if (input.isStreaming || input.autoCloseDelayMs === undefined || !open) {
      autoCloseAtRef.current = null;
      persist(open);
      return;
    }
    if (wasStreaming) autoCloseAtRef.current = Date.now() + input.autoCloseDelayMs;
    const closeAt = autoCloseAtRef.current;
    if (closeAt === null) return;
    persist(open);
    const timeoutId = window.setTimeout(() => {
      setOpen(false);
    }, Math.max(0, closeAt - Date.now()));

    return () => window.clearTimeout(timeoutId);
  }, [input.autoCloseDelayMs, input.isStreaming, open, setOpen, persist]);

  return {
    open,
    setOpen
  };
}
