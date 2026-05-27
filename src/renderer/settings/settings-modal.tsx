import { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type React from 'react';
import { modalBackdropFade, modalPop, modalPopTransition, resolveMotionTransition } from '../animations';
import { focusDialogInitialElement, trapDialogTabFocus } from '../dialog-focus';

export function SettingsModal({
  children,
  onClose
}: {
  children: React.ReactNode;
  onClose: () => void;
}): React.JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (panelRef.current === null) {
      return;
    }
    focusDialogInitialElement(panelRef.current, null);
  }, []);

  useEffect(() => {
    function handleKey(event: KeyboardEvent): void {
      if (panelRef.current !== null && trapDialogTabFocus(panelRef.current, event)) {
        return;
      }
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
        transition={resolveMotionTransition({ duration: 0.16 })}
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
          ref={panelRef}
          role="dialog"
          tabIndex={-1}
          transition={resolveMotionTransition(modalPopTransition)}
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
