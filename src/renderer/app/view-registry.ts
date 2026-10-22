import { lazy, useEffect, useState, type ComponentType } from 'react';
import type { AppViewId } from './routes';

/**
 * View module registry: lazy loading plus *resolution tracking*.
 *
 * Two behaviours need to know whether a view's chunk has ever loaded:
 *
 *   1. **Hysteresis** — when switching to a view whose chunk is not resident,
 *      the canvas must keep showing the previous view instead of blanking, then
 *      swap when the new one is ready (the legacy shell's `useShownView`).
 *   2. **Scroll reset** — the canvas is a single scroll surface,
 *      so its offset is reset when the *shown* view changes, not when the
 *      requested one does.
 *
 * Both need the resolution moment to be observable from React, so the loader
 * notifies subscribers when a module resolves. View components need no extra
 * props for this.
 *
 * P0–P9 register placeholders through `viewLoaders`; each phase replaces its
 * entry with a real `() => import('...')`. Until then the factories live in the
 * eager entry, which is fine for placeholders but **the assistant, settings, the
 * terminal, the diff view and the Markdown family must stay real dynamic
 * imports**, or `check-renderer-chunks.mjs`'s `forbidden` guard (or the eager
 * budget) fails.
 *
 * P3 turned `files` / `terminal` / `changes` into real imports. They no longer
 * have a same-name placeholder factory in this file, so nothing keeps
 * `@xterm/xterm` or `react-diff-view` reachable from the entry by accident.
 */

export type ViewProps = {
  view: AppViewId;
  projectId: string | null;
};

export type ViewModule = { default: ComponentType<ViewProps> };

const viewLoaders: Record<AppViewId, () => Promise<ViewModule>> = {
  // Every canvas view is a real `import()`, not a factory, so `react-diff-view` and `@xterm/*`
  // stay out of the eager graph while the terminal and the Git drawer still get theirs.
  //
  // The three primary tabs (文献 / LaTeX / 终端) come first; the rest are the project views this
  // build adds. `changes`, `files` and `tasks` used to be among them and are gone: files open from
  // the sidebar tree and Git from a drawer, and there are no canvas pages for
  // either remaining.
  literature: async () => ({ default: (await import('../literature/LiteratureHubView')).LiteratureHubView }),
  latex: async () => ({ default: (await import('../latex/LatexPanel')).LatexPanel }),
  terminal: async () => ({ default: (await import('../canvas/terminal/TerminalView')).TerminalView }),
  // P9 made these three real. One component serves all of them: it picks its initial tab from the
  // view id, and `management-shell-parts` holds the tab strip and the bodies so the canvas and the
  // drawer cannot drift apart.
  //
  // 后台任务 has exactly one home — the management drawer's 任务 tab — and two
  // surfaces over one dataset is the drift P9 built `management-shell-parts` to prevent.
  mcp: async () => ({ default: (await import('../management/ManagementView')).ManagementView }),
  skills: async () => ({ default: (await import('../management/ManagementView')).ManagementView }),
  memory: async () => ({ default: (await import('../management/ManagementView')).ManagementView })
};

const resolvedViews = new Set<AppViewId>();
const resolutionListeners = new Set<() => void>();
const viewCache = new Map<AppViewId, ComponentType<ViewProps>>();

function markResolved(view: AppViewId): void {
  if (resolvedViews.has(view)) {
    return;
  }
  resolvedViews.add(view);
  for (const listener of resolutionListeners) {
    listener();
  }
}

export function isViewResolved(view: AppViewId): boolean {
  return resolvedViews.has(view);
}

/** Re-renders the caller whenever any view module finishes loading. */
export function useViewResolution(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const listener = (): void => {
      setVersion((current) => current + 1);
    };
    resolutionListeners.add(listener);
    return () => {
      resolutionListeners.delete(listener);
    };
  }, []);
  return version;
}

export function loadView(view: AppViewId): ComponentType<ViewProps> {
  const cached = viewCache.get(view);
  if (cached !== undefined) {
    return cached;
  }
  const component = lazy(async () => {
    const module = await viewLoaders[view]();
    markResolved(view);
    return module;
  });
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
  if (resolvedViews.has(view)) {
    return;
  }
  void viewLoaders[view]().then(
    () => {
      markResolved(view);
    },
    () => {
      // A failed chunk load surfaces when the view is actually rendered, where
      // the error boundary can present it; preloading stays silent.
    }
  );
}
