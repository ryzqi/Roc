import type { TargetAndTransition, Transition, Variants } from 'motion/react';

/** CSS uses milliseconds; this explicit seconds mapping is checked by the contract test. */
export const motionDurationSeconds = {
  micro: 0.09,
  fast: 0.15,
  base: 0.22,
  overlay: 0.22,
  legacySlow: 0.28,
  icon: 0.14,
  removal: 0.11,
  error: 0.26,
  number: 0.18,
  reduced: 0.1
} as const;

export const motionEasing = {
  standard: [0.2, 0, 0, 1],
  soft: [0.16, 1, 0.3, 1],
  exit: [0.4, 0, 1, 1]
} as const;

export type MotionEvent =
  | 'feedback'
  | 'selection'
  | 'popover'
  | 'modal'
  | 'drawer'
  | 'content-handoff'
  | 'list-small'
  | 'icon'
  | 'removal'
  | 'error'
  | 'number';

export type MotionPhase = 'enter' | 'exit';
export type MotionDirection = -1 | 0 | 1;
// Motion 14.14 reads this at runtime but omits it from React's Transition type.
export type EffectiveMotionTransition = Transition & { reduceMotion: boolean };

/** Presentation only: input, request identity, focus and presence stay with the owner. */
export const motionTransitions = {
  feedback: { duration: motionDurationSeconds.fast, ease: motionEasing.standard },
  selection: { type: 'spring', bounce: 0, duration: motionDurationSeconds.base },
  popover: { type: 'spring', bounce: 0, duration: motionDurationSeconds.overlay },
  modal: { type: 'spring', bounce: 0, duration: motionDurationSeconds.base },
  drawer: { type: 'spring', bounce: 0, duration: motionDurationSeconds.overlay },
  'content-handoff': { duration: motionDurationSeconds.fast, ease: motionEasing.standard },
  'list-small': { duration: motionDurationSeconds.base, ease: motionEasing.soft },
  icon: { type: 'spring', bounce: 0, duration: motionDurationSeconds.icon },
  removal: { duration: motionDurationSeconds.removal, ease: motionEasing.exit },
  error: { duration: motionDurationSeconds.error, ease: motionEasing.standard },
  number: { duration: motionDurationSeconds.number, ease: motionEasing.standard }
} satisfies Record<MotionEvent, Transition>;

/** Explicit reduceMotion also updates already-mounted Motion visual elements. */
export function getMotionTransition(
  event: MotionEvent,
  reduced: boolean,
  phase: MotionPhase = 'enter'
): EffectiveMotionTransition {
  if (reduced) {
    return { type: 'tween', duration: motionDurationSeconds.reduced, ease: motionEasing.standard, reduceMotion: true };
  }
  if (phase === 'exit') {
    return {
      type: 'tween',
      duration: ['removal', 'content-handoff', 'error', 'number'].includes(event) ? motionDurationSeconds.removal
        : event === 'icon' ? motionDurationSeconds.icon : motionDurationSeconds.fast,
      ease: motionEasing.exit,
      reduceMotion: false
    };
  }
  return { ...motionTransitions[event], reduceMotion: false };
}

/** Neutral transform values reset an in-flight animation when the preference changes. */
export function getMotionVariants(
  event: MotionEvent,
  reduced: boolean,
  direction: MotionDirection = 0
): Variants {
  let initial: TargetAndTransition = { opacity: 0 };
  let animate: TargetAndTransition = { opacity: 1 };
  let exit: TargetAndTransition = { opacity: 0 };
  if (reduced) {
    const neutral = { x: 0, y: 0, scale: 1, rotate: 0 };
    initial = { ...initial, ...neutral };
    animate = { ...animate, ...neutral };
    exit = { ...exit, ...neutral };
  } else {
    switch (event) {
      case 'popover':
        initial = { opacity: 0, y: 4, scale: 0.98 };
        animate = { opacity: 1, y: 0, scale: 1 };
        exit = { ...initial };
        break;
      case 'modal':
        initial = { opacity: 0, scale: 0.98 };
        animate = { opacity: 1, scale: 1 };
        exit = { ...initial };
        break;
      case 'drawer':
        initial = { opacity: 0, x: direction < 0 ? '-100%' : '100%' };
        animate = { opacity: 1, x: 0 };
        exit = { ...initial };
        break;
      case 'content-handoff':
      case 'number':
        initial = { opacity: 0, y: direction * 4 };
        animate = { opacity: 1, y: 0 };
        exit = { opacity: 0, y: direction * -4 };
        break;
      case 'list-small':
        initial = { opacity: 0, y: 4 };
        animate = { opacity: 1, y: 0 };
        exit = { opacity: 0, y: -4 };
        break;
      case 'icon':
        initial = { opacity: 0, scale: 0.7 };
        animate = { opacity: 1, scale: 1 };
        exit = { ...initial };
        break;
      case 'removal':
        initial = { opacity: 1, scale: 1 };
        animate = { ...initial };
        exit = { opacity: 0, scale: 0.97 };
        break;
      case 'error':
        initial = { opacity: 1, x: 0 };
        animate = { opacity: 1, x: [0, -4, 4, -2, 2, 0] };
        exit = { opacity: 0, x: 0 };
        break;
      case 'feedback':
      case 'selection':
        break;
    }
  }
  return {
    initial,
    animate: { ...animate, transition: getMotionTransition(event, reduced) },
    exit: { ...exit, transition: getMotionTransition(event, reduced, 'exit') }
  };
}

/** Backdrops follow their surface's lifetime without adding positional motion. */
export function getScrimVariants(event: 'modal' | 'drawer', reduced: boolean): Variants {
  return {
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: getMotionTransition(event, reduced) },
    exit: { opacity: 0, transition: getMotionTransition(event, reduced, 'exit') }
  };
}

/** Compatibility exports share the event scale; live consumers use the getters above. */
export const tabIndicatorTransition: Transition = motionTransitions.selection;
export const popoverTransition: Transition = motionTransitions.popover;
export const popoverVariants: Variants = getMotionVariants('popover', false);
export const modalPopTransition: Transition = motionTransitions.modal;
export const modalPopVariants: Variants = getMotionVariants('modal', false);
export const drawerTransition: Transition = motionTransitions.drawer;
export const drawerVariants: Variants = getMotionVariants('drawer', false);
export const scrimTransition: Transition = { duration: motionDurationSeconds.base };
export const scrimVariants: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 }
};
