import type { ViewProps } from './view-registry';

/**
 * Placeholder view factory used until each phase lands its real view.
 *
 * Kept in a `.tsx` module because it renders JSX, while `view-registry.ts` stays
 * a pure module (loaders + resolution bookkeeping) so it can be imported from
 * non-React code and unit-tested without a DOM.
 *
 * Every placeholder names the phase that replaces it, so an unfilled view is
 * obvious in the UI rather than looking like a finished surface.
 */
export function placeholderView(title: string, phase: string): (props: ViewProps) => React.JSX.Element {
  return function Placeholder() {
    return (
      <div className="flex h-full w-full items-center justify-center p-6" data-testid="view-placeholder">
        <div className="rounded-card border border-line bg-surface px-5 py-4 text-center">
          <p className="text-ink">{title}</p>
          <p className="mt-1 text-muted">尚未实现 · {phase}</p>
        </div>
      </div>
    );
  };
}
