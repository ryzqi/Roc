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
  getColor: (color: 'highlight') => string;
};

export function normalizeRgbaHexColor(color: string): string {
  if (/^#[0-9a-fA-F]{6}$/.test(color)) {
    return color;
  }
  if (/^#[0-9a-fA-F]{8}$/.test(color)) {
    return color.slice(0, 7);
  }
  return fallbackAccentColor;
}

export function buildSystemAppearanceSnapshot(input: {
  nativeTheme: NativeThemeSnapshotSource;
  systemPreferences: SystemPreferencesSnapshotSource;
}): SystemAppearanceSnapshot {
  return {
    accentColor: normalizeRgbaHexColor(input.systemPreferences.getColor('highlight')),
    inForcedColorsMode: input.nativeTheme.inForcedColorsMode,
    prefersReducedTransparency: input.nativeTheme.prefersReducedTransparency,
    resolvedTheme: input.nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
    shouldUseHighContrastColors: input.nativeTheme.shouldUseHighContrastColors,
    shouldUseInvertedColorScheme: input.nativeTheme.shouldUseInvertedColorScheme,
    themeSource: input.nativeTheme.themeSource
  };
}
