import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { compileImportedLatexTemplate, importLatexTemplate } from '../../../../src/main/plugins/research/template-service';

describe('research template service', () => {
  it('imports a directory template and finds main.tex', () => {
    const source = mkdtempSync(join(tmpdir(), 'roc-template-source-'));
    const destination = mkdtempSync(join(tmpdir(), 'roc-template-destination-'));
    writeFileSync(join(source, 'main.tex'), '\\documentclass{article}');
    writeFileSync(join(source, 'references.bib'), '');

    expect(importLatexTemplate({ sourcePath: source, destinationRoot: join(destination, 'template') })).toMatchObject({ entryPath: 'main.tex' });
  });

  it('compiles into a stable .roc-build directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'roc-template-compile-'));
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'main.tex'), '\\documentclass{article}');
    const result = await compileImportedLatexTemplate({
      rootPath: root,
      entryPath: 'main.tex',
      runner: async (_command, args, cwd) => {
        const outdir = args[args.indexOf('--outdir') + 1];
        writeFileSync(join(outdir, 'main.pdf'), '%PDF');
        return { exitCode: 0, stdout: '', stderr: '' };
      }
    });
    expect(result).toMatchObject({ status: 'ready', pdfPath: join(root, '.roc-build', 'main.pdf') });
  });
});
