import { useRef } from 'react';
import type React from 'react';

import { Button } from './Button';
import { useModalFocus } from './use-modal-focus';

export function ConfirmDialog({
  cancelLabel = '取消',
  confirmLabel,
  description,
  onCancel,
  onConfirm,
  open,
  title,
  tone = 'danger'
}: {
  cancelLabel?: string;
  confirmLabel: string;
  description: string;
  onCancel: () => void;
  onConfirm: () => void;
  open: boolean;
  title: string;
  tone?: 'danger' | 'primary';
}): React.JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useModalFocus({ initialRef: cancelRef, onDismiss: onCancel, open, panelRef });

  if (!open) return null;
  return (
    <div className="ui-dialog-backdrop" onMouseDown={onCancel} role="presentation">
      <div
        aria-describedby="ui-confirm-description"
        aria-labelledby="ui-confirm-title"
        aria-modal="true"
        className="ui-confirm-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        ref={panelRef}
        role="alertdialog"
        tabIndex={-1}
      >
        <h2 id="ui-confirm-title">{title}</h2>
        <p id="ui-confirm-description">{description}</p>
        <div className="ui-confirm-dialog__actions">
          <Button onClick={onCancel} ref={cancelRef} variant="secondary">{cancelLabel}</Button>
          <Button onClick={onConfirm} variant={tone}>{confirmLabel}</Button>
        </div>
      </div>
    </div>
  );
}
