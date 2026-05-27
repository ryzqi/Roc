import type { SystemAppearanceSnapshot } from '../shared/types';

export function applySystemAppearance(
  appearance: SystemAppearanceSnapshot,
  root: HTMLElement = document.documentElement
): void {
  root.dataset.theme = appearance.resolvedTheme;
  root.dataset.themeSource = appearance.themeSource;
  root.dataset.forcedColors = String(appearance.inForcedColorsMode);
  root.dataset.highContrast = String(appearance.shouldUseHighContrastColors);
  root.dataset.reducedTransparency = String(appearance.prefersReducedTransparency);
  root.style.setProperty('--system-accent', appearance.accentColor);
}
