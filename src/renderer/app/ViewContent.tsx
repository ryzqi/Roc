import { Suspense, useEffect, useState } from 'react';
import { isCanvasTabId } from '../../shared/surfaces';
import type { AppViewId } from './routes';
import { DelayedFallback } from '../shell/DelayedFallback';
import { isViewResolved, loadView, preloadView, useViewResolution, type ViewProps } from './view-registry';

export type { ViewProps };

/**
 * Keep the current canvas visible while a cold module loads, then swap immediately.
 * Visited views stay mounted within one project, preserving editor selection, terminal
 * sessions and scroll positions. Hidden panels leave the keyboard/accessibility tree.
 * The shell keys this host by project id so no cached workspace crosses project scope.
 */
export function ViewContent({ view, projectId }: ViewProps): React.JSX.Element {
  useViewResolution();
  const [shownView, setShownView] = useState<AppViewId>(view);
  const [visited, setVisited] = useState<readonly AppViewId[]>(() => [view]);
  const requestedResident = isViewResolved(view);
  const warming = view !== shownView;

  useEffect(() => {
    if (warming && !requestedResident) {
      preloadView(view);
      return;
    }
    if (warming && requestedResident) {
      setVisited(current => {
        const retained = current.filter(id => isCanvasTabId(id) || id === view);
        return retained.includes(view) ? retained : [...retained, view];
      });
      setShownView(view);
    }
  }, [warming, requestedResident, view]);

  return (
    <div className="h-full w-full">
      {visited.map(id => {
        const View = loadView(id);
        const active = id === shownView;
        return (
          <div key={id} className="h-full w-full overflow-y-auto" style={{ display: active ? 'block' : 'none' }}
            data-view={active ? view : undefined}
            data-shown-view={active ? shownView : undefined}
            data-project={projectId ?? ''}>
            <Suspense fallback={<DelayedFallback />}>
              <View view={id} projectId={projectId} />
            </Suspense>
          </div>
        );
      })}
    </div>
  );
}
