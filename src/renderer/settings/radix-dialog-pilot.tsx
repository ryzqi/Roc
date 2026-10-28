import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { AnimatePresence } from 'motion/react';
import * as motion from 'motion/react-m';
import { X } from 'lucide-react';
import {
  modalPopTransition,
  modalPopVariants,
  scrimTransition,
  scrimVariants
} from '../shared/motion';
import { captureDialogOpener, restoreDialogFocus } from '../shell/focus-trap';
import type { ConfirmDialogProps } from '../shell/ConfirmDialog';
import type { ModalShellProps } from '../shell/ModalShell';
import { useOverlayBehavior } from '../shell/use-overlay-behavior';
import { OVERLAY_Z_INDEX } from '../shell/overlay-stack';

/**
 * Radix pilot for the settings centre only.
 *
 * The existing ModalShell remains the app-wide default. Settings is lazy-loaded, so this
 * module and Radix stay out of AppShell's eager renderer graph while the pilot exercises the
 * real unsaved-draft confirmation flow.
 */
export type RadixSettingsDialogShellProps = Omit<ModalShellProps, 'kind'>;

export function RadixSettingsDialogShell({
  open,
  title,
  onClose,
  children,
  footer,
  widthClassName,
  testId,
  initialFocusRef,
  returnFocusSelector,
  beforeClose,
  closeOnBackdrop = true,
  bodyPadding = 'default',
  layer = 'dialog'
}: RadixSettingsDialogShellProps): React.JSX.Element {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const overlayId = useId();
  const openRef = useRef(open);
  const [radixOpen, setRadixOpen] = useState(open);
  openRef.current = open;

  // Keep Radix's modal lifecycle active until Motion has removed the exiting panel.
  useLayoutEffect(() => {
    if (open) {
      setRadixOpen(true);
    }
  }, [open]);

  const canClose = useCallback(() => (beforeClose === undefined ? true : beforeClose()), [beforeClose]);
  const close = useCallback(() => {
    if (!openRef.current || !canClose()) {
      return;
    }
    onClose();
  }, [canClose, onClose]);

  // Radix owns the focus trap, Escape handling, and modal accessibility. Roc still owns
  // its cross-layer stack so ambient drawers and app shortcuts keep their existing order.
  useOverlayBehavior({
    open: radixOpen,
    panelRef,
    onRequestClose: close,
    canClose,
    overlayId,
    layer,
    inertBackground: false,
    manageFocus: false
  });

  return (
    <Dialog.Root
      open={radixOpen}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          close();
        }
      }}
    >
      <Dialog.Portal>
        <AnimatePresence
          onExitComplete={() => {
            if (!openRef.current) {
              setRadixOpen(false);
            }
          }}
        >
          {open && radixOpen ? (
            <motion.div
              style={{ zIndex: OVERLAY_Z_INDEX[layer] }}
              variants={scrimVariants}
              initial={false}
              animate="animate"
              exit="exit"
              transition={modalPopTransition}
              className="fixed inset-0 flex"
              data-testid={testId ?? 'overlay'}
              data-overlay-kind="modal"
              data-overlay-layer={layer}
            >
              <Dialog.Overlay asChild>
                <motion.div
                  aria-hidden="true"
                  data-testid={testId === undefined ? undefined : `${testId}-scrim`}
                  variants={scrimVariants}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  transition={scrimTransition}
                  className="absolute inset-0 bg-[var(--overlay-scrim)]"
                />
              </Dialog.Overlay>
              <Dialog.Content
                asChild
                onOpenAutoFocus={(event) => {
                  openerRef.current =
                    returnFocusSelector === undefined
                      ? captureDialogOpener()
                      : document.querySelector<HTMLElement>(returnFocusSelector) ?? captureDialogOpener();
                  const preferred = initialFocusRef?.current;
                  if (preferred != null && preferred.isConnected && !preferred.hasAttribute('disabled')) {
                    event.preventDefault();
                    preferred.focus();
                  }
                }}
                onCloseAutoFocus={(event) => {
                  event.preventDefault();
                  restoreDialogFocus(openerRef.current);
                }}
                onPointerDownOutside={(event) => {
                  if (!closeOnBackdrop) {
                    event.preventDefault();
                  }
                }}
              >
                <motion.div
                  ref={panelRef}
                  variants={modalPopVariants}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  transition={modalPopTransition}
                  data-testid={testId === undefined ? undefined : `${testId}-panel`}
                  className={`relative z-10 m-auto flex max-h-[86vh] max-w-[92vw] flex-col overflow-hidden rounded-window border border-line bg-surface shadow-[var(--shadow-modal)] ${widthClassName ?? 'w-[680px]'}`}
                >
                  <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2.5">
                    <Dialog.Title asChild>
                      <h2 className="min-w-0 flex-1 truncate text-ink text-[var(--font-h3-size)]">{title}</h2>
                    </Dialog.Title>
                    <button
                      type="button"
                      onClick={close}
                      aria-label={`关闭${title}`}
                      data-testid={testId === undefined ? undefined : `${testId}-close`}
                      className="flex h-7 w-7 items-center justify-center rounded-control text-muted hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)]"
                    >
                      <X size={14} aria-hidden="true" />
                    </button>
                  </div>

                  <Dialog.Description asChild>
                    <div
                      className={
                        bodyPadding === 'none'
                          ? 'min-h-0 flex-1 overflow-hidden'
                          : 'min-h-0 flex-1 overflow-y-auto px-4 py-3'
                      }
                    >
                      {children}
                    </div>
                  </Dialog.Description>

                  {footer === undefined ? null : (
                    <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-2.5">
                      {footer}
                    </div>
                  )}
                </motion.div>
              </Dialog.Content>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function RadixSettingsConfirmDialog({
  open,
  title,
  message,
  detail,
  confirmLabel,
  confirmDisabled = false,
  cancelLabel = '取消',
  tone = 'default',
  onConfirm,
  onCancel,
  testId = 'confirm-dialog'
}: ConfirmDialogProps): React.JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <RadixSettingsDialogShell
      open={open}
      title={title}
      onClose={onCancel}
      closeOnBackdrop={false}
      widthClassName="w-[420px]"
      testId={testId}
      initialFocusRef={cancelRef}
      footer={
        <>
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            data-testid={`${testId}-cancel`}
            className="h-[var(--control-height)] rounded-control border border-line px-3 text-ink hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)]"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={confirmDisabled}
            data-testid={`${testId}-confirm`}
            className={
              tone === 'destructive'
                ? 'h-[var(--control-height)] rounded-control border border-[var(--st-bad-line)] px-3 text-[var(--st-bad)] hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)] disabled:pointer-events-none disabled:opacity-50'
                : 'h-[var(--control-height)] rounded-control bg-[var(--fill-strong)] px-3 text-[var(--fill-strong-text)] active:bg-[var(--accent-deep)] disabled:pointer-events-none disabled:opacity-50'
            }
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="text-ink" data-testid={`${testId}-message`}>
        {message}
      </p>
      {detail === undefined ? null : <p className="mt-2 text-muted text-[var(--font-meta-size)]">{detail}</p>}
    </RadixSettingsDialogShell>
  );
}
