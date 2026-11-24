import type { Transition, Variants } from 'motion/react';

/**
 * Event presets share the CSS scale in styles/tokens.css. Motion takes seconds;
 * CSS takes milliseconds. A contract check keeps the explicit mapping in sync
 * without reading computed styles at runtime.
 *
 * Existing surface exports below are aliases, so ModalShell, its scrim and
 * local popovers retain their timing and variants.
 *
 * `prefers-reduced-motion` is *not* handled here. The root `MotionConfig
 * reducedMotion="user"` (main.tsx) covers every consumer — a component that checks
 * the media query itself would be a second source of truth. The CSS half of the
 * vocabulary does check it, once, in `styles/index.css`.
 */

export const motionDurationSeconds = {
  micro: 0.08,
  fast: 0.12,
  base: 0.18,
  overlay: 0.2,
  legacySlow: 0.32
} as const;

export const motionEasing = {
  standard: [0.2, 0.8, 0.2, 1],
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
  | 'list-small';

/** Presentation only: input, request identity, focus and presence stay with the owner. */
export const motionTransitions = {
  feedback: { duration: motionDurationSeconds.fast, ease: motionEasing.standard },
  selection: { type: 'spring', bounce: 0.15, duration: motionDurationSeconds.base },
  popover: { duration: motionDurationSeconds.fast },
  modal: { duration: motionDurationSeconds.base, ease: motionEasing.soft },
  drawer: { duration: motionDurationSeconds.overlay, ease: motionEasing.soft },
  'content-handoff': { duration: motionDurationSeconds.fast, ease: motionEasing.standard },
  'list-small': { duration: motionDurationSeconds.base, ease: motionEasing.soft }
} satisfies Record<MotionEvent, Transition>;

/**
 * The sliding underline shared by the canvas tab strip and the sidebar's own
 * tab strip. `layoutId` is what makes it travel between tabs rather than
 * blink; the spring is `bounce: 0.15, duration: 0.18`.
 */
export const tabIndicatorTransition: Transition = motionTransitions.selection;

/** Popover, dropdown and menu entrance (opacity + 4px rise + 0.98 scale). */
export const popoverTransition: Transition = motionTransitions.popover;

export const popoverVariants: Variants = {
  initial: { opacity: 0, y: 4, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: 4, scale: 0.98 }
};

/** Modal entrance (opacity + 0.98 scale), for portal-hosted panels. */
export const modalPopTransition: Transition = motionTransitions.modal;

export const modalPopVariants: Variants = {
  initial: { opacity: 0, scale: 0.98 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.98 }
};

/** Drawer entrance: slide in from the right. */
export const drawerTransition: Transition = motionTransitions.drawer;

export const drawerVariants: Variants = {
  initial: { x: '100%' },
  animate: { x: 0 },
  exit: { x: '100%' }
};

/** Backdrop fade paired with either overlay above. */
export const scrimTransition: Transition = { duration: motionDurationSeconds.base };

export const scrimVariants: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 }
};
