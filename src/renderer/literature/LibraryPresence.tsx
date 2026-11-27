import {useMemo, type ReactNode} from 'react';
import {m, useIsPresent} from 'motion/react';
import {getMotionVariants, type MotionEvent} from '../shared/motion';
import {useEffectiveReducedMotion} from '../shared/motion-preference';

/** Visual retention never extends permission to operate the outgoing controls. */
export function LibraryPresence({children, className, event = 'popover', direction = 0}: {
  children: ReactNode;
  className?: string;
  event?: MotionEvent;
  direction?: -1 | 0 | 1;
}): React.JSX.Element {
  const present = useIsPresent();
  const reduced = useEffectiveReducedMotion();
  const variants = useMemo(() => getMotionVariants(event, reduced, direction), [event, reduced, direction]);
  return <m.div className={className} inert={!present} aria-hidden={present ? undefined : true}
    data-present={present} data-motion-reduced={reduced || undefined}
    transformTemplate={reduced ? () => 'none' : undefined}
    variants={variants} initial="initial" animate="animate" exit="exit">
    {children}
  </m.div>;
}
