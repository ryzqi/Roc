import { Suspense, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { AppViewId } from './routes';
import { DelayedFallback } from '../shell/DelayedFallback';
import { viewFadeTransition, viewFadeVariants } from '../shared/motion';
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
 * The canvas is a single scroll surface, so its offset resets when
 * the *shown* view changes — not when the requested one does, so a slow load
 * cannot jump the view the user is still reading.
 *
 * ## The swap cross-fades
 *
 * Each canvas view is wrapped in `<motion.div>` inside an
 * `AnimatePresence mode="wait">`, giving a 120ms opacity fade between views
 * (`viewFadeVariants`).
 *
 * One structural change matters: a bare fade silently broke an acceptance gate.
 *
 * **The routing attributes moved onto the animated element.**
 *
 * `data-view` / `data-shown-view` are the contract the acceptance gates poll to
 * learn which view is on screen (`verify-p6-workflow.mjs`'s `openView` waits for
 * `[data-view="x"][data-shown-view="x"]`). Keeping them on the outer container
 * while the view renders inside an `AnimatePresence` child makes the attribute
 * *lie*: the state flip that writes `data-shown-view="overview"` happens a frame
 * before the overview is mounted — or, with `mode="wait"`, 120ms before. The gate
 * then waits successfully and reads a panel that is not in the DOM, which is
 * exactly what happened: 总览's instruction-source assertion read `null` and P6
 * stopped at 42/69.
 *
 * Moving the attributes onto the mounted view element makes "shown" mean "this
 * element is the shown view", which is what every reader already assumed. The
 * scroll surface moves with them, so there is still exactly one scrollable element
 * per rendered view and the reset below still targets it. `mode="wait"` is then
 * the sequencing (out, then in) with no lying attribute.
 */

export type { ViewProps };

export function ViewContent({ view, projectId }: ViewProps): React.JSX.Element {
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
    <div className="h-full w-full">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          // Keyed on the *shown* view, not the requested one: keying on `view`
          // would fade out the view the user is still reading the moment a cold
          // chunk starts downloading, which defeats the hysteresis above.
          key={shownView}
          ref={scrollRef}
          variants={viewFadeVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          transition={viewFadeTransition}
          className="h-full w-full overflow-y-auto"
          data-view={view}
          data-shown-view={shownView}
          data-project={projectId ?? ''}
        >
          <Suspense fallback={<DelayedFallback />}>
            <Shown view={shownView} projectId={projectId} />
          </Suspense>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
