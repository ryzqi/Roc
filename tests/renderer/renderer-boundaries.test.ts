import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

function listSourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const fullPath = join(directory, entry);
    if (statSync(fullPath).isDirectory()) {
      return listSourceFiles(fullPath);
    }
    if (!/\.(?:ts|tsx)$/.test(entry)) {
      return [];
    }
    return [fullPath];
  });
}

function toPosixPath(file: string): string {
  return file.split(sep).join('/');
}

describe('renderer boundaries', () => {
  it('keeps App.tsx as a shell entry under 180 lines', () => {
    const app = readFileSync('src/renderer/App.tsx', 'utf8');

    expect(app.split(/\r?\n/).length).toBeLessThan(180);
  });

  it('centralizes window.roc access in the shared RocClient module', () => {
    const rendererFiles = listSourceFiles('src/renderer')
      .map((file) => toPosixPath(relative(process.cwd(), file)))
      .filter((file) => file !== 'src/renderer/shared/roc-client.ts');

    for (const file of rendererFiles) {
      expect(readFileSync(file, 'utf8'), file).not.toContain('window.roc');
    }
    expect(readFileSync('src/renderer/shared/roc-client.ts', 'utf8')).toContain('window.roc');
  });

  it('does not import Observable plumbing into renderer features', () => {
    const rendererSource = [
      'src/renderer/App.tsx',
      'src/renderer/app/AppShell.tsx',
      'src/renderer/views/ViewContent.tsx'
    ].map((file) => readFileSync(file, 'utf8')).join('\n');

    expect(rendererSource).not.toContain('../../core/Observable');
    expect(rendererSource).not.toContain('../../hooks/useObservable');
  });
});
