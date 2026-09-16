import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { inspectFigureOutput } from '../../../../src/main/plugins/research/figure-validation';
import { figureRenderer, validateFigureOutput } from '../../../../src/main/plugins/research/figure-runner';
import { researchContentHash } from '../../../../src/main/plugins/research/research-files';
import { researchFigureValidationSchema } from '../../../../src/shared/schemas/research-plotting';

const options = { widthInches: 4, heightInches: 3, dpi: 150, seed: 42 };
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function outputDir(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'roc-figure-validation-')));
  roots.push(root);
  const output = join(root, 'output');
  await mkdir(output);
  return output;
}

async function pngBytes(width: number, height: number): Promise<Buffer> {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ff0000';
  context.fillRect(0, 0, width, height);
  return await canvas.encode('png');
}

function svgMarkup(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 288 216"><g fill="url(#box)"><rect id="box" width="288" height="216"/></g></svg>`;
}

function pdfBytes(): Buffer {
  const body = [
    '%PDF-1.4',
    '1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj',
    '2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj',
    '3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 288 216] /Contents 4 0 R >>endobj',
    '4 0 obj<< /Length 0 >>stream',
    'endstream',
    'endobj',
    'xref',
    '0 5',
    '0000000000 65535 f ',
    '0000000009 00000 n ',
    '0000000058 00000 n ',
    '0000000115 00000 n ',
    '0000000194 00000 n ',
    'trailer<< /Size 5 /Root 1 0 R >>',
    'startxref',
    '243',
    '%%EOF',
    ''
  ].join('\n');
  return Buffer.from(body, 'latin1');
}

async function writeValid(output: string): Promise<void> {
  await writeFile(join(output, 'figure.png'), await pngBytes(600, 450));
  await writeFile(join(output, 'figure.svg'), svgMarkup());
  await writeFile(join(output, 'figure.pdf'), pdfBytes());
}

describe('research figure validation', () => {
  it('accepts matching png svg pdf dimensions and writes a frozen report', async () => {
    const output = await outputDir();
    await writeValid(output);
    const signal = new AbortController().signal;
    await validateFigureOutput(output, options, signal);
    const report = researchFigureValidationSchema.parse(JSON.parse(await readFile(join(output, 'figure-validation.json'), 'utf8')));
    expect(report).toMatchObject({ options, widthPixels: 600, heightPixels: 450, pageCount: 1 });
    expect(report.rendererHash).toBe(researchContentHash(figureRenderer));
    expect(report.files.map((file) => file.path).sort()).toEqual(['figure.pdf', 'figure.png', 'figure.svg']);
  });

  it('rejects svg hyperlinks to external resources', async () => {
    const output = await outputDir();
    await writeFile(join(output, 'figure.png'), await pngBytes(600, 450));
    await writeFile(join(output, 'figure.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 288 216"><a href="https://example.invalid/remote-resource"><rect width="10" height="10"/></a></svg>`);
    await writeFile(join(output, 'figure.pdf'), pdfBytes());
    await expect(inspectFigureOutput(output, options, new AbortController().signal))
      .rejects.toMatchObject({ message: 'research_figure_svg_external_resource' });
  });

  it('allows ordinary svg text and embedded png data urls', async () => {
    const output = await outputDir();
    const png = await pngBytes(600, 450);
    await writeFile(join(output, 'figure.png'), png);
    await writeFile(join(output, 'figure.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 288 216"><title>Frequency of url(...) tokens</title><image href="data:image/png;base64,${png.toString('base64')}"/></svg>`);
    await writeFile(join(output, 'figure.pdf'), pdfBytes());
    await expect(inspectFigureOutput(output, options, new AbortController().signal)).resolves.toMatchObject({ widthPixels: 600, heightPixels: 450 });
  });

  it('rejects missing outputs as invalid figure files', async () => {
    const output = await outputDir();
    await expect(inspectFigureOutput(output, options, new AbortController().signal))
      .rejects.toMatchObject({ message: 'research_figure_file_invalid' });
  });
});
