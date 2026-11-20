const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

/**
 * Modal focus management, ported from the legacy `dialog-focus.ts`.
 *
 * Kept as plain functions rather than a hook so the same code can serve a
 * focus-trap effect, an Escape handler, and tests.
 *
 * Two robustness rules that the naive port got wrong:
 *   - "focusable" means *actually rendered*. A row hidden with `hidden` or
 *     `display:none` is matched by the selector but cannot take focus, so
 *     focusing it is a silent no-op and the trap appears broken (P2/P3 lists
 *     hide rows exactly this way).
 *   - the container's `tabIndex` is only faked when it has none, so repeated
 *     calls cannot accumulate mutations.
 */

function isRendered(element: HTMLElement): boolean {
  if (element.closest('[hidden], [inert], [aria-hidden="true"]') !== null) {
    return false;
  }
  const visibility = getComputedStyle(element).visibility;
  if (visibility === 'hidden' || visibility === 'collapse') {
    return false;
  }
  // Catches `display: none` and detached subtrees; `position: fixed` elements
  // still have client rects, so they are not misclassified.
  return element.getClientRects().length > 0;
}

function isAvailable(element: HTMLElement): boolean {
  // :disabled also catches controls in a disabled fieldset while preserving
  // the native exception for controls inside its first legend.
  return isRendered(element) && !element.matches(':disabled') && !element.hasAttribute('disabled');
}

function findFocusable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      isAvailable(element) &&
      (element.tabIndex >= 0 ||
        // Editing hosts participate in native Tab navigation even though
        // their tabIndex property defaults to -1. Nested editors do not.
        (!element.hasAttribute('tabindex') &&
          element.isContentEditable &&
          !element.parentElement?.isContentEditable))
  );
}

/** The element that opened the dialog, so focus can return to it on close. */
export function captureDialogOpener(): HTMLElement | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body) {
    return null;
  }
  return active;
}

export function restoreDialogFocus(opener: HTMLElement | null): boolean {
  if (opener === null || !opener.isConnected) {
    return false;
  }
  opener.focus({ preventScroll: true });
  return document.activeElement === opener;
}

/**
 * Focuses `preferred` when it is usable, otherwise the first rendered focusable
 * element. Callers pass the field the user came for (the search input, a
 * destructive action's cancel button) so the header's close button never wins
 * by being first in document order.
 */
export function focusDialogInitialElement(root: HTMLElement, preferred: HTMLElement | null): void {
  if (preferred !== null && root.contains(preferred) && isAvailable(preferred)) {
    preferred.focus();
    if (document.activeElement === preferred) {
      return;
    }
  }

  const focusable = findFocusable(root);
  const first = focusable[0];
  if (first !== undefined) {
    first.focus();
    return;
  }

  // Nothing focusable inside: park focus on the container so Tab cannot escape.
  // Only fake the tabindex when the container does not already have one.
  if (root.getAttribute('tabindex') === null) {
    root.tabIndex = -1;
    root.dataset.rocTrapFocus = 'true';
  }
  root.focus();
}

/**
 * Wraps Tab/Shift+Tab inside `root`. Returns true when the event was handled.
 * Does not swallow Escape: closing is the overlay's decision, so stacked
 * overlays can close one layer at a time.
 */
export function trapDialogTabFocus(root: HTMLElement, event: KeyboardEvent): boolean {
  if (event.key !== 'Tab') {
    return false;
  }

  const focusable = findFocusable(root);
  if (focusable.length === 0) {
    event.preventDefault();
    root.focus();
    return true;
  }

  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  const active = document.activeElement;
  const inside =
    active instanceof HTMLElement && active !== root && root.contains(active) && isAvailable(active);

  if (event.shiftKey) {
    if (!inside || active === first) {
      event.preventDefault();
      last.focus();
      return true;
    }
    return false;
  }

  if (!inside || active === last) {
    event.preventDefault();
    first.focus();
    return true;
  }
  return false;
}
