import { useCallback, useEffect, useState } from 'react';
import type { SystemAppearanceSnapshot } from '../../shared/types';
import { readThemeOverride, writeThemeOverride, type ThemeOverride } from '../app/ui-state';
import type { RocClient } from '../shared/roc-client';

/**
 * Appearance bridge: system snapshot -> DOM attributes -> token layer.
 *
 * The macOS side sends `SystemAppearanceSnapshot` from `app.getStatus` and
 * `app.onAppearanceUpdated`. We only ever write attributes and the accent
 * variable; all color decisions live in `styles/tokens.css`.
 *
 * An in-app override (⌘D) is a UI preference and lives in `ui-state.ts`; it
 * never fights the system, it just wins over it until reset to `system`.
 */

export type AppearanceInput = {
  snapshot: SystemAppearanceSnapshot;
  override: ThemeOverride;
};

export function applyAppearance(input: AppearanceInput, root: HTMLElement = document.documentElement): void {
  const { snapshot, override } = input;
  const resolvedTheme = override === 'system' ? snapshot.resolvedTheme : override;

  root.dataset.theme = resolvedTheme;
  root.dataset.themeSource = override === 'system' ? snapshot.themeSource : 'app';
  root.dataset.forcedColors = String(snapshot.inForcedColorsMode);
  root.dataset.highContrast = String(snapshot.shouldUseHighContrastColors);
  root.dataset.reducedTransparency = String(snapshot.prefersReducedTransparency);
  root.style.setProperty('--system-accent', snapshot.accentColor);
  root.dataset.themeOverride = override;
}

/** Cycles system -> dark -> light -> system. */
export function cycleThemeOverride(current: ThemeOverride): ThemeOverride {
  if (current === 'system') {
    return 'dark';
  }
  if (current === 'dark') {
    return 'light';
  }
  return 'system';
}

export function themeOverrideLabel(override: ThemeOverride): string {
  if (override === 'light') {
    return '浅色';
  }
  if (override === 'dark') {
    return '深色';
  }
  return '跟随系统';
}

/**
 * Live in-app theme override.
 *
 * Returns reactive state rather than a mount-time snapshot: the sync effect
 * below depends on it, so toggling the override re-applies appearance without a
 * remount. Persisted through `ui-state.ts`, the only localStorage module.
 */
export function useAppearanceOverride(): {
  override: ThemeOverride;
  setOverride: (next: ThemeOverride) => void;
  cycle: () => void;
} {
  const [override, setOverrideState] = useState<ThemeOverride>(() => readThemeOverride());

  const setOverride = useCallback((next: ThemeOverride) => {
    writeThemeOverride(next);
    setOverrideState(next);
  }, []);

  const cycle = useCallback(() => {
    setOverrideState((current) => {
      const next = cycleThemeOverride(current);
      writeThemeOverride(next);
      return next;
    });
  }, []);

  return { override, setOverride, cycle };
}

/**
 * Applies the appearance snapshot and keeps it in sync with the system.
 *
 * `initial` may be null while the app is still booting; the subscription is
 * installed regardless so an appearance change that arrives before
 * `app.getStatus` resolves is not lost.
 */
export function useAppearanceSync(
  client: RocClient,
  initial: SystemAppearanceSnapshot | null,
  override: ThemeOverride
): void {
  useEffect(() => {
    if (initial !== null) {
      applyAppearance({ snapshot: initial, override });
    }
    return client.api.app.onAppearanceUpdated((snapshot) => {
      applyAppearance({ snapshot, override });
    });
  }, [client, initial, override]);
}
