import type { SystemAppearanceSnapshot } from '../shared/types';

const fallbackAccentColor = '#2d477a';

type NativeThemeSnapshotSource = {
  inForcedColorsMode: boolean;
  prefersReducedTransparency: boolean;
  shouldUseDarkColors: boolean;
  shouldUseHighContrastColors: boolean;
  shouldUseInvertedColorScheme: boolean;
  themeSource: 'system' | 'light' | 'dark';
};

type SystemPreferencesSnapshotSource = {
  getAccentColor: () => string;
};

export function normalizeRgbaHexColor(color: string): string {
  const normalized = color.startsWith('#') ? color : `#${color}`;
  if (/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(normalized)) {
    return normalized.slice(0, 7);
  }
  return fallbackAccentColor;
}

export function buildSystemAppearanceSnapshot(input: {
  nativeTheme: NativeThemeSnapshotSource;
  systemPreferences: SystemPreferencesSnapshotSource;
}): SystemAppearanceSnapshot {
  return {
    accentColor: normalizeRgbaHexColor(input.systemPreferences.getAccentColor()),
    inForcedColorsMode: input.nativeTheme.inForcedColorsMode,
    prefersReducedTransparency: input.nativeTheme.prefersReducedTransparency,
    resolvedTheme: input.nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
    shouldUseHighContrastColors: input.nativeTheme.shouldUseHighContrastColors,
    shouldUseInvertedColorScheme: input.nativeTheme.shouldUseInvertedColorScheme,
    themeSource: input.nativeTheme.themeSource
  };
}
