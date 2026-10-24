import { useEffect, useRef, type RefObject } from 'react';
import { captureDialogOpener, focusDialogInitialElement, restoreDialogFocus, trapDialogTabFocus } from './focus-trap';
import { hasOpenDialog, popOverlay, pushOverlay, topOverlayId, type OverlayLayer } from './overlay-stack';

export { overlayStackDepth, topOverlayId } from './overlay-stack';

/**
 * Overlay behaviour: focus trap, Escape layering, focus restore, background
 * inertness.
 *
 * Extracted from `ModalShell` so the rules can be reasoned about on their own,
 * and so a future non-modal overlay can opt into the same guarantees.
 *
 * ## Layering rules
 *
 * All three interactions key off the shared stack in `overlay-stack.ts`, which is what
 * makes stacked overlays behave:
 *
 *   - **Escape** closes only the top layer (sequential case).
 *   - **Tab** is trapped only by the top layer. Without this, every open
 *     overlay's capture listener would refocus *its own* first element and Tab
 *     would ping-pong instead of advancing.
 *   - **`aria-hidden` on `#root`** follows the presence of a *dialog*, not the stack
 *     depth: an ambient drawer (the narrow-window sidebar) is part of the page and must
 *     not make the page look inert, while any dialog above it must.
 *
 * The stack is layered rather than strictly ordered by open time — see that module's
 * header for the covered dropdown this fixes.
 *     out of order: the first closer restores `null` while the second is still
 *     open, and the second then leaves `#root` permanently hidden from
 *     assistive technology.
 *
 * ## Focus *return* is deliberately not here
 *
 * All three rules above are keyed on `open`, because they must take effect the
 * instant the overlay starts closing. Focus return must **not** be: it has to
 * happen when the panel actually leaves the DOM.
 *
 * This used to be one effect and one lifetime — `ModalShell` rendered `null` when
 * closed, so `open: false` *was* the unmount. Adding the exit animation separated
 * the two, and the split has a visible failure: this effect's cleanup fired at
 * `open: false`, then ~180ms later the panel unmounted and a *nested* overlay's
 * cleanup (a stacked confirm panel, whose opener is a button inside the panel being
 * removed) put focus back on an element that was about to disappear. Focus then
 * fell to `<body>` — caught by `verify:p8-settings`, 关闭后焦点回到设置齿轮 got
 * `null`.
 *
 * So focus return lives in `OverlayFocusRestore`, which is mounted *inside* the
 * animated subtree. Its lifetime is the panel's lifetime, and nested overlays
 * therefore resolve in the same order they did before the animation existed.
 */

export type OverlayBehaviorOptions = {
  open: boolean;
  panelRef: RefObject<HTMLElement | null>;
  onRequestClose: () => void;
  /** Consulted before every close path; returning false vetoes the close. */
  canClose: () => boolean;
  initialFocusRef?: RefObject<HTMLElement | null> | undefined;
  /** Stable id used for stack ordering. */
  overlayId: string;
  /** Which layer this overlay lives in; see `overlay-stack.ts`. Defaults to `dialog`. */
  layer?: OverlayLayer;
  /** Set false to leave the app accessible behind this overlay (non-modal). */
  inertBackground?: boolean;
};

export function useOverlayBehavior({
  open,
  panelRef,
  onRequestClose,
  canClose,
  initialFocusRef,
  overlayId,
  layer = 'dialog',
  inertBackground = true
}: OverlayBehaviorOptions): void {
  // Keep the latest callbacks reachable from a listener installed once per open.
  const closeRef = useRef(onRequestClose);
  const canCloseRef = useRef(canClose);
  closeRef.current = onRequestClose;
  canCloseRef.current = canClose;

  useEffect(() => {
    if (!open) {
      return;
    }

    const hadDialog = hasOpenDialog();
    pushOverlay(overlayId, layer);

    const root = document.getElementById('root');
    // Inheritedness follows the presence of a *dialog*, not the depth: an ambient drawer is
    // part of the page, so the page behind it is still the page. Only a dialog makes it inert.
    if (inertBackground && !hadDialog && hasOpenDialog() && root !== null) {
      root.setAttribute('aria-hidden', 'true');
    }

    const panel = panelRef.current;
    if (panel !== null) {
      focusDialogInitialElement(panel, initialFocusRef?.current ?? null);
    }

    const requestClose = (): void => {
      if (!canCloseRef.current()) {
        return;
      }
      closeRef.current();
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      // Only the top layer traps. Lower layers stay inert but keep their state.
      if (topOverlayId() !== overlayId) {
        return;
      }
      const current = panelRef.current;
      if (current === null) {
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        requestClose();
        return;
      }
      trapDialogTabFocus(current, event);
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      popOverlay(overlayId);
      // Only re-expose the app once no dialog is layered on it any more.
      if (inertBackground && !hasOpenDialog() && root !== null) {
        root.removeAttribute('aria-hidden');
      }
    };
  }, [open, overlayId, layer, panelRef, initialFocusRef, inertBackground]);
}

/**
 * Returns focus to whatever opened the overlay, when the overlay is really gone.
 *
 * Rendered by `ModalShell` *inside* the animated subtree on purpose: the effect's
 * cleanup is the unmount, which is the only moment that is both (a) after the panel
 * has left the DOM and (b) in the same commit as every nested overlay's removal. See
 * this module's header for the focus-loss bug that separating focus return from
 * unmount caused.
 *
 * `returnFocusSelector` exists because the opener is not always what the user last
 * focused: the settings centre also opens from the native `⌘,` menu accelerator, where
 * `document.activeElement` is the body and focus would land nowhere. When the selector
 * matches nothing the captured opener wins.
 */
export function OverlayFocusRestore({ returnFocusSelector }: { returnFocusSelector?: string | undefined }): null {
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    // Runs before `useOverlayBehavior`'s effect (child effects fire first), so the
    // opener is still the focused element when it is captured.
    openerRef.current =
      returnFocusSelector === undefined
        ? captureDialogOpener()
        : document.querySelector<HTMLElement>(returnFocusSelector) ?? captureDialogOpener();

    return () => {
      restoreDialogFocus(openerRef.current);
    };
  }, [returnFocusSelector]);

  return null;
}
