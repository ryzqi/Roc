import { lazy, useEffect, useState, type ComponentType } from 'react';
import type { AppViewId } from './routes';
import { placeholderView } from './placeholder-view';

/**
 * View module registry: lazy loading plus *resolution tracking*.
 *
 * Two behaviours need to know whether a view's chunk has ever loaded:
 *
 *   1. **Hysteresis** — when switching to a view whose chunk is not resident,
 *      the canvas must keep showing the previous view instead of blanking, then
 *      swap when the new one is ready (the legacy shell's `useShownView`).
 *   2. **Scroll reset** — the canvas is a single scroll surface (MASTER v2 §5),
 *      so its offset is reset when the *shown* view changes, not when the
 *      requested one does.
 *
 * Both need the resolution moment to be observable from React, so the loader
 * notifies subscribers when a module resolves. View components need no extra
 * props for this.
 *
 * P0–P9 register placeholders through `viewLoaders`; each phase replaces its
 * entry with a real `() => import('...')`. Until then the factories live in the
 * eager entry, which is fine for placeholders but **the assistant, settings and
 * the Markdown/KaTeX families must stay real dynamic imports**, or
 * `check-renderer-chunks.mjs`'s `forbidden` guard fails (R4 / ADR-M11).
 */

export type ViewProps = {
  view: AppViewId;
  projectId: string | null;
  stageHint: string | null;
};

export type ViewModule = { default: ComponentType<ViewProps> };

const viewLoaders: Record<AppViewId, () => Promise<ViewModule>> = {
  overview: async () => ({ default: placeholderView('项目总览', 'P6 实现') }),
  stage: async () => ({ default: placeholderView('阶段工作区', 'P6 实现') }),
  activity: async () => ({ default: placeholderView('活动流', 'P6 实现') }),
  provenance: async () => ({ default: placeholderView('溯源', 'P7 实现') }),
  changes: async () => ({ default: placeholderView('改动与产物', 'P3 实现') }),
  literature: async () => ({ default: placeholderView('文献中心', 'P5 实现') }),
  latex: async () => ({ default: placeholderView('文稿', 'P7 实现') }),
  terminal: async () => ({ default: placeholderView('终端', 'P3 实现') }),
  files: async () => ({ default: placeholderView('文件', 'P3 实现') }),
  tasks: async () => ({ default: placeholderView('任务看板', 'P6 实现') }),
  diagnostics: async () => ({ default: placeholderView('运行诊断', 'P6 实现') }),
  mcp: async () => ({ default: placeholderView('MCP', 'P9 实现') }),
  skills: async () => ({ default: placeholderView('技能', 'P9 实现') }),
  memory: async () => ({ default: placeholderView('记忆', 'P9 实现') })
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
