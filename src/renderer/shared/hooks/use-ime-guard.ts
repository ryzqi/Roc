import { useCallback, useRef, type KeyboardEvent } from 'react';

/** Protect custom keyboard actions from the candidate-confirmation Enter. */
export function useImeGuard() {
  const composing = useRef(false);
  const endedAt = useRef(Number.NEGATIVE_INFINITY);
  const onCompositionStart = useCallback(() => {
    composing.current = true;
    endedAt.current = Number.NEGATIVE_INFINITY;
  }, []);
  const onCompositionEnd = useCallback(() => {
    composing.current = false;
    endedAt.current = performance.now();
  }, []);
  const shouldIgnoreKeyDown = useCallback((event: KeyboardEvent<HTMLElement>): boolean => {
    if (event.nativeEvent.isComposing || composing.current || event.nativeEvent.keyCode === 229) return true;
    // Consume one companion key, so a deliberate following Enter still works.
    if (event.key === 'Enter' && performance.now() - endedAt.current < 500) {
      event.preventDefault();
      endedAt.current = Number.NEGATIVE_INFINITY;
      return true;
    }
    if (!['Shift', 'Control', 'Meta'].includes(event.key)) endedAt.current = Number.NEGATIVE_INFINITY;
    return false;
  }, []);
  return { onCompositionStart, onCompositionEnd, shouldIgnoreKeyDown };
}
