import type { Transition, Variants } from 'motion/react';

/**
 * The renderer's motion vocabulary, transcribed from the prototype.
 *
 * These are the animations `research-studio/src/**` actually ships, not a
 * restatement of a design intent:
 *
 * | surface                | source                                              |
 * |------------------------|-----------------------------------------------------|
 * | canvas tab indicator   | `WorkspaceCanvas` — `layoutId` + spring 0.18        |
 * | canvas view swap       | `WorkspaceCanvas` — `AnimatePresence mode="wait"` 0.12 opacity |
 * | popover / dropdown     | `AgentChat` — opacity + y:4 + scale:0.98, 0.12      |
 * | collapsible section    | `AgentChat` — opacity + height:auto, 0.16 / 0.15    |
 * | modal                  | `index.css` `.animate-scaleIn`, 0.18                |
 * | drawer                 | `index.css` `.animate-slideInRight`, 0.2            |
 *
 * Durations are literals on purpose. `--duration-fast/base/slow` (120/180/320ms)
 * is the shell's own micro-interaction ramp for CSS transitions; folding both
 * vocabularies into one scale would silently retime the prototype's animations.
 *
 * `prefers-reduced-motion` is *not* handled here. The root `MotionConfig
 * reducedMotion="user"` (main.tsx) covers every consumer — a component that checks
 * the media query itself would be a second source of truth. The CSS half of the
 * vocabulary does check it, once, in `styles/index.css`.
 */

/** research-studio's shared easing. */
const SOFT = [0.16, 1, 0.3, 1] as const;

/** Canvas view cross-fade (`AnimatePresence mode="wait"`, 120ms). */
export const viewFadeTransition: Transition = { duration: 0.12 };

export const viewFadeVariants: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 }
};

/**
 * The sliding underline shared by the canvas tab strip and the sidebar's own
 * tab strip. `layoutId` is what makes it travel between tabs rather than
 * blink; the spring is the prototype's `bounce: 0.15, duration: 0.18`.
 */
export const tabIndicatorTransition: Transition = { type: 'spring', bounce: 0.15, duration: 0.18 };

/** Popover, dropdown and menu entrance (opacity + 4px rise + 0.98 scale). */
export const popoverTransition: Transition = { duration: 0.12 };

export const popoverVariants: Variants = {
  initial: { opacity: 0, y: 4, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: 4, scale: 0.98 }
};

/**
 * Collapsible detail sections (tool-call bodies, reasoning blocks).
 *
 * `height: 'auto'` in a variant is a layout read per frame; it is the prototype's
 * own choice and the reason it needs `overflow-hidden` on the same element.
 * Two durations exist upstream (0.16 and 0.15) — both are exported rather than
 * averaged, because collapsing a tool result is the one transition the user
 * triggers dozens of times per session and the difference is visible in a trace.
 */
export const collapseTransition: Transition = { duration: 0.16, ease: 'easeOut' };
export const collapseTransitionShort: Transition = { duration: 0.15, ease: 'easeOut' };

export function collapseVariants(): Variants {
  return {
    initial: { opacity: 0, height: 0 },
    animate: { opacity: 1, height: 'auto' },
    exit: { opacity: 0, height: 0 }
  };
}

/** Modal entrance: `.animate-scaleIn` as a motion preset, for portal-hosted panels. */
export const modalPopTransition: Transition = { duration: 0.18, ease: SOFT };

export const modalPopVariants: Variants = {
  initial: { opacity: 0, scale: 0.98 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.98 }
};

/** Drawer entrance: `.animate-slideInRight` as a motion preset. */
export const drawerTransition: Transition = { duration: 0.2, ease: SOFT };

export const drawerVariants: Variants = {
  initial: { x: '100%' },
  animate: { x: 0 },
  exit: { x: '100%' }
};

/** Backdrop fade paired with either overlay above. */
export const scrimTransition: Transition = { duration: 0.18 };

export const scrimVariants: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 }
};
