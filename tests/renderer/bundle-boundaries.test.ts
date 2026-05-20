import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('renderer bundle boundaries', () => {
  it('declares dedicated renderer entries for quick and tray floating windows', () => {
    const viteConfig = readFileSync('electron.vite.config.ts', 'utf8');

    expect(viteConfig).toContain("quick: resolve(__dirname, 'quick-entry.html')");
    expect(viteConfig).toContain("tray: resolve(__dirname, 'tray-entry.html')");
    expect(existsSync('quick-entry.html')).toBe(true);
    expect(existsSync('tray-entry.html')).toBe(true);
  });

  it('loads floating windows without reusing the main page query entry', () => {
    const mainIndex = readFileSync('src/main/index.ts', 'utf8');

    expect(mainIndex).not.toContain("loadRenderer(entryWindow, new URLSearchParams({ page: kind }))");
    expect(mainIndex).toContain("await loadFloatingRenderer(entryWindow, kind);");
  });

  it('keeps non-chat views behind lazy renderer boundaries', () => {
    const viewContent = readFileSync('src/renderer/views/ViewContent.tsx', 'utf8');

    expect(viewContent).not.toContain("import { GitView } from './git/GitView';");
    expect(viewContent).not.toContain("import { TerminalView } from './terminal/TerminalView';");
    expect(viewContent).not.toContain("import { SkillsHostView } from './skills/SkillsHostView';");
    expect(viewContent).toContain("lazy(() => import('./git/GitView')");
    expect(viewContent).toContain("lazy(() => import('./terminal/TerminalView')");
    expect(viewContent).toContain("lazy(() => import('./skills/SkillsHostView')");
  });

  it('lazy-loads the workbench panel outside the chat first-screen bundle', () => {
    const app = readFileSync('src/renderer/App.tsx', 'utf8');

    expect(app).not.toContain("import { WorkbenchPanel } from './workbench/WorkbenchPanel';");
    expect(app).toContain("import('./workbench/WorkbenchPanel')");
  });
});
