import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { renderResearchPdf } from '../../../../src/main/plugins/research/pdf-render';
import { hashResearchFile } from '../../../../src/main/plugins/research/research-job';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<{ root: string; source: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'roc-pdf-render-')));
  roots.push(root);
  return { root, source: join(root, 'paper.pdf') };
}

function writePdf(path: string, width = 200, height = 100): void {
  const python = '/Users/Apple_501/Desktop/Roc/Roc/.runtime/research-toolchain/darwin-arm64/python/bin/python3';
  const result = spawnSync(python, ['-I', '-B', '-c',
    'import sys,pypdfium2 as pdfium\nwith pdfium.PdfDocument.new() as pdf:\n page=pdf.new_page(int(sys.argv[2]), int(sys.argv[3]))\n page.close()\n pdf.save(sys.argv[1])',
    path, String(width), String(height)], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || 'pdf_fixture_failed');
  }
}

describe('research pdf render', () => {
  it('rejects existing output, traversal and invalid options before writing', async () => {
    const { root, source } = await workspace();
    await writeFile(source, 'invalid pdf');
    const output = join(root, 'render');
    await writeFile(join(root, 'keep.txt'), 'keep');
    await expect(renderResearchPdf({ projectRoot: root, sourcePath: source, outputDir: output, page: 0, scale: 1 }))
      .rejects.toMatchObject({ message: expect.stringMatching(/render_options_invalid/) });
    await expect(renderResearchPdf({ projectRoot: root, sourcePath: source, outputDir: output, page: 1, scale: Number.NaN }))
      .rejects.toMatchObject({ message: expect.stringMatching(/render_options_invalid/) });
    const created = join(root, 'already');
    await (await import('node:fs/promises')).mkdir(created);
    await expect(renderResearchPdf({ projectRoot: root, sourcePath: source, outputDir: created, page: 1, scale: 1 }))
      .rejects.toMatchObject({ message: expect.stringMatching(/output_already_exists/) });
    expect(existsSync(output)).toBe(false);
  });

  it('renders a real page and rejects out-of-range pages without leftover output', async () => {
    const { root, source } = await workspace();
    writePdf(source, 200, 100);
    const result = await renderResearchPdf({ projectRoot: root, sourcePath: source, outputDir: join(root, 'render'), page: 1, scale: 2 });
    expect(result).toMatchObject({ page: 1, pageCount: 1, width: 400, height: 200 });
    expect(result.sourceHash).toBe(await hashResearchFile(source));
    expect((await readFile(result.path)).subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await expect(renderResearchPdf({ projectRoot: root, sourcePath: source, outputDir: join(root, 'invalid-page'), page: 2, scale: 1 }))
      .rejects.toMatchObject({ message: expect.stringMatching(/page_out_of_range/) });
    expect(existsSync(join(root, 'invalid-page'))).toBe(false);
  });
});
