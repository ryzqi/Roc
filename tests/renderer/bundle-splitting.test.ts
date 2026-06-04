import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { rendererChunkRules, resolveRendererManualChunk } from '../../electron.vite.config';

describe('renderer bundle splitting', () => {
  it('keeps heavy renderer dependencies in named lazy chunks', () => {
    expect(resolveRendererManualChunk('F:/Code/Roc/node_modules/@xterm/xterm/lib/xterm.js')).toBe('renderer-terminal');
    expect(resolveRendererManualChunk('F:/Code/Roc/node_modules/@xterm/addon-fit/lib/addon-fit.js')).toBe('renderer-terminal');
    expect(
      resolveRendererManualChunk('F:/Code/Roc/node_modules/.pnpm/@xterm+xterm@6.0.0/node_modules/@xterm/xterm/lib/xterm.js')
    ).toBe('renderer-terminal');
    expect(resolveRendererManualChunk('F:/Code/Roc/node_modules/react-diff-view/esm/index.js')).toBe('renderer-diff');
    expect(resolveRendererManualChunk('F:/Code/Roc/node_modules/react-markdown/index.js')).toBe('renderer-markdown');
    expect(resolveRendererManualChunk('F:/Code/Roc/node_modules/rehype-highlight/index.js')).toBe('renderer-markdown');
    expect(resolveRendererManualChunk('F:/Code/Roc/src/renderer/App.tsx')).toBeUndefined();
  });

  it('keeps manual chunk rules aligned to installed package dependencies', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const installedPackages = new Set([...Object.keys(packageJson.dependencies), ...Object.keys(packageJson.devDependencies)]);
    const chunkPackages = rendererChunkRules.flatMap((rule) => [...rule.packages]);

    expect(chunkPackages).not.toContain('monaco-editor');
    for (const packageName of chunkPackages) {
      expect(installedPackages.has(packageName)).toBe(true);
    }
  });

  it('loads workbench tools and their css only when their tool chunk is rendered', () => {
    const appSource = readFileSync('src/renderer/App.tsx', 'utf8');
    const workbenchPanelSource = readFileSync('src/renderer/workbench/WorkbenchPanel.tsx', 'utf8');
    const terminalSource = readFileSync('src/renderer/workbench/TerminalWorkbench.tsx', 'utf8');
    const gitDiffSource = readFileSync('src/renderer/workbench/GitDiffPanel.tsx', 'utf8');

    expect(appSource).not.toContain("@xterm/xterm/css/xterm.css");
    expect(appSource).not.toContain("react-diff-view/style/index.css");
    expect(workbenchPanelSource).toContain("lazy(() => import('./GitWorkbench')");
    expect(workbenchPanelSource).toContain("lazy(() => import('./TerminalWorkbench')");
    expect(terminalSource).toContain("@xterm/xterm/css/xterm.css");
    expect(gitDiffSource).toContain("react-diff-view/style/index.css");
  });
});
