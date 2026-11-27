import type {HTMLMotionProps} from 'motion/react';
import * as motion from 'motion/react-m';
import {getMotionVariants, getScrimVariants} from '../shared/motion';
import {useEffectiveReducedMotion} from '../shared/motion-preference';

/** Subscribe inside the presence tree so exiting pixels honor preference changes too. */
export function OverlayMotionSurface({kind, scrim = false, ...props}: Omit<
  HTMLMotionProps<'div'>, 'variants' | 'initial' | 'animate' | 'exit' | 'transition'
> & {kind: 'modal' | 'drawer'; scrim?: boolean}): React.JSX.Element {
  const reduced = useEffectiveReducedMotion();
  return <motion.div {...props}
    transformTemplate={reduced ? () => 'none' : props.transformTemplate}
    variants={scrim ? getScrimVariants(kind, reduced) : getMotionVariants(kind, reduced)}
    initial="initial" animate="animate" exit="exit"/>;
}
