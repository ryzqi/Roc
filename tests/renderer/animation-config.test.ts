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

  it('keeps Windows native-feel CSS rules from regressing into web defaults', () => {
    const baseCss = readFileSync('src/renderer/styles/base.css', 'utf8');
    const allCss = [
      'base.css',
      'app-shell.css',
      'animations.css',
      'chat.css',
      'composer.css',
      'floating.css',
      'git.css',
      'settings.css',
      'shared.css',
      'skills.css',
      'workbench.css'
    ]
      .map((fileName) => readFileSync(`src/renderer/styles/${fileName}`, 'utf8'))
      .join('\n');
    const appShellBlock = allCss.match(/(^|\n)\s*\.app-shell\s*\{(?<body>[^}]*)\}/u)?.groups?.body ?? '';
    const appShellShadow = appShellBlock.match(/box-shadow\s*:\s*([^;]+);/u)?.[1]?.trim();
    const titlebarBlock = allCss.match(/(^|\n)\s*\.titlebar-button\s*\{(?<body>[^}]*)\}/u)?.groups?.body ?? '';
    const closeHoverBlock =
      allCss.match(/(^|\n)\s*\.titlebar-button\.danger:hover\s*\{(?<body>[^}]*)\}/u)?.groups?.body ?? '';
    const ipcContract = readFileSync('src/shared/ipc.ts', 'utf8');
    const preloadContract = readFileSync('src/preload/index.ts', 'utf8');

    expect(baseCss).not.toMatch(/(^|\n)\s*button\s*\{[^}]*cursor\s*:\s*pointer\s*;/u);
    expect(allCss).not.toMatch(/scroll-behavior\s*:\s*smooth\s*;/u);
    expect(appShellShadow).toBe('none');
    expect(titlebarBlock).toContain('width: 46px;');
    expect(titlebarBlock).toContain('height: 32px;');
    expect(titlebarBlock).toContain('border-radius: 0;');
    expect(closeHoverBlock).toContain('background: #c42b1c;');
    expect(closeHoverBlock).toContain('color: #ffffff;');
    expect(ipcContract).not.toContain("windowSetBounds: 'roc:window:set-bounds'");
    expect(preloadContract).not.toContain('setBounds: (bounds)');
  });
});
