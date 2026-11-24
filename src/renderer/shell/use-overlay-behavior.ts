import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
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
 *     overlay's listener would refocus *its own* first element and Tab
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
 * Stack and keyboard ownership follow logical `open`. Focus return lives in
 * `OverlayFocusRestore`: live presence returns focus when interaction ends,
 * while real unmount still handles a parent removing an open overlay. A
 * finished return attempt is remembered so visual removal cannot steal focus.
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
  /** Set false when a primitive owns focus/Tab; captureEscape can still assign Escape to Roc. */
  manageFocus?: boolean;
  /** Own Escape before a primitive's document listener; focus and Tab can remain delegated. */
  captureEscape?: boolean;
  /** A responsive pane keeps an already focused editor when becoming a drawer. */
  preserveFocus?: boolean;
};

export function useOverlayBehavior({
  open,
  panelRef,
  onRequestClose,
  canClose,
  initialFocusRef,
  overlayId,
  layer = 'dialog',
  inertBackground = true,
  manageFocus = true,
  captureEscape = false,
  preserveFocus = false
}: OverlayBehaviorOptions): void {
  // Keep the latest callbacks reachable from a listener installed once per open.
  const closeRef = useRef(onRequestClose);
  const canCloseRef = useRef(canClose);
  closeRef.current = onRequestClose;
  canCloseRef.current = canClose;

  // FocusScope can autofocus during passive effects before a primitive has rerendered its
  // highest-layer keyboard listener. Register ownership before that focus handoff.
  useLayoutEffect(() => {
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

    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || topOverlayId() !== overlayId) return;
      event.preventDefault();
      event.stopPropagation();
      if (canCloseRef.current()) closeRef.current();
    };
    if (captureEscape) window.addEventListener('keydown', onEscape, true);
    return () => {
      if (captureEscape) window.removeEventListener('keydown', onEscape, true);
      popOverlay(overlayId);
      // Only re-expose the app once no dialog is layered on it any more.
      if (inertBackground && !hasOpenDialog() && root !== null) {
        root.removeAttribute('aria-hidden');
      }
    };
  }, [open, overlayId, layer, inertBackground, captureEscape]);

  useEffect(() => {
    if (!open || !manageFocus) return;
    const panel = panelRef.current;
    if (panel !== null && !(preserveFocus && panel.contains(document.activeElement))) {
      focusDialogInitialElement(panel, initialFocusRef?.current ?? null);
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      // Nested controls get first refusal (e.g. Escape closes a model popover).
      if (event.defaultPrevented) return;
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
        if (canCloseRef.current()) closeRef.current();
        return;
      }
      trapDialogTabFocus(current, event);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, overlayId, panelRef, initialFocusRef, manageFocus, preserveFocus]);
}

/**
 * Captures one opener per interactive lifetime, including StrictMode replay.
 * Presence ends interaction before visual exit; real unmount is the fallback
 * when the parent removes a still-open overlay.
 *
 * `returnFocusSelector` exists because the opener is not always what the user last
 * focused: the settings centre also opens from the native `⌘,` menu accelerator, where
 * `document.activeElement` is the body and focus would land nowhere. When the selector
 * matches nothing the captured opener wins.
 */
export function OverlayFocusRestore({ returnFocusSelector, restoreWhen, panelRef, present = true }: {
  returnFocusSelector?: string | undefined;
  restoreWhen?: () => boolean;
  panelRef?: RefObject<HTMLElement | null>;
  present?: boolean;
}): null {
  const openerRef = useRef<HTMLElement | null | undefined>(undefined);
  const wasPresentRef = useRef(false);
  const restoreAttemptedRef = useRef(false);
  const restoreWhenRef = useRef(restoreWhen);
  restoreWhenRef.current = restoreWhen;

  useEffect(() => {
    // Runs before `useOverlayBehavior`'s effect (child effects fire first), so the
    // opener is still the focused element when it is captured.
    if (present && !wasPresentRef.current) {
      openerRef.current =
        returnFocusSelector === undefined
          ? captureDialogOpener()
          : document.querySelector<HTMLElement>(returnFocusSelector) ?? captureDialogOpener();
      restoreAttemptedRef.current = false;
    }
    wasPresentRef.current = present;
    // StrictMode replays effects and detaches refs while keeping the panel DOM.
    const panel = panelRef?.current;
    const restore = (): void => {
      if (openerRef.current === undefined || restoreAttemptedRef.current || !(restoreWhenRef.current?.() ?? true)) return;
      restoreAttemptedRef.current = true;
      restoreDialogFocus(openerRef.current);
    };
    if (!present) {
      restore();
      // A nested opener can be inside a closing parent. Never retry that old
      // return after the parent has reopened and acquired a new focus target.
      restoreAttemptedRef.current = true;
    }

    return () => {
      if (panel?.isConnected) return;
      restore();
    };
  }, [returnFocusSelector, panelRef, present]);

  return null;
}
