import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { getDocument, OPS, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { pdfjsAssetDirectory } from './pdfjs-assets';
import { researchJobError, runResearchJob, type ResearchJobPaths } from './research-job';

const MAX_PAGE_PIXELS = 25_000_000;
const MAX_SOURCE = 512 * 1024 * 1024;
const DEFAULT_PARSE_SCALE = 1.5;
const NON_TEXT_VISUAL_OPERATIONS = new Set([
  OPS.constructPath,
  OPS.stroke,
  OPS.closeStroke,
  OPS.fill,
  OPS.eoFill,
  OPS.fillStroke,
  OPS.eoFillStroke,
  OPS.closeFillStroke,
  OPS.closeEOFillStroke,
  OPS.rawFillPath,
  OPS.shadingFill,
  OPS.paintImageMaskXObject,
  OPS.paintImageMaskXObjectGroup,
  OPS.paintImageXObject,
  OPS.paintInlineImageXObject,
  OPS.paintInlineImageXObjectGroup,
  OPS.paintImageXObjectRepeat,
  OPS.paintSolidColorImageMask
]);

export type ResearchPdfPageImage = {
  path: string;
  page: number;
  pageCount: number;
  width: number;
  height: number;
  text: string;
  pngBytes: number;
  image: { width: number; height: number; data: Uint8Array };
};

export async function withResearchPdf<T>(bytes: Uint8Array, operation: (pdf: PDFDocumentProxy) => Promise<T>): Promise<T> {
  const loadingTask = getDocument({
    data: Buffer.isBuffer(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes,
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
    return await operation(pdf);
  } finally {
    await loadingTask.destroy();
  }
}

/** True when a page paints image or vector content beyond selectable PDF text. */
export async function researchPdfPageHasVisualContent(page: PDFPageProxy): Promise<boolean> {
  const operatorList = await page.getOperatorList();
  return operatorList.fnArray.some((operation) => NON_TEXT_VISUAL_OPERATIONS.has(operation));
}

/** Render and extract text from one page using the shared bounded PDF.js/canvas path. */
export async function renderResearchPdfPage(
  page: PDFPageProxy,
  pageNumber: number,
  pageCount: number,
  outputDir: string,
  scale: number = DEFAULT_PARSE_SCALE,
  clampToPixelLimit = false,
  maximumPngBytes?: number
): Promise<ResearchPdfPageImage> {
  let viewport = page.getViewport({ scale });
  let pixels = viewport.width * viewport.height;
  if (clampToPixelLimit && pixels > MAX_PAGE_PIXELS) {
    const clampedScale = scale * Math.sqrt(MAX_PAGE_PIXELS / pixels);
    viewport = page.getViewport({ scale: clampedScale });
    pixels = viewport.width * viewport.height;
  }
  const width = Math.round(viewport.width);
  const height = Math.round(viewport.height);
  if (!Number.isFinite(pixels) || pixels <= 0 || pixels > MAX_PAGE_PIXELS || width <= 0 || height <= 0) {
    researchJobError('research_pdf_page_too_large');
  }
  const canvas = createCanvas(width, height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport, canvas } as never).promise;
  const png = await canvas.encode('png');
  if (maximumPngBytes !== undefined && png.byteLength > maximumPngBytes) researchJobError('research_document_asset_too_large');
  const target = join(outputDir, `page-${pageNumber}.png`);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const handle = await open(target, 'wx', 0o600);
  try {
    await handle.writeFile(png);
  } finally {
    await handle.close();
  }
  const context = canvas.getContext('2d');
  const imageData = context.getImageData(0, 0, width, height).data;
  const textContent = await page.getTextContent();
  const text = textContent.items.map((item) => {
    if (!('str' in item)) return '';
    return `${String(item.str)}${'hasEOL' in item && item.hasEOL ? '\n' : ' '}`;
  }).join('').replace(/[ \t]+\n/gu, '\n').trim();
  return {
    path: target,
    page: pageNumber,
    pageCount,
    width,
    height,
    text,
    pngBytes: png.byteLength,
    image: { width, height, data: new Uint8Array(imageData.buffer, imageData.byteOffset, imageData.byteLength) }
  };
}

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
  return await withResearchPdf(bytes, async (pdf) => {
    if (pageNumber > pdf.numPages) researchJobError('research_pdf_page_out_of_range');
    const page: PDFPageProxy = await pdf.getPage(pageNumber);
    try {
      const rendered = await renderResearchPdfPage(page, pageNumber, pdf.numPages, job.output, scale);
      return { path: rendered.path, page: rendered.page, pageCount: rendered.pageCount, width: rendered.width, height: rendered.height, text: rendered.text };
    } finally {
      page.cleanup();
    }
  });
}
