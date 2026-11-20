import { useEffect, useState } from 'react';

export function ExecutionTimelineDrawer({open, children}: {open: boolean; children: React.ReactNode}): React.JSX.Element | null {
  const [mounted, setMounted] = useState(open);
  useEffect(() => { if (open) setMounted(true); }, [open]);
  if (!mounted) return null;
  return <div id="assistant-execution-timeline" hidden={!open} className="assistant-execution-timeline absolute inset-inline-2 top-10 z-20 max-h-[45%] overflow-y-auto rounded-card border-[0.5px] border-line-default bg-surface-overlay p-2 shadow-[var(--shadow-popover)]" data-testid="assistant-execution-timeline" role="region" aria-label="执行时间线">
    {children}
  </div>;
}
