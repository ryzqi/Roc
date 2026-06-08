import { useEffect, useState } from 'react';

export function useActivityBlockState(input: {
  defaultOpen: boolean;
  forceOpenWhileStreaming?: boolean;
  isStreaming?: boolean;
}): {
  open: boolean;
  setOpen: (open: boolean) => void;
} {
  const [open, setOpenState] = useState(input.defaultOpen || Boolean(input.forceOpenWhileStreaming && input.isStreaming));
  const [userChanged, setUserChanged] = useState(false);

  useEffect(() => {
    if (!userChanged && input.forceOpenWhileStreaming && input.isStreaming) {
      setOpenState(true);
    }
  }, [input.forceOpenWhileStreaming, input.isStreaming, userChanged]);

  return {
    open,
    setOpen: (nextOpen) => {
      setUserChanged(true);
      setOpenState(nextOpen);
    }
  };
}
