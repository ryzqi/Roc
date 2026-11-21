import { useEffect, useRef, useState } from 'react';

export function ExecutionTimelineDrawer({open, onClose, children}: {
  open: boolean; onClose: () => void; children: React.ReactNode
}): React.JSX.Element | null {
  const [mounted, setMounted] = useState(open);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => { if (open) setMounted(true); }, [open]);
  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: Event): void => {
      // The header also owns the trigger. Keep normal Tab navigation through
      // this non-modal disclosure, then close when focus or a click leaves it.
      const header = panelRef.current?.parentElement;
      if (header && event.target instanceof Node && !header.contains(event.target)) closeRef.current();
    };
    document.addEventListener('pointerdown', dismissOutside, true);
    document.addEventListener('focusin', dismissOutside);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside, true);
      document.removeEventListener('focusin', dismissOutside);
    };
  }, [open]);
  if (!mounted) return null;
  return <div ref={panelRef} id="assistant-execution-timeline" hidden={!open}
    // Percentage height resolves against the 40px header. Bound the disclosure
    // to the viewport instead, and reserve the token's full shadow clearance.
    style={{insetInline: 'var(--shadow-popover-gutter)', maxHeight: 'min(45dvh, 24rem)'}}
    className="assistant-execution-timeline absolute top-10 z-20 overflow-y-auto rounded-card border-[0.5px] border-line-default bg-surface-overlay p-2 shadow-[var(--shadow-popover)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus-ring"
    data-testid="assistant-execution-timeline" role="region" aria-label="执行时间线" tabIndex={0}>
    {children}
  </div>;
}
