import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('renderer bundle boundaries', () => {
  it('does not declare quick or tray floating renderer entries', () => {
    const viteConfig = readFileSync('electron.vite.config.ts', 'utf8');

    expect(viteConfig).not.toContain('quick-entry.html');
    expect(viteConfig).not.toContain('tray-entry.html');
    expect(existsSync('quick-entry.html')).toBe(false);
    expect(existsSync('tray-entry.html')).toBe(false);
  });

  it('does not keep a main-process floating window loader', () => {
    const mainIndex = readFileSync('src/main/index.ts', 'utf8');

    expect(mainIndex).not.toContain('loadFloatingRenderer');
    expect(mainIndex).not.toContain('openFloatingEntry');
    expect(mainIndex).not.toContain('quickEntryWindow');
    expect(mainIndex).not.toContain('trayEntryWindow');
  });

  it('does not expose quick or tray floating entry IPC on the preload app API', () => {
    const ipcContract = readFileSync('src/shared/ipc.ts', 'utf8');
    const preloadContract = readFileSync('src/preload/index.ts', 'utf8');

    expect(ipcContract).not.toContain('appOpenQuickEntry');
    expect(ipcContract).not.toContain('appOpenTrayEntry');
    expect(preloadContract).not.toContain('openQuickEntry');
    expect(preloadContract).not.toContain('openTrayEntry');
  });

  it('keeps heavy workbench views behind lazy renderer boundaries', () => {
    const viewContent = readFileSync('src/renderer/views/ViewContent.tsx', 'utf8');

    expect(viewContent).not.toContain("import { GitView } from './git/GitView';");
    expect(viewContent).not.toContain("import { TerminalView } from './terminal/TerminalView';");
    expect(viewContent).toContain("lazy(() => import('./git/GitView')");
    expect(viewContent).toContain("lazy(() => import('./terminal/TerminalView')");
  });

  it('routes skills through the feature boundary instead of importing the host view directly', () => {
    const viewContent = readFileSync('src/renderer/views/ViewContent.tsx', 'utf8');

    expect(viewContent).not.toContain("import { SkillsHostView } from './skills/SkillsHostView';");
    expect(viewContent).toContain("import { SkillsFeature } from '../features/skills';");
  });

  it('lazy-loads the workbench panel outside the chat first-screen bundle', () => {
    const app = readFileSync('src/renderer/App.tsx', 'utf8');
    const appShell = readFileSync('src/renderer/app/AppShell.tsx', 'utf8');

    expect(app).not.toContain("import { WorkbenchPanel } from './workbench/WorkbenchPanel';");
    expect(appShell).toContain("import('../workbench/WorkbenchPanel')");
  });
});
