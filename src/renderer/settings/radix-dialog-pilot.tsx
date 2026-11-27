import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { AnimatePresence } from 'motion/react';
import * as motion from 'motion/react-m';
import { LoaderCircle, X } from 'lucide-react';
import { OverlayMotionSurface } from '../shell/OverlayMotionSurface';
import { captureDialogOpener, focusDialogInitialElement, restoreDialogFocus } from '../shell/focus-trap';
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
export type RadixSettingsDialogShellProps = Omit<ModalShellProps, 'kind'> & {
  descriptionId?: string;
  /** Plain confirmations have no inner popup; they must own Escape from first autofocus. */
  captureEscape?: boolean;
};

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
  closeDisabled = false,
  descriptionId,
  closeOnBackdrop = true,
  bodyPadding = 'default',
  layer = 'dialog',
  captureEscape = false
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

  const canClose = useCallback(() => !closeDisabled && (beforeClose?.() ?? true), [beforeClose, closeDisabled]);
  const close = useCallback(() => {
    if (!openRef.current || !canClose()) {
      return;
    }
    onClose();
  }, [canClose, onClose]);

  // Radix owns focus, Tab and modal accessibility. Plain confirmations opt into Roc's
  // Escape capture because Radix's highest-layer listener can lag behind first autofocus.
  // Form dialogs retain Radix's handling so inner selects/popups keep their Escape behavior.
  useOverlayBehavior({
    open: radixOpen,
    panelRef,
    onRequestClose: close,
    canClose,
    overlayId,
    layer,
    inertBackground: false,
    modal: true,
    manageFocus: false,
    captureEscape
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
              className="ui-modal-layout fixed inset-0"
              data-testid={testId ?? 'overlay'}
              data-overlay-kind="modal"
              data-overlay-layer={layer}
            >
              <Dialog.Overlay asChild>
                <OverlayMotionSurface kind="modal" scrim
                  aria-hidden="true"
                  data-testid={testId === undefined ? undefined : `${testId}-scrim`}
                  className="absolute inset-0 bg-[var(--overlay-scrim)]"
                />
              </Dialog.Overlay>
              <Dialog.Content
                asChild
                aria-describedby={descriptionId}
                onEscapeKeyDown={(event) => {
                  if (closeDisabled) event.preventDefault();
                }}
                onOpenAutoFocus={(event) => {
                  openerRef.current =
                    returnFocusSelector === undefined
                      ? captureDialogOpener()
                      : document.querySelector<HTMLElement>(returnFocusSelector) ?? captureDialogOpener();
                  const preferred = initialFocusRef?.current;
                  if (initialFocusRef !== undefined && panelRef.current !== null) {
                    event.preventDefault();
                    focusDialogInitialElement(panelRef.current, preferred ?? null);
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
                <OverlayMotionSurface kind="modal"
                  ref={panelRef}
                  data-testid={testId === undefined ? undefined : `${testId}-panel`}
                  className={`relative z-10 row-start-2 mx-auto flex max-h-[min(86vh,calc(100dvh-2*var(--shadow-modal-gutter-block)))] max-w-[min(92vw,calc(100vw-2*var(--shadow-modal-gutter-inline)))] flex-col overflow-hidden rounded-window border-[0.5px] border-line-default bg-surface-overlay shadow-[var(--shadow-modal)] ${widthClassName ?? 'w-[680px]'}`}
                >
                  <div className="flex shrink-0 items-center gap-2 border-b-[0.5px] border-line px-4 py-2">
                    <Dialog.Title asChild>
                      <h2 className="min-w-0 flex-1 text-balance text-ink text-[length:var(--font-h3-size)]">{title}</h2>
                    </Dialog.Title>
                    <button
                      type="button"
                      onClick={close}
                      disabled={closeDisabled}
                      aria-label={`关闭${title}`}
                      data-testid={testId === undefined ? undefined : `${testId}-close`}
                      className="flex size-7 shrink-0 items-center justify-center rounded-control text-muted hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)] disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring"
                    >
                      <X size={14} aria-hidden="true" />
                    </button>
                  </div>

                  <div
                      className={
                        bodyPadding === 'none'
                          ? 'min-h-0 min-w-0 flex-1 overflow-hidden'
                          : 'ui-scroll-region flex-1 px-4 py-3'
                      }
                    >
                      {children}
                  </div>

                  {footer === undefined ? null : (
                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t-[0.5px] border-line px-4 py-2">
                      {footer}
                    </div>
                  )}
                </OverlayMotionSurface>
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
  pending = false,
  cancelLabel = '取消',
  tone = 'default',
  onConfirm,
  onCancel,
  testId = 'confirm-dialog',
  error
}: ConfirmDialogProps & { error?: string | null }): React.JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const messageId = useId();
  const actionClass = 'inline-flex min-h-[var(--control-height)] items-center justify-center gap-2 rounded-control border-[0.5px] px-3 text-[length:var(--font-meta-size)] enabled:active:translate-y-px disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring';

  return (
    <RadixSettingsDialogShell
      open={open}
      title={title}
      onClose={onCancel}
      closeDisabled={pending}
      closeOnBackdrop={false}
      captureEscape
      descriptionId={messageId}
      widthClassName="w-[400px]"
      testId={testId}
      initialFocusRef={cancelRef}
      footer={
        <>
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={pending}
            data-testid={`${testId}-cancel`}
            className={`${actionClass} border-line text-ink enabled:hover:bg-[var(--overlay-hover)]`}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={confirmDisabled || pending}
            aria-busy={pending || undefined}
            data-testid={`${testId}-confirm`}
            className={
              tone === 'destructive'
                ? `${actionClass} border-[var(--st-bad-line)] text-[var(--st-bad)] enabled:hover:bg-[var(--overlay-hover)]`
                : `${actionClass} border-transparent bg-[var(--fill-strong)] text-[var(--fill-strong-text)] enabled:hover:bg-[var(--fill-strong-hover)]`
            }
          >
            {pending ? <LoaderCircle size={12} aria-hidden="true" className="motion-safe:animate-spin" /> : null}
            {confirmLabel}
          </button>
        </>
      }
    >
      <p id={messageId} className="text-ink" data-testid={`${testId}-message`}>
        {message}
      </p>
      {detail === undefined ? null : <p className="mt-2 whitespace-pre-line text-muted text-[length:var(--font-meta-size)]">{detail}</p>}
      {error == null ? null : <p className="mt-2 text-[var(--st-bad)]" role="alert">{error}</p>}
    </RadixSettingsDialogShell>
  );
}
