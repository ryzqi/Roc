import { m } from 'motion/react';
import { getMotionTransition } from './motion';
import { useEffectiveReducedMotion } from './motion-preference';

/** The owner supplies an instance-scoped identity; selection and focus stay on its control. */
export function SelectionIndicator({ layoutId, className, testId }: {
  layoutId: string;
  className: string;
  testId: string;
}): React.JSX.Element {
  const reduced = useEffectiveReducedMotion();
  // A fresh decorative node releases an in-flight projection when the user
  // reduces motion. Control identity, focus and selection remain untouched.
  return <m.span key={reduced ? 'still' : 'moving'} aria-hidden="true"
    layoutId={reduced ? undefined : layoutId} initial={false}
    transition={getMotionTransition('selection', reduced)} className={`pointer-events-none absolute ${className}`}
    data-motion-reduced={reduced || undefined}
    data-testid={testId} data-selection-id={layoutId} />;
}
