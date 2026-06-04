import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('workspace feature boundary', () => {
  it('routes workspace and workbench IPC through RocClient instead of window.roc', () => {
    expect(existsSync('src/renderer/features/workspace/index.tsx')).toBe(true);
    expect(readFileSync('src/renderer/features/workspace/index.tsx', 'utf8')).toContain('RocClient');
    for (const file of [
      'src/renderer/workbench/FilesWorkbench.tsx',
      'src/renderer/workbench/GitWorkbench.tsx',
      'src/renderer/workbench/TerminalWorkbench.tsx',
      'src/renderer/workbench/useGitDiffPreview.ts'
    ]) {
      expect(readFileSync(file, 'utf8')).not.toContain('window.roc');
    }
  });
});
