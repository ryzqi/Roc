import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { compileLatex, discoverLatexEntry } from '../../../../src/main/plugins/research/latex-service';

describe('latex service', () => {
  it('discovers the preferred LaTeX entry file in a template tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'roc-latex-template-'));
    mkdirSync(join(root, 'sections'));
    writeFileSync(join(root, 'sections', 'intro.tex'), 'intro');
    writeFileSync(join(root, 'main.tex'), '\\documentclass{article}');

    expect(discoverLatexEntry(root)).toBe('main.tex');
  });

  it('returns PDF output on a successful compiler run and parses failures', async () => {
    const root = mkdtempSync(join(tmpdir(), 'roc-latex-compile-'));
    const outputDir = join(root, 'build');
    mkdirSync(outputDir);
    writeFileSync(join(root, 'paper.tex'), '\\documentclass{article}');

    await expect(
      compileLatex({
        rootPath: root,
        entryPath: 'paper.tex',
        outputDir,
        runner: async () => {
          writeFileSync(join(outputDir, 'paper.pdf'), '%PDF');
          return { exitCode: 0, stdout: '', stderr: '' };
        }
      })
    ).resolves.toMatchObject({ status: 'ready', pdfPath: join(outputDir, 'paper.pdf'), errors: [] });

    await expect(
      compileLatex({
        rootPath: root,
        entryPath: 'paper.tex',
        outputDir,
        runner: async () => ({ exitCode: 1, stdout: '', stderr: '! Undefined control sequence' })
      })
    ).resolves.toMatchObject({ status: 'failed', errors: ['! Undefined control sequence'] });
  });
});

