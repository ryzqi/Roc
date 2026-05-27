import { describe, expect, it } from 'vitest';
import { buildSystemAppearanceSnapshot, normalizeRgbaHexColor } from '../../src/main/system-appearance';

describe('system appearance', () => {
  it('normalizes Windows RGBA system colors to renderer-safe RGB hex', () => {
    expect(normalizeRgbaHexColor('#0078D4FF')).toBe('#0078D4');
    expect(normalizeRgbaHexColor('#2d477a')).toBe('#2d477a');
    expect(normalizeRgbaHexColor('not-a-color')).toBe('#2d477a');
  });

  it('builds an appearance snapshot from Electron native theme and system colors', () => {
    expect(
      buildSystemAppearanceSnapshot({
        nativeTheme: {
          inForcedColorsMode: true,
          prefersReducedTransparency: true,
          shouldUseDarkColors: true,
          shouldUseHighContrastColors: true,
          shouldUseInvertedColorScheme: false,
          themeSource: 'system'
        },
        systemPreferences: {
          getColor: () => '#0078D4FF'
        }
      })
    ).toEqual({
      accentColor: '#0078D4',
      inForcedColorsMode: true,
      prefersReducedTransparency: true,
      resolvedTheme: 'dark',
      shouldUseHighContrastColors: true,
      shouldUseInvertedColorScheme: false,
      themeSource: 'system'
    });
  });
});
