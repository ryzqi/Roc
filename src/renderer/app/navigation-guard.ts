import type { AppRoute } from './routes';

export const BEFORE_NAVIGATE = 'roc:before-navigate';
export type NavigationRequest = {
  next: AppRoute;
  /** Acquire one continuation per dirty surface, then resume after its decision. */
  defer: () => () => void;
};

let latestNavigation = 0;

/** Navigate once every deferral resumes, unless any surface vetoes the request. */
export function requestNavigation(next: AppRoute, proceed: () => void): void {
  const revision = ++latestNavigation;
  let remaining = 0;
  let dispatched = false;
  let completed = false;
  const completeIfReady = (): void => {
    if (!dispatched || remaining !== 0 || completed || event.defaultPrevented || revision !== latestNavigation) return;
    completed = true;
    proceed();
  };
  const event = new CustomEvent<NavigationRequest>(BEFORE_NAVIGATE, {
    cancelable: true,
    detail: {
      next,
      defer: () => {
        remaining++;
        let resumed = false;
        return () => {
          if (resumed) return;
          resumed = true;
          remaining--;
          completeIfReady();
        };
      }
    }
  });
  window.dispatchEvent(event);
  dispatched = true;
  completeIfReady();
}
