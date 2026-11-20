import { lazy, useSyncExternalStore, type ComponentType } from 'react';
import type { AppViewId } from './routes';
import { errorMessage } from './loaded-state';

/** Lazy modules are cached by host so related literature destinations share one instance. */

export type ViewProps = {
  view: AppViewId;
  projectId: string | null;
};

export type ViewModule = { default: ComponentType<ViewProps> };

export function viewHostFor(view: AppViewId): AppViewId {
  return view === 'discover' || view === 'knowledge' ? 'library' : view;
}

const viewLoaders: Record<AppViewId, () => Promise<ViewModule>> = {
  overview: async () => ({ default: (await import('../project/OverviewView')).OverviewView }),
  discover: async () => ({ default: (await import('../literature/LiteratureHubView')).LiteratureHubView }),
  library: async () => ({ default: (await import('../literature/LiteratureHubView')).LiteratureHubView }),
  knowledge: async () => ({ default: (await import('../literature/LiteratureHubView')).LiteratureHubView }),
  writing: async () => ({ default: (await import('../latex/WritingView')).WritingView })
};

const resolvedViews = new Set<AppViewId>();
const resolutionListeners = new Set<() => void>();
const viewCache = new Map<AppViewId, ComponentType<ViewProps>>();
const moduleRequests = new Map<AppViewId, Promise<ViewModule>>();
const loadErrors = new Map<AppViewId, string>();
let resolutionVersion = 0;

function notifyResolution(): void {
  resolutionVersion += 1;
  for (const listener of resolutionListeners) listener();
}

function markResolved(view: AppViewId): void {
  if (resolvedViews.has(view)) {
    return;
  }
  resolvedViews.add(view);
  loadErrors.delete(view);
  notifyResolution();
}

export function isViewResolved(view: AppViewId): boolean {
  view = viewHostFor(view);
  return resolvedViews.has(view);
}

export function viewLoadError(view: AppViewId): string | null {
  view = viewHostFor(view);
  return loadErrors.get(view) ?? null;
}

/** Re-renders the caller whenever a view import resolves, fails or is retried. */
export function useViewResolution(): number {
  return useSyncExternalStore(subscribeToResolution, getResolutionVersion, getResolutionVersion);
}

function subscribeToResolution(listener: () => void): () => void {
  resolutionListeners.add(listener);
  return () => { resolutionListeners.delete(listener); };
}

function getResolutionVersion(): number {
  return resolutionVersion;
}

function requestViewModule(view: AppViewId): Promise<ViewModule> {
  view = viewHostFor(view);
  const cached = moduleRequests.get(view);
  if (cached !== undefined) return cached;
  const request = Promise.resolve().then(() => viewLoaders[view]()).then(
    module => {
      markResolved(view);
      return module;
    },
    (error: unknown) => {
      loadErrors.set(view, errorMessage(error));
      notifyResolution();
      throw error;
    }
  );
  moduleRequests.set(view, request);
  return request;
}

export function loadView(view: AppViewId): ComponentType<ViewProps> {
  view = viewHostFor(view);
  const cached = viewCache.get(view);
  if (cached !== undefined) {
    return cached;
  }
  const component = lazy(() => requestViewModule(view));
  viewCache.set(view, component);
  return component;
}

/**
 * Starts fetching a view's chunk without mounting it.
 *
 * Used for the hysteresis warm-up. Mounting the next view inside a hidden
 * `Suspense` boundary would work too, but React would then unmount and remount
 * it on the swap — running its effects twice, which in P3+ means two IPC
 * round-trips per first visit. Fetching the module instead is side-effect free.
 */
export function preloadView(view: AppViewId): void {
  view = viewHostFor(view);
  if (resolvedViews.has(view)) {
    return;
  }
  // The host reads loadErrors without mounting a rejected lazy component.
  void requestViewModule(view).catch(() => {});
}

export function retryView(view: AppViewId): void {
  view = viewHostFor(view);
  // A nested module can fail after the view importer has already resolved.
  resolvedViews.delete(view);
  loadErrors.delete(view);
  moduleRequests.delete(view);
  viewCache.delete(view);
  notifyResolution();
  preloadView(view);
}
