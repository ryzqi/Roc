import { useEffect } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type React from 'react';
import { modalBackdropFade, modalPop, modalPopTransition } from '../animations';

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
    <AnimatePresence>
      <motion.div
        animate="animate"
        className="settings-modal-backdrop"
        data-testid="settings-modal-backdrop"
        exit="exit"
        initial="initial"
        onClick={onClose}
        role="presentation"
        transition={{ duration: 0.16 }}
        variants={modalBackdropFade}
      >
        <motion.div
          animate="animate"
          aria-label="设置"
          aria-modal="true"
          className="settings-modal"
          data-testid="settings-modal"
          exit="exit"
          initial="initial"
          onClick={(event) => event.stopPropagation()}
          role="dialog"
          transition={modalPopTransition}
          variants={modalPop}
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
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
