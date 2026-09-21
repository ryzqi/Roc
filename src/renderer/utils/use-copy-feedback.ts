import { useCallback, useEffect, useRef, useState } from 'react';

export function useCopyFeedback(resetMs = 2000): {
  copied: boolean;
  markCopied(): void;
} {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  const markCopied = useCallback((): void => {
    setCopied(true);
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
    }
    resetTimerRef.current = window.setTimeout(() => {
      resetTimerRef.current = null;
      setCopied(false);
    }, resetMs);
  }, [resetMs]);

  return { copied, markCopied };
}
