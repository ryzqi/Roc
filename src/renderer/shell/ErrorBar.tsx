import { AlertTriangle, CircleSlash, RotateCcw, X } from 'lucide-react';
import type { AppError } from '../app/errors';

/**
 * Page-level and blocked-level error surfaces.
 *
 * `page` renders a dismissible `role="alert"` bar; `blocked` renders an in-canvas
 * explanation with a recovery affordance, because a refusal is an expected
 * outcome that should say how to proceed rather than read as a crash.
 *
 * `startup` and `field` are rendered by their own owners
 * (`shell/StartupSurface.tsx` and each form) — this component rejects them at
 * the type level so the five levels cannot drift.
 */

export type ErrorBarProps = {
  error: Extract<AppError, { level: 'page' | 'blocked' }>;
  onDismiss?: () => void;
};

export function ErrorBar({ error, onDismiss }: ErrorBarProps): React.JSX.Element {
  const blocked = error.level === 'blocked';
  const Icon = blocked ? CircleSlash : AlertTriangle;

  return (
    <div
      role={blocked ? 'note' : 'alert'}
      data-testid={blocked ? 'error-blocked' : 'error-page'}
      data-level={error.level}
      className="flex items-start gap-2 rounded-card border px-3 py-2"
      style={{
        borderColor: blocked ? 'var(--st-warn-line)' : 'var(--st-bad-line)',
        background: 'var(--surface)'
      }}
    >
      <Icon size={14} aria-hidden="true" className={blocked ? 'mt-0.5 text-[var(--st-warn)]' : 'mt-0.5 text-[var(--st-bad)]'} />
      <div className="min-w-0 flex-1">
        <p className="text-ink break-words">{error.message}</p>
        {error.code === undefined || error.code === null ? null : (
          <p className="font-mono text-muted text-[var(--font-micro-size)]">{error.code}</p>
        )}
        <div className="mt-1 flex items-center gap-2">
          {error.retry === undefined ? null : (
            <button
              type="button"
              onClick={error.retry}
              className="inline-flex h-[var(--control-height-compact)] items-center gap-1 rounded-control border border-line px-2 text-muted hover:text-ink active:bg-[var(--overlay-active)]"
            >
              <RotateCcw size={12} aria-hidden="true" />
              重试
            </button>
          )}
          {error.actionLabel === undefined ? null : (
            <span className="text-muted text-[var(--font-meta-size)]">{error.actionLabel}</span>
          )}
        </div>
      </div>
      {onDismiss === undefined ? null : (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="关闭错误提示"
          className="rounded-control p-1 text-muted hover:text-ink active:bg-[var(--overlay-active)]"
        >
          <X size={13} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
