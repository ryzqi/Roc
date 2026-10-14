import { Suspense, useEffect, useRef, useState } from 'react';
import type { AppViewId } from './routes';
import { DelayedFallback } from '../shell/DelayedFallback';
import { isViewResolved, loadView, preloadView, useViewResolution, type ViewProps } from './view-registry';

/**
 * Lazy view host with hysteresis.
 *
 * Two properties, both ported from the legacy shell's
 * `loadView` / `viewCache` / `useShownView` pattern because both are user-visible:
 *
 *   1. **A view module is fetched at most once per session** — the cache lives in
 *      `view-registry.ts`.
 *   2. **The canvas never blanks while switching.** If the requested view's chunk
 *      is already resident it renders immediately; otherwise the *previous* view
 *      stays mounted while the next chunk is fetched, and the swap happens once
 *      it resolves.
 *
 * The prefetch deliberately does **not** mount the incoming view inside a hidden
 * boundary: React would unmount and remount it on the swap, running its effects
 * twice — two IPC round-trips per first visit once P3+ lands real views.
 *
 * The canvas is a single scroll surface (MASTER v2 §5), so its offset resets when
 * the *shown* view changes — not when the requested one does, so a slow load
 * cannot jump the view the user is still reading.
 */

export type { ViewProps };

export function ViewContent({ view, projectId, stageHint }: ViewProps): React.JSX.Element {
  // Subscribing makes the resolution moment observable, which is what drives the
  // warm-up to completion.
  useViewResolution();

  const scrollRef = useRef<HTMLDivElement>(null);
  const [shownView, setShownView] = useState<AppViewId>(view);
  const requestedResident = isViewResolved(view);
  const warming = view !== shownView;

  useEffect(() => {
    if (warming && !requestedResident) {
      preloadView(view);
      return;
    }
    if (warming && requestedResident) {
      setShownView(view);
    }
  }, [warming, requestedResident, view]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element !== null) {
      element.scrollTop = 0;
      element.scrollLeft = 0;
    }
  }, [shownView]);

  const Shown = loadView(shownView);

  return (
    <div
      ref={scrollRef}
      className="h-full w-full overflow-y-auto"
      data-view={view}
      data-shown-view={shownView}
      data-project={projectId ?? ''}
      data-stage={stageHint ?? ''}
    >
      <Suspense fallback={<DelayedFallback />}>
        <Shown
          view={shownView}
          projectId={projectId}
          stageHint={shownView === view ? stageHint : null}
        />
      </Suspense>
    </div>
  );
}
