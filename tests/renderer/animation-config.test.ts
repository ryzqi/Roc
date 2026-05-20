import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('renderer animation configuration', () => {
  it('configures motion components to respect the system reduced-motion preference', () => {
    const entry = readFileSync('src/renderer/main.tsx', 'utf8');

    expect(entry).toContain("import { MotionConfig } from 'motion/react';");
    expect(entry).toContain('<MotionConfig reducedMotion="user">');
  });

  it('keeps CSS animations covered by reduced-motion media settings', () => {
    const css = readFileSync('src/renderer/styles/animations.css', 'utf8');

    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('animation-duration: 0.01ms !important;');
    expect(css).toContain('scroll-behavior: auto !important;');
  });
});
