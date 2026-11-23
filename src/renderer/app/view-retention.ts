import type { AppViewId, AppViewTarget } from './routes';

/** Related literature destinations share drafts, selection and one host identity. */
export function viewHostFor(view: AppViewTarget): AppViewId {
  return view === 'discover' || view === 'knowledge' ? 'library' : view;
}

const hostRetention = {
  overview: 'readonly',
  // Notes, Wiki drafts and unresolved monitor operations are still component-owned.
  library: 'pinned',
  // Editor drafts, selection and terminal effects must survive canvas navigation.
  writing: 'pinned',
  // Background-task editors keep pending changes and navigation guards mounted.
  runs: 'pinned'
} satisfies Record<AppViewId, 'readonly' | 'pinned'>;

/**
 * Zero inactive readonly hosts; visited draft/session hosts are explicit exceptions.
 * Apply only after the destination module resolves, so a cold or failed import cannot
 * evict the visible canvas. Module caching is independent of component retention.
 */
export function retainedViewsAfterNavigation(
  current: readonly AppViewTarget[],
  target: AppViewTarget
): readonly AppViewTarget[] {
  const activeHost = viewHostFor(target);
  const retained = new Map(current.map(view => [viewHostFor(view), view]));
  retained.set(activeHost, target);
  return [...retained].filter(([host]) => host === activeHost || hostRetention[host] === 'pinned')
    .map(([, view]) => view);
}
