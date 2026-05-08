import { useEffect } from 'react';
import type React from 'react';

export function SettingsModal({
  children,
  onClose
}: {
  children: React.ReactNode;
  onClose: () => void;
}): React.JSX.Element {
  useEffect(() => {
    function handleKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div
      className="settings-modal-backdrop"
      data-testid="settings-modal-backdrop"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="settings-modal"
        data-testid="settings-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="设置"
      >
        <header className="settings-modal-titlebar">
          <span className="settings-modal-title">设置</span>
          <button
            className="settings-modal-close"
            data-testid="settings-modal-close"
            onClick={onClose}
            type="button"
            aria-label="关闭设置"
          >
            ×
          </button>
        </header>
        <div className="settings-modal-body">{children}</div>
      </div>
    </div>
  );
}
