import { useEffect, useState } from 'react';
import { m } from 'motion/react';
import type { AppSubview, AppViewId, AppViewTarget } from './routes';
import { DelayedFallback } from '../shell/DelayedFallback';
import { ErrorBar } from '../shell/ErrorBar';
import { LazyBoundary } from '../shell/LazyBoundary';
import { ViewActivity } from '../shared/view-activity';
import { motionTransitions } from '../shared/motion';
import { isViewResolved, loadView, preloadView, retryView, useViewResolution, viewLoadError, type ViewProps } from './view-registry';
import { retainedViewsAfterNavigation, viewHostFor } from './view-retention';

type ViewContentProps = {
  view: AppViewId;
  subview?: AppSubview | null;
  projectId: ViewProps['projectId'];
};

const viewLabels: Record<AppViewTarget, string> = {
  overview: '总览',
  discover: '发现',
  library: '文献库',
  knowledge: '知识库',
  writing: '论文写作',
  runs: '会话与任务'
};

/**
 * Keep the current canvas visible while a cold module loads, then swap immediately.
 * Draft/session hosts stay mounted within one project; readonly hosts are released on
 * successful navigation. Hidden panels leave the keyboard/accessibility tree, while
 * ViewActivity lets hidden resources pause without removing draft guards.
 * The shell keys this host by project id so no cached workspace crosses project scope.
 */
export function ViewContent({ view, subview = null, projectId }: ViewContentProps): React.JSX.Element {
  useViewResolution();
  const target = subview ?? view;
  const [shownView, setShownView] = useState<AppViewTarget>(target);
  const [retained, setRetained] = useState<readonly AppViewTarget[]>(() => [target]);
  const requestedResident = isViewResolved(target);
  const loadError = viewLoadError(target);
  const warming = target !== shownView;

  useEffect(() => {
    if (!requestedResident && loadError === null) {
      preloadView(target);
      return;
    }
    if (warming && requestedResident) {
      setRetained(current => retainedViewsAfterNavigation(current, target));
      setShownView(target);
    }
  }, [warming, requestedResident, loadError, target]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {loadError === null ? null : <div className="shrink-0 p-2" data-testid="view-load-error">
        <ErrorBar error={{level: 'page', message: `${viewLabels[target]}加载失败：${loadError}`, retry: () => retryView(target)}} />
      </div>}
      <div className="relative flex min-h-0 w-full flex-1 flex-col">
      {!warming || requestedResident || loadError !== null ? null :
        <p role="status" data-testid="view-loading"
          className="absolute right-3 top-2 z-10 rounded-control border-[0.5px] border-line-default bg-surface-raised px-2 py-1.5 text-muted text-[length:var(--font-meta-size)]">
          正在加载{viewLabels[target]}…
        </p>}
      {retained.map(id => {
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
      <m.div key={shownView} aria-hidden="true" data-testid="canvas-content-handoff"
        className="pointer-events-none absolute inset-0 bg-surface-base"
        initial={{ opacity: 0.08 }} animate={{ opacity: 0 }} transition={motionTransitions['content-handoff']} />
      </div>
    </div>
  );
}
