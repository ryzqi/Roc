import { useEffect, useRef, useState } from 'react';

export function useActivityBlockState(input: {
  defaultOpen: boolean;
  forceOpenWhileStreaming?: boolean;
  isStreaming?: boolean;
  autoCloseDelayMs?: number;
}): {
  open: boolean;
  setOpen: (open: boolean) => void;
} {
  const [open, setOpenState] = useState(input.defaultOpen || Boolean(input.forceOpenWhileStreaming && input.isStreaming));
  const [userChanged, setUserChanged] = useState(false);
  const wasStreamingRef = useRef(Boolean(input.isStreaming));

  useEffect(() => {
    if (!userChanged && input.forceOpenWhileStreaming && input.isStreaming) {
      setOpenState(true);
    }
  }, [input.forceOpenWhileStreaming, input.isStreaming, userChanged]);

  useEffect(() => {
    const wasStreaming = wasStreamingRef.current;
    wasStreamingRef.current = Boolean(input.isStreaming);

    if (!wasStreaming || input.isStreaming || input.autoCloseDelayMs === undefined || !open) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setOpenState(false);
    }, input.autoCloseDelayMs);

    return () => window.clearTimeout(timeoutId);
  }, [input.autoCloseDelayMs, input.isStreaming, open]);

  return {
    open,
    setOpen: (nextOpen) => {
      setUserChanged(true);
      setOpenState(nextOpen);
    }
  };
}
