import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createCanvas } from '@napi-rs/canvas';
import { getDocument, OPS, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { pdfjsAssetDirectory } from './pdfjs-assets';
import { researchJobError, runResearchJob, type ResearchJobPaths } from './research-job';
import {researchPdfCoordinateFrameSchema, type ResearchPdfCoordinateFrame} from '../../../shared/schemas/research-document-coordinates';
import {captureNativeTextItems, nativeItemsText, type NativeTextItem} from './pdf-native-text';

const MAX_PAGE_PIXELS = 25_000_000;
const MAX_SOURCE = 512 * 1024 * 1024;
const DEFAULT_PARSE_SCALE = 1.5;
const SAFE_TEXT_PAGE_OPERATIONS = new Set([
  OPS.dependency,
  OPS.setLineWidth,
  OPS.setLineCap,
  OPS.setLineJoin,
  OPS.setMiterLimit,
  OPS.setDash,
  OPS.setRenderingIntent,
  OPS.setFlatness,
  OPS.setGState,
  OPS.save,
  OPS.restore,
  OPS.transform,
  OPS.beginText,
  OPS.endText,
  OPS.setCharSpacing,
  OPS.setWordSpacing,
  OPS.setHScale,
  OPS.setLeading,
  OPS.setFont,
  OPS.setTextRenderingMode,
  OPS.setTextRise,
  OPS.moveText,
  OPS.setLeadingMoveText,
  OPS.setTextMatrix,
  OPS.nextLine,
  OPS.showText,
  OPS.showSpacedText,
  OPS.nextLineShowText,
  OPS.nextLineSetSpacingShowText,
  OPS.setCharWidth,
  OPS.setCharWidthAndBounds,
  OPS.setStrokeColorSpace,
  OPS.setFillColorSpace,
  OPS.setStrokeColor,
  OPS.setStrokeColorN,
  OPS.setFillColor,
  OPS.setFillColorN,
  OPS.setStrokeGray,
  OPS.setFillGray,
  OPS.setStrokeRGBColor,
  OPS.setFillRGBColor,
  OPS.setStrokeCMYKColor,
  OPS.setFillCMYKColor,
  OPS.markPoint,
  OPS.markPointProps,
  OPS.beginMarkedContent,
  OPS.beginMarkedContentProps,
  OPS.endMarkedContent,
  OPS.beginCompat,
  OPS.endCompat,
  OPS.setStrokeTransparent,
  OPS.setFillTransparent
]);

export type ResearchPdfPageImage = {
  /** Null only for an explicitly requested RGBA-only render. */
  path: string | null;
  page: number;
  pageCount: number;
  width: number;
  height: number;
  coordinateFrame: ResearchPdfCoordinateFrame;
  text: string;
  pngBytes: number;
  image: { width: number; height: number; data: Uint8Array } | null;
};

export type ResearchPdfPageLayout = Pick<ResearchPdfPageImage, 'page' | 'pageCount' | 'width' | 'height' | 'text' | 'coordinateFrame'>;
export type ResearchPdfPageLayoutOptions = {
  page: PDFPageProxy;
  pageNumber: number;
  pageCount: number;
  text: string;
  scale?: number;
  clampToPixelLimit?: boolean;
  onStage?: ResearchPdfStageObserver;
};

export type ResearchPdfStage = 'native-text' | 'visual-inspection' | 'page-layout' | 'page-render' | 'page-png-encode' | 'ocr-raster' |
  'page-write' | 'model-validation' | 'model-initialization' | 'ocr-inference' | 'region-write' | 'parse-artifact-write';
export type ResearchPdfStageObserver = (event: { stage: ResearchPdfStage; page: number | null; durationMs: number }) => void;

export type ResearchPdfPageRenderOptions = {
  /** Published document parses require this artifact; default true. */
  needPngArtifact?: boolean;
  includeRgbaImage?: boolean;
  text?: string;
  onStage?: ResearchPdfStageObserver;
};

export function measureResearchPdfPage(options: ResearchPdfPageLayoutOptions): ResearchPdfPageLayout {
  const { page, pageNumber, pageCount, text, scale = DEFAULT_PARSE_SCALE, clampToPixelLimit = false, onStage } = options;
  const startedAt = performance.now();
  try {
    const { width, height, coordinateFrame } = boundedPageViewport(page, pageNumber, scale, clampToPixelLimit);
    return { page: pageNumber, pageCount, width, height, text, coordinateFrame };
  } finally {
    onStage?.({ stage: 'page-layout', page: pageNumber, durationMs: performance.now() - startedAt });
  }
}

export async function withResearchPdf<T>(input: Uint8Array | URL, operation: (pdf: PDFDocumentProxy) => Promise<T>): Promise<T> {
  const loadingTask = getDocument({
    ...(input instanceof URL ? {url: input, disableStream: true, disableAutoFetch: true}
      : {data: Buffer.isBuffer(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : input}),
    disableFontFace: true,
    useSystemFonts: true,
    useWorkerFetch: false,
    cMapUrl: pdfjsAssetDirectory('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: pdfjsAssetDirectory('standard_fonts'),
    wasmUrl: pdfjsAssetDirectory('wasm')
  });
  try {
    const pdf = await loadingTask.promise;
    return await operation(pdf);
  } finally {
    await loadingTask.destroy();
  }
}

/** Unknown/non-text operators or a failed inspection conservatively keep the source page image. */
export async function researchPdfPageHasVisualContent(page: PDFPageProxy): Promise<boolean> {
  try {
    const operatorList = await page.getOperatorList();
    return operatorList.fnArray.some((operation) => !SAFE_TEXT_PAGE_OPERATIONS.has(operation));
  } catch {
    return true;
  }
}

export async function extractResearchPdfPageText(
  page: PDFPageProxy,
  pageNumber?: number,
  onStage?: ResearchPdfStageObserver
): Promise<string> {
  return (await extractResearchPdfPageNativeText(page, pageNumber ?? page.pageNumber, onStage)).text;
}

export async function extractResearchPdfPageNativeText(
  page: PDFPageProxy,
  pageNumber: number,
  onStage?: ResearchPdfStageObserver
): Promise<{text: string; items: NativeTextItem[]}> {
  const startedAt = performance.now();
  try {
    const textContent = await page.getTextContent();
    const items = captureNativeTextItems(textContent, pageNumber);
    return {text: nativeItemsText(items), items};
  } finally {
    onStage?.({ stage: 'native-text', page: pageNumber ?? null, durationMs: performance.now() - startedAt });
  }
}

/** Render and extract text from one page using the shared bounded PDF.js/canvas path. */
export async function renderResearchPdfPage(
  page: PDFPageProxy,
  pageNumber: number,
  pageCount: number,
  outputDir: string,
  scale: number = DEFAULT_PARSE_SCALE,
  clampToPixelLimit = false,
  maximumPngBytes?: number,
  options: ResearchPdfPageRenderOptions = {}
): Promise<ResearchPdfPageImage> {
  const text = options.text ?? await extractResearchPdfPageText(page, pageNumber, options.onStage);
  const { viewport, width, height, coordinateFrame } = boundedPageViewport(page, pageNumber, scale, clampToPixelLimit);
  const canvas = createCanvas(width, height);
  try {
    let startedAt = performance.now();
    await page.render({ canvasContext: canvas.getContext('2d'), viewport, canvas } as never).promise;
    options.onStage?.({ stage: 'page-render', page: pageNumber, durationMs: performance.now() - startedAt });
    let target: string | null = null;
    let pngBytes = 0;
    if (options.needPngArtifact !== false) {
      startedAt = performance.now();
      let png: Buffer | undefined = await canvas.encode('png');
      options.onStage?.({ stage: 'page-png-encode', page: pageNumber, durationMs: performance.now() - startedAt });
      if (maximumPngBytes !== undefined && png.byteLength > maximumPngBytes) researchJobError('research_document_asset_too_large');
      pngBytes = png.byteLength;
      target = join(outputDir, `page-${pageNumber}.png`);
      startedAt = performance.now();
      await mkdir(outputDir, { recursive: true, mode: 0o700 });
      const handle = await open(target, 'wx', 0o600);
      try {
        await handle.writeFile(png);
      } finally {
        await handle.close();
      }
      options.onStage?.({ stage: 'page-write', page: pageNumber, durationMs: performance.now() - startedAt });
      png = undefined;
    }
    let image: ResearchPdfPageImage['image'] = null;
    if (options.includeRgbaImage !== false) {
      startedAt = performance.now();
      const imageData = canvas.getContext('2d').getImageData(0, 0, width, height).data;
      image = { width, height, data: new Uint8Array(imageData.buffer, imageData.byteOffset, imageData.byteLength) };
      options.onStage?.({ stage: 'ocr-raster', page: pageNumber, durationMs: performance.now() - startedAt });
    }
    return { path: target, page: pageNumber, pageCount, width, height, coordinateFrame, text, pngBytes, image };
  } finally {
    // Rendering/encoding has settled before clearing the backing dimensions.
    // Allocator RSS/footprint reclamation is measured separately.
    canvas.width = 0;
    canvas.height = 0;
  }
}

function boundedPageViewport(page: PDFPageProxy, pageNumber: number, scale: number, clampToPixelLimit: boolean) {
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
  const coordinateFrame = researchPdfCoordinateFrameSchema.parse({
    kind: 'pdf', page: pageNumber, unit: 'raster-pixel', coordinateOrigin: 'TOPLEFT', width, height,
    viewport: {width: viewport.width, height: viewport.height, scale: viewport.scale, rotation: viewport.rotation,
      userUnit: page.userUnit, viewBox: viewport.viewBox, transform: viewport.transform}
  });
  return { viewport, width, height, coordinateFrame };
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
      const rendered = await renderResearchPdfPage(page, pageNumber, pdf.numPages, job.output, scale, false, undefined, {
        includeRgbaImage: false
      });
      if (rendered.path === null) researchJobError('research_pdf_render_artifact_missing');
      return { path: rendered.path, page: rendered.page, pageCount: rendered.pageCount, width: rendered.width, height: rendered.height, text: rendered.text };
    } finally {
      page.cleanup();
    }
  });
}
