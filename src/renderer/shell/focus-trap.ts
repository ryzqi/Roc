const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
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
  if (element.hidden || element.closest('[hidden]') !== null) {
    return false;
  }
  if (element.getAttribute('aria-hidden') === 'true') {
    return false;
  }
  // Catches `display: none` and detached subtrees; `position: fixed` elements
  // still have client rects, so they are not misclassified.
  return element.getClientRects().length > 0;
}

function findFocusable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.tabIndex >= 0 && isRendered(element) && !element.hasAttribute('inert')
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
  opener.focus();
  return document.activeElement === opener;
}

/**
 * Focuses `preferred` when it is usable, otherwise the first rendered focusable
 * element. Callers pass the field the user came for (the search input, a
 * destructive action's cancel button) so the header's close button never wins
 * by being first in document order.
 */
export function focusDialogInitialElement(root: HTMLElement, preferred: HTMLElement | null): void {
  if (preferred !== null && !preferred.hasAttribute('disabled') && preferred.isConnected) {
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
  const inside = active instanceof HTMLElement && root.contains(active) && isRendered(active);

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
