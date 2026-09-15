import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('renderer animation configuration', () => {
  it('configures motion components to respect the system reduced-motion preference', () => {
    const entry = readFileSync('src/renderer/main.tsx', 'utf8');

    expect(entry).toContain("import { MotionConfig } from 'motion/react';");
    expect(entry).toContain('<MotionConfig reducedMotion="user">');
    expect(entry).toContain("import { bindWindowVisibility } from './window-visibility';");
    expect(entry).toContain('bindWindowVisibility();');
  });

  it('pauses infinite CSS animations while the hidden window stays resident', () => {
    const css = readFileSync('src/renderer/styles/animations.css', 'utf8');

    expect(css).toContain("html[data-window-hidden='true']");
    expect(css).toContain('animation-play-state: paused !important;');
  });

  it('keeps overlay motion on a duration ease instead of spring overshoot', () => {
    const motion = readFileSync('src/renderer/animations.ts', 'utf8');
    const tokens = readFileSync('src/renderer/styles/tokens.css', 'utf8');

    expect(motion).not.toContain("type: 'spring'");
    expect(tokens).toContain('--lift-hover: none;');
    expect(tokens).toContain('--easing-spring: var(--easing-standard);');
  });

  it('keeps CSS animations covered by reduced-motion media settings', () => {
    const css = readFileSync('src/renderer/styles/animations.css', 'utf8');

    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('animation-duration: 0.01ms !important;');
    expect(css).toContain('scroll-behavior: auto !important;');
  });

  it('removes task dialog backdrop blur when reduced transparency is requested', () => {
    const css = readFileSync('src/renderer/styles/task-create-dialog.css', 'utf8');

    expect(css).toContain(":root[data-reduced-transparency='true'] .task-create-dialog-backdrop");
    expect(css).toContain('backdrop-filter: none;');
  });

  it('keeps desktop interaction CSS rules from regressing into web defaults', () => {
    const baseCss = readFileSync('src/renderer/styles/base.css', 'utf8');
    const allCss = [
      'base.css',
      'app-shell.css',
      'animations.css',
      'chat.css',
      'composer.css',
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
    const ipcContract = readFileSync('src/shared/ipc.ts', 'utf8');
    const preloadContract = readFileSync('src/preload/index.ts', 'utf8');
    const pointerBlocks = Array.from(
      allCss.matchAll(/(?<selector>[^{}]+)\{(?<body>[^{}]*cursor\s*:\s*pointer\s*;[^{}]*)\}/gu)
    ).map((match) => match.groups?.selector.trim().replace(/\s+/g, ' ') ?? '');
    const baseBodyBlock = baseCss.match(/(^|\n)\s*body\s*\{(?<body>[^}]*)\}/u)?.groups?.body ?? '';

    expect(baseCss).not.toMatch(/(^|\n)\s*button\s*\{[^}]*cursor\s*:\s*pointer\s*;/u);
    expect(pointerBlocks).toEqual(['a[href]']);
    expect(baseBodyBlock).toContain('cursor: default;');
    expect(baseBodyBlock).toContain('user-select: none;');
    expect(baseCss).toContain('input,');
    expect(baseCss).toContain('.chat-message-row,');
    expect(baseCss).toContain('.code-preview,');
    expect(baseCss).toContain('.git-diff-scroll,');
    expect(baseCss).toContain('.terminal,');
    expect(baseCss).toContain('user-select: text;');
    expect(allCss).not.toMatch(/scroll-behavior\s*:\s*smooth\s*;/u);
    expect(appShellShadow).toBe('none');
    expect(allCss).not.toContain('.titlebar-button');
    expect(allCss).toContain('padding: 0 86px;');
    expect(ipcContract).not.toContain("windowSetBounds: 'roc:window:set-bounds'");
    expect(preloadContract).not.toContain('setBounds: (bounds)');
  });

  it('keeps empty titlebar space draggable around window controls', () => {
    const css = readFileSync('src/renderer/styles/app-shell.css', 'utf8');
    const workbandActionsBlock = css.match(/(^|\n)\.workband-actions\s*\{(?<body>[^}]*)\}/u)?.groups?.body ?? '';
    const noDragSelectorBlock = css.match(/(?<selectors>[^{}]+)\{\s*-webkit-app-region:\s*no-drag;\s*\}/u)?.groups?.selectors ?? '';

    expect(workbandActionsBlock).not.toContain('-webkit-app-region: no-drag;');
    expect(noDragSelectorBlock).toContain('.icon-button');
  });

  it('uses macOS system fonts, theme and accent tokens', () => {
    const tokensCss = readFileSync('src/renderer/styles/tokens.css', 'utf8');
    const baseCss = readFileSync('src/renderer/styles/base.css', 'utf8');

    expect(tokensCss).toContain('--system-accent: #2d477a;');
    expect(tokensCss).toContain('--accent: var(--system-accent);');
    expect(tokensCss).toContain('color-scheme: light;');
    expect(tokensCss).toContain(":root[data-theme='dark']");
    expect(tokensCss).toContain('color-scheme: dark;');
    expect(tokensCss).toContain(":root[data-forced-colors='true']");
    expect(tokensCss).toContain('--accent: Highlight;');
    expect(tokensCss).toContain('--font-sans: -apple-system, BlinkMacSystemFont');
    expect(tokensCss).toContain('--font-display: -apple-system, BlinkMacSystemFont');
    expect(tokensCss).not.toContain("--font-sans: 'Inter'");
    expect(tokensCss).not.toContain('--bg-gradient: linear-gradient');
    expect(baseCss).toContain('background: var(--bg);');
    expect(baseCss).not.toContain('background: var(--bg-gradient);');
  });
});
