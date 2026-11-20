import { useEffect, useRef } from 'react';
import { overlayStackDepth } from '../shell/use-overlay-behavior';

/**
 * Renderer-side keyboard shortcuts.
 *
 * ## Split with the native menu (important)
 *
 * `src/main/application-menu.ts` registers real menu accelerators for ⌘, (设置)
 * and ⌘N (新建研究项目), and Electron consumes those keys before the renderer
 * sees them. They therefore arrive through `app.onNavigate` and must **not** be
 * re-implemented here, or every press would fire twice.
 *
 * Handled natively (do not add here): ⌘, · ⌘N · ⌘W · ⌘M · ⌘H · ⌘Q · ⌘± · ⌘0
 * and the whole edit menu.
 *
 * Handled here (no native menu item exists): ⌘B · ⌘J · ⌘K · ⌘D · 1/2/3.
 * Escape layering is owned by `useOverlayBehavior`, not this table.
 *
 * ## While an overlay is open
 *
 * Panel and navigation keys are suppressed so a shortcut cannot silently mutate
 * the view *behind* a modal (collapsing the sidebar, or switching the canvas
 * view, while the user is looking at a dialog). ⌘K stays live whatever is open,
 * so the palette stays reachable.
 *
 * Unmodified digits are also ignored while focus is in a text field, so typing
 * "1" into the assistant composer never navigates.
 */

export type ShortcutHandlers = {
  onToggleSidebar: () => void;
  onToggleAssistant: () => void;
  onOpenSearch: () => void;
  onCycleTheme: () => void;
  onToggleFocus?: () => void;
};

export function useKeyboardShortcuts(handlers: ShortcutHandlers): void {
  // Keep handlers reachable from a listener installed once, so shortcut
  // registration never re-runs on unrelated re-renders.
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const meta = event.metaKey;
      const key = event.key.toLowerCase();
      const withShiftOrAlt = event.shiftKey || event.altKey;

      if (meta && event.shiftKey && !event.altKey && key === 'f' && !event.isComposing && overlayStackDepth() === 0) {
        event.preventDefault();
        ref.current.onToggleFocus?.();
        return;
      }
      if (meta && !withShiftOrAlt) {
        // ⌘K is the one shortcut that works through an overlay: it opens the
        // palette and, when the palette is already open, is a no-op there.
        if (key === 'k') {
          event.preventDefault();
          ref.current.onOpenSearch();
          return;
        }
        if (overlayStackDepth() > 0) {
          return;
        }
        if (key === 'b') {
          event.preventDefault();
          ref.current.onToggleSidebar();
          return;
        }
        if (key === 'j') {
          event.preventDefault();
          ref.current.onToggleAssistant();
          return;
        }
        if (key === 'd') {
          event.preventDefault();
          ref.current.onCycleTheme();
        }
        return;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
