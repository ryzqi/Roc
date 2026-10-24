import { useCallback, useId, useRef, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { X } from 'lucide-react';
import {
  drawerTransition,
  drawerVariants,
  modalPopTransition,
  modalPopVariants,
  scrimTransition,
  scrimVariants
} from '../shared/motion';
import { useOverlayBehavior, OverlayFocusRestore } from './use-overlay-behavior';
import { OVERLAY_Z_INDEX, type OverlayLayer } from './overlay-stack';

/**
 * Shared overlay shell for drawers and modals.
 *
 * One implementation so the four requirements cannot drift between overlays:
 * focus trap, Escape closing one layer at a time, `aria-modal` semantics, and a
 * before-close guard that unsaved drafts can veto.
 *
 * Rendered through a portal so a drawer can stack above a modal without either
 * needing to know the other's DOM position.
 *
 * ## Entrance and exit
 *
 * Every overlay animates **both** ways: modals scale in and out over 0.18s
 * (`modalPopVariants`), drawers slide in and out over 0.2s (`drawerVariants`), and
 * the scrim fades with either. The vocabulary lives in `shared/motion.ts`.
 *
 * The early `return null` that used to guard the closed state is gone: it would
 * unmount the panel before it could animate out, and `AnimatePresence` needs the
 * subtree to survive one exit frame. Two consequences had to be handled:
 *
 *   1. **The lazy panel is still not fetched at boot.** `children` is only
 *      rendered inside the `open` branch, so `GitPanel`'s module is still
 *      requested on first open, not at startup (see `AppShell`'s latch comment).
 *   2. **A click during the exit must not close twice.** The exiting subtree is a
 *      snapshot from the frame where `open` was still true, so its `close`
 *      closure would happily re-run `onClose`. `openRef` is read at call time,
 *      which is the live value.
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
  /**
   * Where focus returns when the overlay closes, as a CSS selector.
   *
   * Defaults to the element that opened the overlay. The settings centre passes its gear
   * button because ⌘, arrives from the native menu, where the opener is the document body
   * and focus would otherwise be lost on close. Handled by `OverlayFocusRestore`, which
   * lives inside the animated subtree so focus returns when the panel is actually gone —
   * see that module's header.
   */
  returnFocusSelector?: string;
  /** Return false to keep the overlay open (e.g. unsaved draft confirmation). */
  beforeClose?: () => boolean;
  /** Clicking the scrim closes. Set false for destructive flows. */
  closeOnBackdrop?: boolean;
  /**
   * Body padding.
   *
   * `default` is the padded form body every overlay wants. `none` exists for a body
   * that brings its own **columns**: the settings centre's left navigation is a
   * coloured rail that has to reach the panel's edges — inner padding would trap it inside the
   * panel and the
   * rail would stop reading as a rail. A `p-0` override appended to the class list
   * could not be trusted for this: both `p-0` and `px-4` are plain utilities, so order
   * in the attribute decides nothing.
   */
  bodyPadding?: 'default' | 'none';
  /**
   * Which layering band the overlay is painted in.
   *
   * `dialog` (default) is every overlay the user opens. `ambient` is for surfaces the
   * *layout* raises on its own — the sidebar and assistant drawers at narrow widths — which
   * belong to the page background and must never paint over a dialog. See
   * `overlay-stack.ts` for the bug this encodes.
   */
  layer?: OverlayLayer;
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
  returnFocusSelector,
  beforeClose,
  closeOnBackdrop = true,
  bodyPadding = 'default',
  layer = 'dialog'
}: ModalShellProps): React.JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const overlayId = useId();
  const bodyId = useId();

  const canClose = useCallback(() => (beforeClose === undefined ? true : beforeClose()), [beforeClose]);
  /**
   * Live `open`, for handlers that outlive their own render.
   *
   * `AnimatePresence` keeps the exiting subtree mounted with the props it had
   * while open, so `open` inside those closures is stale `true` for the length of
   * the exit; reading the ref is what keeps a stray click from closing twice.
   */
  const openRef = useRef(open);
  openRef.current = open;

  // Background inertness lives in the hook, which reference-counts the overlay
  // stack so layers closing out of order cannot leave `#root` hidden forever.
  useOverlayBehavior({ open, panelRef, overlayId, layer, onRequestClose: onClose, canClose, initialFocusRef });

  const close = (): void => {
    if (!openRef.current || !canClose()) {
      return;
    }
    onClose();
  };

  return createPortal(
    // The container is a `motion.div` so presence is propagated to the scrim and
    // the panel unambiguously; it carries no animation of its own.
    <AnimatePresence>
      {open ? (
        <motion.div
          // The z-index comes from the shared layering table, never from a literal: two
          // overlays both written as `z-50` are ordered by DOM order, which is how the
          // narrow-window sidebar drawer ended up painted on top of the settings panel.
          style={{ zIndex: OVERLAY_Z_INDEX[layer] }}
          className="fixed inset-0 flex"
          data-testid={testId ?? 'overlay'}
          data-overlay-kind={kind}
          data-overlay-layer={layer}
        >
          {/* Mounted with the panel, not with `ModalShell`: its unmount is the panel's
              removal, which is when focus may safely go back to the opener. */}
          <OverlayFocusRestore returnFocusSelector={returnFocusSelector} />

          {/* The scrim is a child covering the container, so the click must be
              handled *here*: on the container, `event.target` would always be the
              scrim and the guard would never pass. */}
          <motion.div
            aria-hidden="true"
            data-testid={testId === undefined ? undefined : `${testId}-scrim`}
            onClick={closeOnBackdrop ? close : undefined}
            variants={scrimVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={scrimTransition}
            className={
              kind === 'drawer'
                ? 'absolute inset-0 bg-[var(--overlay-backdrop)]'
                : 'absolute inset-0 bg-[var(--overlay-scrim)]'
            }
          />
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={bodyId}
            data-testid={testId === undefined ? undefined : `${testId}-panel`}
            variants={kind === 'drawer' ? drawerVariants : modalPopVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={kind === 'drawer' ? drawerTransition : modalPopTransition}
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

            <div
              id={bodyId}
              className={
                bodyPadding === 'none'
                  ? 'min-h-0 flex-1 overflow-hidden'
                  : 'min-h-0 flex-1 overflow-y-auto px-4 py-3'
              }
            >
              {children}
            </div>

            {footer === undefined ? null : (
              <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-2.5">
                {footer}
              </div>
            )}
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body
  );
}
