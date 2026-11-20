import { useEffect, useState } from 'react';
import type { AppSubview, AppViewId, AppViewTarget } from './routes';
import { DelayedFallback } from '../shell/DelayedFallback';
import { ErrorBar } from '../shell/ErrorBar';
import { LazyBoundary } from '../shell/LazyBoundary';
import { ViewActivity } from '../shared/view-activity';
import { isViewResolved, loadView, preloadView, retryView, useViewResolution, viewLoadError, viewHostFor, type ViewProps } from './view-registry';

type ViewContentProps = {
  view: AppViewId;
  subview?: AppSubview | null;
  projectId: ViewProps['projectId'];
};

/**
 * Keep the current canvas visible while a cold module loads, then swap immediately.
 * Visited views stay mounted within one project, preserving editor selection, terminal
 * sessions and scroll positions. Hidden panels leave the keyboard/accessibility tree.
 * The shell keys this host by project id so no cached workspace crosses project scope.
 */
export function ViewContent({ view, subview = null, projectId }: ViewContentProps): React.JSX.Element {
  useViewResolution();
  const target = subview ?? view;
  const [shownView, setShownView] = useState<AppViewTarget>(target);
  const [visited, setVisited] = useState<readonly AppViewTarget[]>(() => [target]);
  const requestedResident = isViewResolved(target);
  const loadError = viewLoadError(target);
  const warming = target !== shownView;

  useEffect(() => {
    if (!requestedResident && loadError === null) {
      preloadView(target);
      return;
    }
    if (warming && requestedResident) {
      setVisited(current => {
        const host = viewHostFor(target);
        return current.some(id => viewHostFor(id) === host)
          ? current.map(id => viewHostFor(id) === host ? target : id)
          : [...current, target];
      });
      setShownView(target);
    }
  }, [warming, requestedResident, loadError, target]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {loadError === null ? null : <div className="shrink-0 p-2" data-testid="view-load-error">
        <ErrorBar error={{level: 'page', message: `视图加载失败：${loadError}`, retry: () => retryView(target)}} />
      </div>}
      {!warming || requestedResident || loadError !== null ? null :
        <p role="status" className="shrink-0 px-3 py-1.5 text-muted text-[length:var(--font-meta-size)]">正在加载视图…</p>}
      {visited.map(id => {
        const View = loadView(id);
        const active = viewHostFor(id) === viewHostFor(shownView);
        return (
          <div key={viewHostFor(id)} className="min-h-0 w-full flex-1 overflow-y-auto" style={{ display: active ? 'block' : 'none' }}
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
