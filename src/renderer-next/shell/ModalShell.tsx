import { useCallback, useId, useRef, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useOverlayBehavior } from './use-overlay-behavior';

/**
 * Shared overlay shell for drawers and modals (MASTER v2 §5 / §6.7).
 *
 * One implementation so the four requirements cannot drift between overlays:
 * focus trap, Escape closing one layer at a time, `aria-modal` semantics, and a
 * before-close guard that unsaved drafts can veto.
 *
 * Rendered through a portal so a drawer can stack above a modal without either
 * needing to know the other's DOM position.
 */

export type OverlayKind = 'modal' | 'drawer';

export type ModalShellProps = {
  open: boolean;
  title: string;
  kind?: OverlayKind;
  onClose: () => void;
  children: React.ReactNode;
  /** Rendered in a fixed footer, below the scrolling body. */
  footer?: React.ReactNode;
  widthClassName?: string;
  testId?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Return false to keep the overlay open (e.g. unsaved draft confirmation). */
  beforeClose?: () => boolean;
  /** Clicking the scrim closes. Set false for destructive flows. */
  closeOnBackdrop?: boolean;
};

export function ModalShell({
  open,
  title,
  kind = 'modal',
  onClose,
  children,
  footer,
  widthClassName,
  testId,
  initialFocusRef,
  beforeClose,
  closeOnBackdrop = true
}: ModalShellProps): React.JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const overlayId = useId();
  const bodyId = useId();

  const canClose = useCallback(() => (beforeClose === undefined ? true : beforeClose()), [beforeClose]);

  // Background inertness lives in the hook, which reference-counts the overlay
  // stack so layers closing out of order cannot leave `#root` hidden forever.
  useOverlayBehavior({ open, panelRef, overlayId, onRequestClose: onClose, canClose, initialFocusRef });

  if (!open) {
    return null;
  }

  const close = (): void => {
    if (!canClose()) {
      return;
    }
    onClose();
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex" data-testid={testId ?? 'overlay'} data-overlay-kind={kind}>
      {/* The scrim is a child covering the container, so the click must be
          handled *here*: on the container, `event.target` would always be the
          scrim and the guard would never pass. */}
      <div
        aria-hidden="true"
        data-testid={testId === undefined ? undefined : `${testId}-scrim`}
        onClick={closeOnBackdrop ? close : undefined}
        className={
          kind === 'drawer'
            ? 'absolute inset-0 bg-[var(--overlay-backdrop)]'
            : 'absolute inset-0 bg-[var(--overlay-scrim)]'
        }
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        data-testid={testId === undefined ? undefined : `${testId}-panel`}
        className={
          kind === 'drawer'
            ? `relative z-10 ml-auto flex h-full max-w-full flex-col border-l border-line bg-surface shadow-[var(--shadow-modal)] ${widthClassName ?? 'w-[520px]'}`
            : `relative z-10 m-auto flex max-h-[86vh] max-w-[92vw] flex-col overflow-hidden rounded-window border border-line bg-surface shadow-[var(--shadow-modal)] ${widthClassName ?? 'w-[680px]'}`
        }
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2.5">
          <h2 id={titleId} className="min-w-0 flex-1 truncate text-ink text-[var(--font-h3-size)]">
            {title}
          </h2>
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

        <div id={bodyId} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {children}
        </div>

        {footer === undefined ? null : (
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-2.5">{footer}</div>
        )}
      </div>
    </div>,
    document.body
  );
}
