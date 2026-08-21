import { useRef } from 'react';
import { X } from 'lucide-react';
import type React from 'react';

import { IconButton } from './IconButton';
import { useModalFocus } from './use-modal-focus';

export function Drawer({
  children,
  footer,
  onClose,
  open,
  subtitle,
  title,
  variant = 'drawer'
}: {
  children: React.ReactNode;
  footer?: React.ReactNode;
  onClose: () => void;
  open: boolean;
  subtitle?: string;
  title: string;
  variant?: 'drawer' | 'modal';
}): React.JSX.Element | null {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useModalFocus({ initialRef: closeRef, onDismiss: onClose, open, panelRef });

  if (!open) return null;
  const isModal = variant === 'modal';
  return (
    <div className={isModal ? 'ui-drawer-backdrop ui-drawer-backdrop--modal' : 'ui-drawer-backdrop'} onMouseDown={onClose} role="presentation">
      <aside
        aria-label={title}
        aria-modal="true"
        className={isModal ? 'ui-drawer ui-drawer--modal' : 'ui-drawer'}
        onMouseDown={(event) => event.stopPropagation()}
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="ui-drawer__header">
          <div className="ui-drawer__heading">
            <h2>{title}</h2>
            {subtitle === undefined ? null : <p>{subtitle}</p>}
          </div>
          <IconButton label="关闭" ref={closeRef} onClick={onClose}><X size={17} /></IconButton>
        </header>
        <div className="ui-drawer__body">{children}</div>
        {footer === undefined ? null : <footer className="ui-drawer__footer">{footer}</footer>}
      </aside>
    </div>
  );
}
