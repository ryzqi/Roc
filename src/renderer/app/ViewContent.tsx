import { useEffect, useState } from 'react';
import { isCanvasTabId } from '../../shared/surfaces';
import type { AppViewId } from './routes';
import { DelayedFallback } from '../shell/DelayedFallback';
import { ErrorBar } from '../shell/ErrorBar';
import { LazyBoundary } from '../shell/LazyBoundary';
import { ViewActivity } from '../shared/view-activity';
import { isViewResolved, loadView, preloadView, retryView, useViewResolution, viewLoadError, type ViewProps } from './view-registry';

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
  const loadError = viewLoadError(view);
  const warming = view !== shownView;

  useEffect(() => {
    if (!requestedResident && loadError === null) {
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
  }, [warming, requestedResident, loadError, view]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {loadError === null ? null : <div className="shrink-0 p-2" data-testid="view-load-error">
        <ErrorBar error={{level: 'page', message: `视图加载失败：${loadError}`, retry: () => retryView(view)}} />
      </div>}
      {!warming || requestedResident || loadError !== null ? null :
        <p role="status" className="shrink-0 px-3 py-1.5 text-muted text-[length:var(--font-meta-size)]">正在加载视图…</p>}
      {visited.map(id => {
        const View = loadView(id);
        const active = id === shownView;
        return (
          <div key={id} className="min-h-0 w-full flex-1 overflow-y-auto" style={{ display: active ? 'block' : 'none' }}
            data-view={active ? view : undefined}
            data-shown-view={active ? shownView : undefined}
            data-project={projectId ?? ''}>
            <ViewActivity active={active}><LazyBoundary fallback={<DelayedFallback />}
              testId="view-content-error" onRetry={() => retryView(id)}>
              {isViewResolved(id) ? <View view={id} projectId={projectId} /> :
                viewLoadError(id) === null ? <DelayedFallback /> : null}
            </LazyBoundary></ViewActivity>
          </div>
        );
      })}
    </div>
  );
}
