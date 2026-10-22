import { XMLParser } from 'fast-xml-parser';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { getDocument, type PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { ResearchFigureOptions } from '../../../shared/schemas/research-plotting';
import { pdfjsAssetDirectory } from './pdfjs-assets';
import { experimentFileLimit } from './experiment-files';
import { readResearchFile, researchContentHash } from './research-files';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const RESOURCE_ATTRIBUTES = new Set(['style', 'fill', 'stroke', 'filter', 'clip-path', 'mask', 'marker', 'marker-start', 'marker-mid', 'marker-end', 'cursor']);
const svgParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  removeNSPrefix: true,
  preserveOrder: true,
  allowBooleanAttributes: true
});

export type FigureOutputCheck = {
  widthPixels: number;
  heightPixels: number;
  widthPoints: number;
  heightPoints: number;
  pageCount: 1;
  files: Array<{ path: 'figure.png' | 'figure.svg' | 'figure.pdf'; sha256: string; size: number }>;
};

function fail(code: string): never {
  throw new Error(code);
}

function close(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= 0.01;
}

function localName(value: string): string {
  const colon = value.lastIndexOf(':');
  return (colon === -1 ? value : value.slice(colon + 1)).toLowerCase();
}

function walkSvg(nodes: unknown[], styles: string[]): void {
  for (const node of nodes) {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) continue;
    const record = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      if (key === ':@' || key === '#text') continue;
      const tag = localName(key);
      if (tag === 'script' || tag === 'foreignobject') fail('research_figure_svg_active_content');
      const attributes = (record[':@'] ?? {}) as Record<string, unknown>;
      for (const [attribute, raw] of Object.entries(attributes)) {
        const name = localName(attribute);
        const text = String(raw);
        if (name.startsWith('on')) fail('research_figure_svg_active_content');
        if ((name === 'href' || name === 'xlink:href') && !text.startsWith('#') && !text.startsWith('data:image/png;base64,')) {
          fail('research_figure_svg_external_resource');
        }
        if (RESOURCE_ATTRIBUTES.has(name)) styles.push(text);
      }
      if (tag === 'style' && typeof value === 'object' && value !== null) {
        const textNode = (value as Array<Record<string, unknown>>).find((item) => '#text' in item);
        if (textNode !== undefined) styles.push(String(textNode['#text'] ?? ''));
      }
      if (Array.isArray(value)) walkSvg(value, styles);
    }
  }
}

function assertSvgResources(styles: string[]): void {
  const pattern = /url\(\s*([^)]*?)\s*\)/giu;
  for (const content of styles) {
    if (content.toLowerCase().includes('@import')) fail('research_figure_svg_external_resource');
    for (const match of content.matchAll(pattern)) {
      const target = match[1].trim().replace(/^['"]|['"]$/gu, '');
      if (!target.startsWith('#')) fail('research_figure_svg_external_resource');
    }
  }
}

async function inspectPng(bytes: Buffer, options: ResearchFigureOptions): Promise<{ width: number; height: number }> {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.subarray(12, 16).toString('latin1') !== 'IHDR') {
    fail('research_figure_png_dimensions_invalid');
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width !== Math.trunc(options.widthInches * options.dpi) || height !== Math.trunc(options.heightInches * options.dpi)) {
    fail('research_figure_png_dimensions_invalid');
  }
  const image = await loadImage(bytes);
  if (image.width !== width || image.height !== height) fail('research_figure_png_dimensions_invalid');
  return { width, height };
}

function inspectSvg(bytes: Buffer, options: ResearchFigureOptions): void {
  if (bytes.toString('latin1').toUpperCase().includes('<!ENTITY')) fail('research_figure_svg_entity_invalid');
  let parsed: unknown;
  try { parsed = svgParser.parse(bytes.toString('utf8')); }
  catch { fail('research_figure_svg_invalid'); }
  if (!Array.isArray(parsed)) fail('research_figure_svg_invalid');
  const root = parsed.find((node) => typeof node === 'object' && node !== null && 'svg' in node) as { svg: unknown[]; ':@'?: Record<string, unknown> } | undefined;
  if (root === undefined || !Array.isArray(root.svg)) fail('research_figure_svg_invalid');
  const viewBox = String(root[':@']?.viewBox ?? '');
  const box = viewBox.split(/\s+/u).map(Number);
  const expected = [0, 0, options.widthInches * 72, options.heightInches * 72];
  if (box.length !== 4 || box.some((value, index) => !Number.isFinite(value) || !close(value, expected[index]))) {
    fail('research_figure_svg_dimensions_invalid');
  }
  const styles: string[] = [];
  walkSvg([root], styles);
  assertSvgResources(styles);
}

async function inspectPdf(bytes: Buffer, options: ResearchFigureOptions): Promise<{ widthPoints: number; heightPoints: number }> {
  const loadingTask = getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    useSystemFonts: true,
    useWorkerFetch: false,
    cMapUrl: pdfjsAssetDirectory('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: pdfjsAssetDirectory('standard_fonts'),
    wasmUrl: pdfjsAssetDirectory('wasm')
  });
  const pdf = await loadingTask.promise;
  try {
    if (pdf.numPages !== 1) fail('research_figure_pdf_page_count_invalid');
    const page: PDFPageProxy = await pdf.getPage(1);
    try {
      const viewport = page.getViewport({ scale: 1 });
      if (!close(viewport.width, options.widthInches * 72) || !close(viewport.height, options.heightInches * 72)) {
        fail('research_figure_pdf_dimensions_invalid');
      }
      const canvas = createCanvas(Math.max(1, Math.round(viewport.width)), Math.max(1, Math.round(viewport.height)));
      await page.render({ canvasContext: canvas.getContext('2d'), viewport, canvas } as never).promise;
      if (canvas.width < 1 || canvas.height < 1) fail('research_figure_pdf_render_invalid');
      return { widthPoints: viewport.width, heightPoints: viewport.height };
    } finally {
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
}


async function readFigureFile(output: string, name: 'figure.png' | 'figure.svg' | 'figure.pdf'): Promise<Buffer> {
  try {
    return await readResearchFile(output, name, experimentFileLimit);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || (error instanceof Error && error.message.startsWith('research_'))) fail('research_figure_file_invalid');
    throw error;
  }
}

export async function inspectFigureOutput(
  output: string,
  options: ResearchFigureOptions,
  signal: AbortSignal
): Promise<FigureOutputCheck> {
  const files: FigureOutputCheck['files'] = [];
  const contents: Record<'figure.png' | 'figure.svg' | 'figure.pdf', Buffer> = {
    'figure.png': Buffer.alloc(0),
    'figure.svg': Buffer.alloc(0),
    'figure.pdf': Buffer.alloc(0)
  };
  for (const name of ['figure.png', 'figure.svg', 'figure.pdf'] as const) {
    signal.throwIfAborted();
    const bytes = await readFigureFile(output, name);
    contents[name] = bytes;
    files.push({ path: name, sha256: researchContentHash(bytes), size: bytes.length });
  }
  const png = await inspectPng(contents['figure.png'], options);
  inspectSvg(contents['figure.svg'], options);
  const pdf = await inspectPdf(contents['figure.pdf'], options);
  return {
    widthPixels: png.width,
    heightPixels: png.height,
    widthPoints: pdf.widthPoints,
    heightPoints: pdf.heightPoints,
    pageCount: 1,
    files
  };
}
