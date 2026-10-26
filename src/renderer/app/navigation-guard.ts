import type { AppRoute } from './routes';

export const BEFORE_NAVIGATE = 'roc:before-navigate';
export type NavigationRequest = { next: AppRoute; proceed: () => void };

/** A dirty canvas may defer navigation until its save/discard decision completes. */
export function requestNavigation(next: AppRoute, proceed: () => void): void {
  const event = new CustomEvent<NavigationRequest>(BEFORE_NAVIGATE, {
    cancelable: true,
    detail: { next, proceed }
  });
  if (window.dispatchEvent(event)) proceed();
}
