import { useEffect, useRef, type RefObject } from 'react';
import { captureDialogOpener, focusDialogInitialElement, restoreDialogFocus, trapDialogTabFocus } from './focus-trap';

/**
 * Overlay behaviour: focus trap, Escape layering, focus restore, background
 * inertness.
 *
 * Extracted from `ModalShell` so the rules can be reasoned about on their own,
 * and so a future non-modal overlay can opt into the same guarantees.
 *
 * ## Layering rules
 *
 * All three interactions key off the same shared stack, which is what makes
 * stacked overlays behave:
 *
 *   - **Escape** closes only the top layer (sequential case).
 *   - **Tab** is trapped only by the top layer. Without this, every open
 *     overlay's capture listener would refocus *its own* first element and Tab
 *     would ping-pong instead of advancing.
 *   - **`aria-hidden` on `#root`** is applied once, when the stack goes from
 *     empty to non-empty, and removed only when it empties again. Storing a
 *     per-overlay "previous value" instead breaks as soon as two overlays close
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

const openOverlayStack: string[] = [];

export function topOverlayId(): string | null {
  return openOverlayStack[openOverlayStack.length - 1] ?? null;
}

/** True when any modal/drawer is open, so shells can suppress global shortcuts. */
export function overlayStackDepth(): number {
  return openOverlayStack.length;
}

export type OverlayBehaviorOptions = {
  open: boolean;
  panelRef: RefObject<HTMLElement | null>;
  onRequestClose: () => void;
  /** Consulted before every close path; returning false vetoes the close. */
  canClose: () => boolean;
  initialFocusRef?: RefObject<HTMLElement | null> | undefined;
  /** Stable id used for stack ordering. */
  overlayId: string;
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

    const wasEmpty = openOverlayStack.length === 0;
    openOverlayStack.push(overlayId);

    const root = document.getElementById('root');
    if (inertBackground && wasEmpty && root !== null) {
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
      const index = openOverlayStack.indexOf(overlayId);
      if (index >= 0) {
        openOverlayStack.splice(index, 1);
      }
      // Only re-expose the app once nothing is layered on it any more.
      if (inertBackground && openOverlayStack.length === 0 && root !== null) {
        root.removeAttribute('aria-hidden');
      }
    };
  }, [open, overlayId, panelRef, initialFocusRef, inertBackground]);
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
