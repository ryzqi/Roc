import {useLayoutEffect, useState} from 'react';
import {useTransitionStatus, type FloatingContext} from '@floating-ui/react';
import {getMotionTransition} from '../shared/motion';
import {useEffectiveReducedMotion} from '../shared/motion-preference';

/** Keep an exiting surface at its last position and reverse retained pixels in place. */
export function useFloatingSurfacePresence(context: FloatingContext, isPositioned: boolean, event: 'popover' | 'drawer'): {
  isMounted: boolean;
  visible: boolean;
  reduced: boolean;
  state: 'initial' | 'open' | 'close';
} {
  const reduced = useEffectiveReducedMotion();
  const {isMounted, status} = useTransitionStatus(context, {
    duration: {
      open: (getMotionTransition(event, reduced).duration ?? 0) * 1000,
      close: (getMotionTransition(event, reduced, 'exit').duration ?? 0) * 1000
    }
  });
  const [positioned, setPositioned] = useState(false);
  const [entered, setEntered] = useState(false);
  useLayoutEffect(() => {
    if (!isMounted) {
      setPositioned(false);
      setEntered(false);
    } else if (isPositioned) {
      setPositioned(true);
      if (status === 'open') setEntered(true);
    }
  }, [isMounted, isPositioned, status]);
  const visible = isPositioned || positioned;
  return {
    isMounted,
    visible,
    reduced,
    // Floating UI replays `initial` on every open, including a retained exit.
    // Once entered, CSS transitions must instead reverse from their current frame.
    state: !context.open ? 'close' : visible && (entered || status === 'open') ? 'open' : 'initial'
  };
}
