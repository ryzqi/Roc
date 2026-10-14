import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Copy-to-clipboard with a short "已复制" confirmation.
 *
 * The legacy shell grew several near-identical copies of this; one hook keeps
 * the failure path (clipboard denied) visible instead of silently doing
 * nothing.
 */

export type CopyFeedback = {
  copied: boolean;
  error: string | null;
  copy: (value: string) => void;
};

export function useCopyFeedback(resetAfterMs = 1500): CopyFeedback {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    },
    []
  );

  const copy = useCallback(
    (value: string) => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
      void (async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setError(null);
        } catch {
          setCopied(false);
          setError('剪贴板不可用，请手动复制。');
        }
        timerRef.current = window.setTimeout(() => setCopied(false), resetAfterMs);
      })();
    },
    [resetAfterMs]
  );

  return { copied, error, copy };
}
