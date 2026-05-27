const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

export function findDialogFocusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(focusableSelector)).filter((element) => {
    if (element.getAttribute('aria-hidden') === 'true') {
      return false;
    }
    return element.tabIndex >= 0;
  });
}

export function focusDialogInitialElement(root: HTMLElement, preferred: HTMLElement | null): void {
  if (preferred !== null && !preferred.hasAttribute('disabled')) {
    preferred.focus();
    return;
  }
  const focusableElements = findDialogFocusableElements(root);
  if (focusableElements.length > 0) {
    focusableElements[0].focus();
    return;
  }
  root.focus();
}

export function trapDialogTabFocus(root: HTMLElement, event: KeyboardEvent): boolean {
  if (event.key !== 'Tab') {
    return false;
  }

  const focusableElements = findDialogFocusableElements(root);
  if (focusableElements.length === 0) {
    event.preventDefault();
    root.focus();
    return true;
  }

  const first = focusableElements[0];
  const last = focusableElements[focusableElements.length - 1];
  const activeElement = document.activeElement;
  const activeInsideDialog = activeElement instanceof HTMLElement && root.contains(activeElement);

  if (event.shiftKey) {
    if (!activeInsideDialog || activeElement === first) {
      event.preventDefault();
      last.focus();
      return true;
    }
    return false;
  }

  if (!activeInsideDialog || activeElement === last) {
    event.preventDefault();
    first.focus();
    return true;
  }
  return false;
}
