import { useEffect, useState } from 'react';

/**
 * Deferred loading indicator.
 *
 * Shows nothing for the first 200ms so a fast chunk load does not flash a
 * placeholder, then renders a one-line status. Used by both the canvas view
 * host and the lazily loaded overlays.
 *
 * `role="status"` rather than `role="alert"`: waiting is not a problem.
 */

export type DelayedFallbackProps = {
  label?: string;
  delayMs?: number;
  testId?: string;
};

export function DelayedFallback({
  label = '正在加载视图…',
  delayMs = 200,
  testId = 'view-loading'
}: DelayedFallbackProps): React.JSX.Element | null {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const handle = window.setTimeout(() => setVisible(true), delayMs);
    return () => window.clearTimeout(handle);
  }, [delayMs]);

  if (!visible) {
    return null;
  }

  return (
    <div
      className="flex h-full w-full items-center justify-center p-6 text-muted"
      data-testid={testId}
      role="status"
    >
      {label}
    </div>
  );
}
