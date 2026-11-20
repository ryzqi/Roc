import { useEffect, useEffectEvent } from 'react';
import { hasOpenDialog, overlayStackDepth } from '../shell/overlay-stack';
import type { AppViewId, LayoutPreset } from './routes';

const presets = ['research', 'writing', 'review'] as const;
const modes = ['overview', 'library', 'writing', 'runs'] as const;

export type ShortcutHandlers = {
  onToggleSidebar: () => void;
  onToggleAssistant: () => void;
  onOpenSearch: () => void;
  onCycleTheme: () => void;
  onLayoutPreset: (preset: LayoutPreset) => void;
  onNavigateMode: (mode: AppViewId) => void;
};

/** Native accelerators (including ⌘, and ⌘N) still arrive via app.onNavigate. */
export function useKeyboardShortcuts(handlers: ShortcutHandlers): void {
  const onKeyDown = useEffectEvent((event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || !event.metaKey || event.ctrlKey) return;
    const key = event.key.toLowerCase();
    const digit = /^Digit[1-4]$/u.test(event.code) ? Number(event.code.at(-1)) - 1 : Number(key) - 1;
    const preset = presets[digit];
    const mode = modes[digit];
    let action: (() => void) | undefined;
    if (!event.shiftKey && !event.altKey && key === 'k') action = handlers.onOpenSearch;
    else if (hasOpenDialog()) return;
    else if (!event.shiftKey && !event.altKey && key === 'b') action = handlers.onToggleSidebar;
    else if (!event.shiftKey && !event.altKey && (key === 'l' || key === 'j')) action = handlers.onToggleAssistant;
    else if (overlayStackDepth() > 0) return;
    else if (!event.shiftKey && event.altKey && mode !== undefined) action = () => handlers.onNavigateMode(mode);
    else if (!event.shiftKey && !event.altKey && preset !== undefined) action = () => handlers.onLayoutPreset(preset);
    else if (event.shiftKey && !event.altKey && key === 'f') action = () => handlers.onLayoutPreset('writing');
    else if (!event.shiftKey && !event.altKey && key === 'd') action = handlers.onCycleTheme;
    if (action === undefined) return;
    event.preventDefault();
    action();
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent): void => onKeyDown(event);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
}
