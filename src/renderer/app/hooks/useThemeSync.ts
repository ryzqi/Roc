import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import type { SystemAppearanceSnapshot } from '../../../shared/types';
import type { RocClient } from '../../shared/roc-client';
import { readThemeOverride, uiStateKeys, writeThemeOverride, type ThemeOverride } from '../ui-state';

export const THEME_OVERRIDES = ['system', 'dark', 'light', 'paper'] as const;
export const THEME_LABELS: Record<ThemeOverride, string> = {
  system: '跟随系统', dark: '深色', light: '浅色', paper: '暖纸'
};

export function useThemeSync(client: RocClient, initial: SystemAppearanceSnapshot | null): {
  override: ThemeOverride;
  setOverride: (next: ThemeOverride) => void;
  cycle: () => void;
} {
  const [override, setOverrideState] = useState(readThemeOverride);
  const [updated, setUpdated] = useState<SystemAppearanceSnapshot | null>(null);
  const snapshot = updated ?? initial;
  const setOverride = useCallback((next: ThemeOverride) => {
    writeThemeOverride(next);
    setOverrideState(next);
  }, []);

  useEffect(() => client.api.app.onAppearanceUpdated(setUpdated), [client]);
  useEffect(() => {
    const sync = (event: StorageEvent): void => {
      if (event.key === uiStateKeys.themeOverride || event.key === null) setOverrideState(readThemeOverride());
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = override === 'system' ? snapshot?.resolvedTheme ?? 'dark' : override;
    root.dataset.themeOverride = override;
    if (snapshot === null) return;
    root.dataset.themeSource = override === 'system' ? snapshot.themeSource : 'app';
    root.dataset.forcedColors = String(snapshot.inForcedColorsMode);
    root.dataset.highContrast = String(snapshot.shouldUseHighContrastColors);
    root.dataset.reducedTransparency = String(snapshot.prefersReducedTransparency);
    root.style.setProperty('--system-accent', snapshot.accentColor);
  }, [override, snapshot]);

  return { override, setOverride, cycle: () => {
    const next = THEME_OVERRIDES[(THEME_OVERRIDES.indexOf(override) + 1) % THEME_OVERRIDES.length] ?? 'system';
    setOverride(next);
  } };
}
