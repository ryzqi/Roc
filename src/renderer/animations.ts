import type { Transition, Variants } from 'motion/react';

const EASING_STANDARD_TUPLE: [number, number, number, number] = [0.2, 0.8, 0.2, 1];
const reducedMotionTransition: Transition = { duration: 0 };

const reducedVariants: Variants = {
  initial: { opacity: 1 },
  animate: { opacity: 1 },
  exit: { opacity: 1 }
};

export const drawerSlideIn: Variants = {
  initial: { x: 24, opacity: 0 },
  animate: { x: 0, opacity: 1, transition: { duration: 0.18, ease: EASING_STANDARD_TUPLE } },
  exit: { x: 24, opacity: 0, transition: { duration: 0.12, ease: EASING_STANDARD_TUPLE } }
};

export const modalBackdropFade: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.16, ease: EASING_STANDARD_TUPLE } },
  exit: { opacity: 0, transition: { duration: 0.12, ease: EASING_STANDARD_TUPLE } }
};

// 整数像素位移，不用 scale。退出 120ms，短于进入。
export const modalPop: Variants = {
  initial: { y: 8, opacity: 0 },
  animate: { y: 0, opacity: 1, transition: { duration: 0.16, ease: EASING_STANDARD_TUPLE } },
  exit: { y: 8, opacity: 0, transition: { duration: 0.12, ease: EASING_STANDARD_TUPLE } }
};

export const scrollBottomFade: Variants = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.16, ease: EASING_STANDARD_TUPLE } },
  exit: { opacity: 0, y: 6, transition: { duration: 0.12, ease: EASING_STANDARD_TUPLE } }
};

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function resolveMotionVariants(variants: Variants): Variants {
  return prefersReducedMotion() ? reducedVariants : variants;
}

export function resolveMotionTransition(): Transition | undefined {
  return prefersReducedMotion() ? reducedMotionTransition : undefined;
}
