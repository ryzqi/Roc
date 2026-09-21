import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createCanvas } from '@napi-rs/canvas';
import { getDocument, type PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { researchJobError, runResearchJob, type ResearchJobPaths } from './research-job';

const MAX_PAGE_PIXELS = 25_000_000;
const MAX_SOURCE = 512 * 1024 * 1024;
const pdfRequire = createRequire(import.meta.url);
const pdfjsRoot = dirname(pdfRequire.resolve('pdfjs-dist/package.json'));
const assetUrl = (directory: string): string => `${pathToFileURL(join(pdfjsRoot, directory)).href}/`;

export async function renderResearchPdf(input: {
  projectRoot: string;
  sourcePath: string;
  outputDir: string;
  page: number;
  scale: number;
  signal?: AbortSignal;
}): Promise<{ path: string; page: number; pageCount: number; width: number; height: number; text: string; sourceHash: string }> {
  if (!Number.isInteger(input.page) || input.page < 1 || !Number.isFinite(input.scale) || input.scale < 0.5 || input.scale > 4) {
    researchJobError('research_pdf_render_options_invalid');
  }
  return await runResearchJob(
    { ...input, maxSourceBytes: MAX_SOURCE, sourceExtensions: ['.pdf'], sourceExtensionError: 'research_pdf_source_required', timeoutMs: 60_000 },
    async (job) => await renderPage(job, input.page, input.scale)
  );
}

async function renderPage(job: ResearchJobPaths, pageNumber: number, scale: number): Promise<{
  path: string; page: number; pageCount: number; width: number; height: number; text: string;
}> {
  const bytes = await readFile(job.source);
  const loadingTask = getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    useSystemFonts: true,
    useWorkerFetch: false,
    cMapUrl: assetUrl('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: assetUrl('standard_fonts'),
    wasmUrl: assetUrl('wasm')
  });
  const pdf = await loadingTask.promise;
  try {
    if (pageNumber > pdf.numPages) {
      researchJobError('research_pdf_page_out_of_range');
    }
    const page: PDFPageProxy = await pdf.getPage(pageNumber);
    try {
      const viewport = page.getViewport({ scale });
      const width = Math.round(viewport.width);
      const height = Math.round(viewport.height);
      const pixels = viewport.width * viewport.height;
      if (!Number.isFinite(pixels) || pixels <= 0 || pixels > MAX_PAGE_PIXELS) {
        researchJobError('research_pdf_page_too_large');
      }
      const canvas = createCanvas(width, height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport, canvas } as never).promise;
      const png = await canvas.encode('png');
      const target = join(job.output, `page-${pageNumber}.png`);
      await mkdir(job.output, { recursive: true });
      const handle = await open(target, 'wx', 0o600);
      try {
        await handle.writeFile(png);
      } finally {
        await handle.close();
      }
      const textContent = await page.getTextContent();
      const text = textContent.items.map((item) => 'str' in item ? String(item.str) : '').join('').replaceAll('\r\n', '\n');
      return { path: target, page: pageNumber, pageCount: pdf.numPages, width, height, text };
    } finally {
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
}
