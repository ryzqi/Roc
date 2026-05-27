// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { applySystemAppearance } from '../../src/renderer/system-appearance';

describe('renderer system appearance', () => {
  it('applies the main-process appearance snapshot to root theme attributes and variables', () => {
    applySystemAppearance(
      {
        accentColor: '#0078D4',
        inForcedColorsMode: true,
        prefersReducedTransparency: true,
        resolvedTheme: 'dark',
        shouldUseHighContrastColors: true,
        shouldUseInvertedColorScheme: false,
        themeSource: 'system'
      },
      document.documentElement
    );

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.dataset.themeSource).toBe('system');
    expect(document.documentElement.dataset.forcedColors).toBe('true');
    expect(document.documentElement.dataset.highContrast).toBe('true');
    expect(document.documentElement.dataset.reducedTransparency).toBe('true');
    expect(document.documentElement.style.getPropertyValue('--system-accent')).toBe('#0078D4');
  });
});
