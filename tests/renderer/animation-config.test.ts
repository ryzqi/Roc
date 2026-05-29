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
    expect(titlebarBlock).toContain('width: 46px;');
    expect(titlebarBlock).toContain('height: 32px;');
    expect(titlebarBlock).toContain('border-radius: 0;');
    expect(closeHoverBlock).toContain('background: #c42b1c;');
    expect(closeHoverBlock).toContain('color: #ffffff;');
    expect(ipcContract).not.toContain("windowSetBounds: 'roc:window:set-bounds'");
    expect(preloadContract).not.toContain('setBounds: (bounds)');
  });

  it('uses Windows system theme and accent tokens as the renderer source of truth', () => {
    const tokensCss = readFileSync('src/renderer/styles/tokens.css', 'utf8');
    const baseCss = readFileSync('src/renderer/styles/base.css', 'utf8');

    expect(tokensCss).toContain('--system-accent: #2d477a;');
    expect(tokensCss).toContain('--accent: var(--system-accent);');
    expect(tokensCss).toContain('color-scheme: light;');
    expect(tokensCss).toContain(":root[data-theme='dark']");
    expect(tokensCss).toContain('color-scheme: dark;');
    expect(tokensCss).toContain(":root[data-forced-colors='true']");
    expect(tokensCss).toContain('--accent: Highlight;');
    expect(tokensCss).toContain("--font-sans: 'Segoe UI Variable', 'Segoe UI', 'Microsoft YaHei UI'");
    expect(tokensCss).toContain("--font-display: 'Segoe UI Variable', 'Segoe UI', 'Microsoft YaHei UI'");
    expect(tokensCss).not.toContain("--font-sans: 'Inter'");
    expect(tokensCss).not.toContain('--bg-gradient: linear-gradient');
    expect(baseCss).toContain('background: var(--bg);');
    expect(baseCss).not.toContain('background: var(--bg-gradient);');
  });
});
