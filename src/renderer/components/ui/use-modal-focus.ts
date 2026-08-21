import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

import {
  captureDialogOpener,
  focusDialogInitialElement,
  restoreDialogFocus,
  trapDialogTabFocus
} from '../../dialog-focus';

export function useModalFocus({ initialRef, onDismiss, open, panelRef }: {
  initialRef: RefObject<HTMLElement | null>;
  onDismiss: () => void;
  open: boolean;
  panelRef: RefObject<HTMLElement | null>;
}): void {
  const openerRef = useRef<HTMLElement | null>(null);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (!open || panelRef.current === null) return;
    openerRef.current = captureDialogOpener();
    focusDialogInitialElement(panelRef.current, initialRef.current);

    function handleKey(event: KeyboardEvent): void {
      if (panelRef.current !== null && trapDialogTabFocus(panelRef.current, event)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onDismissRef.current();
      }
    }

    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      restoreDialogFocus(openerRef.current);
    };
  }, [initialRef, open, panelRef]);
}
