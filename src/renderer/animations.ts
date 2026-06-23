import type { Transition, Variants } from 'motion/react';

const EASING_STANDARD_TUPLE: [number, number, number, number] = [0.2, 0.8, 0.2, 1];
const EASING_SOFT_TUPLE: [number, number, number, number] = [0.16, 1, 0.3, 1];

export const drawerSlideIn: Variants = {
  initial: { x: 24, opacity: 0 },
  animate: { x: 0, opacity: 1 },
  exit: { x: 24, opacity: 0 }
};

export const drawerTransition: Transition = {
  type: 'spring',
  stiffness: 260,
  damping: 30
};

export const modalBackdropFade: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 }
};

export const modalPop: Variants = {
  initial: { scale: 0.97, opacity: 0 },
  animate: { scale: 1, opacity: 1 },
  exit: { scale: 0.98, opacity: 0 }
};

export const modalPopTransition: Transition = {
  duration: 0.2,
  ease: EASING_STANDARD_TUPLE
};

export const userBubbleEnter: Variants = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 }
};

export const assistantBubbleEnter: Variants = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 }
};

export const bubbleEnterTransition: Transition = {
  duration: 0.28,
  ease: EASING_SOFT_TUPLE
};

export const approvalCardEnter: Variants = {
  initial: { opacity: 0, scale: 0.97, y: 6 },
  animate: { opacity: 1, scale: 1, y: 0 }
};

export const approvalCardTransition: Transition = {
  type: 'spring',
  stiffness: 240,
  damping: 24
};

export const scrollBottomFade: Variants = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 6 }
};

export const scrollBottomTransition: Transition = {
  duration: 0.18,
  ease: EASING_STANDARD_TUPLE
};

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function resolveMotionTransition(transition: Transition): Transition {
  if (!prefersReducedMotion()) {
    return transition;
  }
  return { duration: 0 };
}
