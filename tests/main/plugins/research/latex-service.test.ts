import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compileLatex, discoverLatexEntry, parseLatexDiagnostics } from '../../../../src/main/plugins/research/latex-service';

const roots: string[] = [];
async function fixture(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'roc-latex-')));
  roots.push(root);
  await writeFile(join(root, 'paper.tex'), '\\documentclass{article}');
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('latex compilation', () => {
  it('finds a document entry instead of a section or a commented declaration', async () => {
    const root = await fixture();
    await mkdir(join(root, 'sections'));
    await writeFile(join(root, 'main.tex'), '% \\documentclass{article}\nOnly a section.');
    await writeFile(join(root, 'sections/intro.tex'), 'A section.');
    await expect(discoverLatexEntry(root)).resolves.toBe('paper.tex');
  });

  it('returns a new PDF and refuses reuse of an existing output directory', async () => {
    const root = await fixture();
    const outputDir = join(root, 'build');
    const runner = vi.fn(async () => {
      await writeFile(join(outputDir, 'paper.pdf'), '%PDF-1.7\nnew PDF');
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    await expect(compileLatex({ rootPath: root, entryPath: 'paper.tex', outputDir, jobDir: root, runner }))
      .resolves.toMatchObject({ status: 'ready', pdfPath: join(outputDir, 'paper.pdf'), pdfHash: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    await expect(compileLatex({ rootPath: root, entryPath: 'paper.tex', outputDir, jobDir: root, runner }))
      .rejects.toThrow('research_compile_output_exists');
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('does not report stale or missing PDFs as a successful compile', async () => {
    const root = await fixture();
    await writeFile(join(root, 'paper.pdf'), '%PDF-1.7\nold PDF');
    await expect(compileLatex({ rootPath: root, entryPath: 'paper.tex', outputDir: join(root, 'failed'), jobDir: root,
      runner: async () => ({ exitCode: 1, stdout: '', stderr: 'error: paper.tex:7: Undefined control sequence' }) }))
      .resolves.toMatchObject({ status: 'failed', pdfPath: null, pdfHash: null,
        diagnostics: [{ severity: 'error', file: 'paper.tex', line: 7, message: 'Undefined control sequence' }] });
    await expect(compileLatex({ rootPath: root, entryPath: 'paper.tex', outputDir: join(root, 'missing'), jobDir: root,
      runner: async () => ({ exitCode: 0, stdout: '', stderr: '' }) }))
      .resolves.toMatchObject({ status: 'failed', pdfPath: null, errors: ['编译未生成 PDF。'] });
  });

  it('rejects a symlinked entry and an output outside the job', async () => {
    const root = await fixture();
    const other = await fixture();
    const runner = vi.fn();
    await symlink(join(other, 'paper.tex'), join(root, 'escape.tex'));
    await expect(compileLatex({ rootPath: root, entryPath: 'escape.tex', outputDir: join(root, 'build'), jobDir: root, runner }))
      .rejects.toThrow('research_path_symlink');
    await expect(compileLatex({ rootPath: root, entryPath: 'paper.tex', outputDir: join(other, 'build'), jobDir: root, runner }))
      .rejects.toThrow('research_path_outside_project');
    expect(runner).not.toHaveBeenCalled();
  });

  it('keeps diagnostic locations within the template', () => {
    expect(parseLatexDiagnostics('error: ../private.tex:3: bad\n! Another error\nl.9 command', '/project'))
      .toEqual([{ severity: 'error', file: null, line: 3, message: 'bad' },
        { severity: 'error', file: null, line: 9, message: '! Another error' }]);
  });
});
