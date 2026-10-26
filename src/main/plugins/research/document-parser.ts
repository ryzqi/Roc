import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { parseDocument } from 'htmlparser2';
import * as UTIF from 'utif';
import * as ort from 'onnxruntime-node';
import {
  createFormulaTokenizerVocabulary,
  PaddleStructureService,
  type OrtModule,
  type PaddleStructureRunOptions
} from 'paddleocr';
import { researchDocumentLimits, researchParseOptionsSchema, researchParsedDocumentSchema, researchParserVersion, type ResearchParseOptions } from '../../../shared/schemas/research-production';
import type { z } from 'zod';
import { ResearchProcessError } from './process-runner';
import { runResearchJob, researchJobError, type ResearchJobPaths } from './research-job';
import { renderResearchPdfPage, withResearchPdf } from './pdf-render';
import { researchModelLock, getModelAsset, modelPackManifest } from './model-catalog';
import type { ResearchModelFiles } from './model-store';

const MAX_SOURCE_BYTES = 512 * 1024 * 1024;
const MAX_HTML_BYTES = 64 * 1024 * 1024;
const MAX_PAGE_PIXELS = 25_000_000;
const MAX_SELECTED_PAGES = 500;
const PARSER_VERSION = researchParserVersion;
const SUPPORTED_EXTENSIONS = ['.pdf', '.html', '.htm', '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp'] as const;

type Raster = { width: number; height: number; data: Uint8Array };
type ParseDocument = z.infer<typeof researchParsedDocumentSchema>;
type ParseBlock = ParseDocument['blocks'][number];
type ParseAsset = ParseDocument['assets'][number];
type ParseResult = {
  contractVersion: 3;
  engine: 'paddleocr.js';
  engineVersion: string;
  parserVersion: string;
  parserFingerprint: string;
  modelManifest: string;
  runtime: Record<string, string>;
  tier: ResearchParseOptions['tier'];
  parseMode: 'ocr' | 'native-text' | 'mixed' | 'html';
  device: 'coreml' | 'cpu';
  pageCount: number;
  content: string;
  blocks: ParseBlock[];
  assets: ParseAsset[];
  artifacts: { middleJson: string; markdown: string; structuredContent: string };
  warnings: string[];
};

type ParserInput = {
  projectRoot: string;
  sourcePath: string;
  outputDir: string;
  options: ResearchParseOptions;
  modelFiles: ResearchModelFiles | null;
  modelManifest: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export async function parseResearchDocument(input: ParserInput): Promise<ParseDocument> {
  const options = researchParseOptionsSchema.parse(input.options);
  const extension = extname(input.sourcePath).toLowerCase();
  if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(extension)) {
    researchJobError('research_document_format_unsupported');
  }
  if (input.modelFiles !== null && input.modelManifest !== modelPackManifest(options.tier)) {
    researchJobError('research_model_manifest_mismatch');
  }
  const maxSourceBytes = extension === '.html' || extension === '.htm' ? MAX_HTML_BYTES : MAX_SOURCE_BYTES;
  const result = await runResearchJob({
    projectRoot: input.projectRoot,
    sourcePath: input.sourcePath,
    outputDir: input.outputDir,
    maxSourceBytes,
    sourceExtensions: SUPPORTED_EXTENSIONS,
    timeoutMs: input.timeoutMs ?? 600_000,
    signal: input.signal
  }, async (job) => {
    throwIfAborted(input.signal);
    if (extension === '.pdf') return await parsePdf(job, input, options);
    if (extension === '.html' || extension === '.htm') return await parseHtml(job, options);
    return await parseImage(job, input, options);
  });
  return researchParsedDocumentSchema.parse(result);
}

async function parsePdf(job: ResearchJobPaths, input: ParserInput, options: ResearchParseOptions): Promise<ParseResult> {
  const bytes = await readFile(job.source);
  return await withResearchPdf(bytes, async (pdf) => {
    const pages = parsePageRange(options.pageRange, pdf.numPages);
    if (pages.length > MAX_SELECTED_PAGES) researchJobError('research_parse_page_limit');
    const service = input.modelFiles === null ? null : await createStructureService(input.modelFiles, options.device);
    const pageBlocks: ParseBlock[] = [];
    const assets: ParseAsset[] = [];
    const assetBudget = { totalBytes: 0 };
    const pageResults: Array<{ page: number; text: string; regions: unknown[] }> = [];
    const nativeTextPages: string[] = [];
    let usedOcr = false;
    let actualDevice: 'coreml' | 'cpu' = service?.device ?? 'cpu';
    for (const pageNumber of pages) {
      throwIfAborted(input.signal);
      const page = await pdf.getPage(pageNumber);
      try {
        const rendered = await renderResearchPdfPage(page, pageNumber, pdf.numPages, join(job.output, 'pages'), 1.5, true,
          researchDocumentLimits.maxAssetBytes);
        accountAsset(assets, assetBudget, rendered.pngBytes);
        assets.push({ path: `pages/page-${pageNumber}.png`, kind: 'page', page: pageNumber });
        const nativeText = normalizeText(rendered.text);
        nativeTextPages.push(nativeText);
        if (service === null) {
          if (nativeText.length === 0) researchJobError('research_model_pack_required');
          pageBlocks.push(makeBlock(`page-${pageNumber}-text`, 'paragraph', 'Page text', nativeText, pageNumber, [0, 0, rendered.width, rendered.height], null));
          pageResults.push({ page: pageNumber, text: nativeText, regions: [] });
          continue;
        }
        const inference = await service.service.run(rendered.image, structureRunOptions(service.hasFormula));
        usedOcr = true;
        actualDevice = service.device;
        const pageRegions: unknown[] = [];
        for (const [regionIndex, region] of inference.regions.entries()) {
          const regionType = normalizeRegionType(region.type);
          const regionText = regionTextValue(region);
          const regionImage = region.image;
          const relativeImagePath = regionImage === undefined ? null : `regions/page-${pageNumber}-region-${regionIndex + 1}.png`;
          if (regionImage !== undefined && relativeImagePath !== null) {
            const assetKind = regionType === 'table' ? 'table' : 'figure';
            const bytes = await imagePng(regionImage);
            accountAsset(assets, assetBudget, bytes.byteLength);
            await writePng(job.output, relativeImagePath, bytes);
            assets.push({ path: relativeImagePath, kind: assetKind, page: pageNumber });
          }
          const block = makeBlock(
            `page-${pageNumber}-region-${regionIndex + 1}`,
            regionType,
            normalizeText(region.label) || regionType,
            regionText,
            pageNumber,
            region.bbox,
            relativeImagePath
          );
          pageBlocks.push(block);
          pageRegions.push({
            id: block.id,
            type: region.type,
            label: region.label,
            score: region.score,
            bbox: region.bbox,
            status: region.status,
            text: regionText,
            imagePath: relativeImagePath,
            formula: region.formula?.formula ?? null,
            table: region.table?.structure ?? null
          });
        }
        if (pageBlocks.filter((block) => block.locations[0]?.page === pageNumber).length === 0 && nativeText.length > 0) {
          pageBlocks.push(makeBlock(`page-${pageNumber}-native`, 'paragraph', 'Page text', nativeText, pageNumber,
            [0, 0, rendered.width, rendered.height], null));
        }
        pageResults.push({ page: pageNumber, text: nativeText, regions: pageRegions });
        if (pageBlocks.length > researchDocumentLimits.maxBlocks) researchJobError('research_document_block_limit');
      } finally {
        page.cleanup();
      }
    }
    if (service === null && nativeTextPages.every((text) => text.length === 0)) researchJobError('research_model_pack_required');
    let parseMode: ParseResult['parseMode'] = 'native-text';
    if (usedOcr) {
      parseMode = nativeTextPages.some((text) => text.length > 0) ? 'mixed' : 'ocr';
    }
    const warnings = service === null ? ['research_models_missing_native_text_only'] : [];
    return await writeParseResult(job, {
      options,
      modelManifest: service === null ? '' : input.modelManifest,
      device: actualDevice,
      pageCount: pdf.numPages,
      parseMode,
      blocks: pageBlocks,
      assets,
      pageResults,
      warnings
    });
  });
}

async function parseImage(job: ResearchJobPaths, input: ParserInput, options: ResearchParseOptions): Promise<ParseResult> {
  if (input.modelFiles === null) researchJobError('research_model_pack_required');
  const rasterDocument = await decodeRasterDocument(job.source);
  const pages = parsePageRange(options.pageRange, rasterDocument.pageCount);
  const service = await createStructureService(input.modelFiles, options.device);
  const blocks: ParseBlock[] = [];
  const assets: ParseAsset[] = [];
  const assetBudget = { totalBytes: 0 };
  const pageResults: Array<{ page: number; text: string; regions: unknown[] }> = [];
  for (const pageNumber of pages) {
    throwIfAborted(input.signal);
    const raster = await rasterDocument.page(pageNumber);
    const pageImagePath = `pages/page-${pageNumber}.png`;
    const pagePng = await imagePng(raster);
    accountAsset(assets, assetBudget, pagePng.byteLength);
    await writePng(job.output, pageImagePath, pagePng);
    assets.push({ path: pageImagePath, kind: 'page', page: pageNumber });
    const inference = await service.service.run(raster, structureRunOptions(service.hasFormula));
    throwIfAborted(input.signal);
    const regions: unknown[] = [];
    for (const [index, region] of inference.regions.entries()) {
      const regionType = normalizeRegionType(region.type);
      const text = regionTextValue(region);
      const regionImage = region.image;
      const imagePath = regionImage === undefined ? null : `regions/page-${pageNumber}-region-${index + 1}.png`;
      if (regionImage !== undefined && imagePath !== null) {
        const imageBytes = await imagePng(regionImage);
        accountAsset(assets, assetBudget, imageBytes.byteLength);
        await writePng(job.output, imagePath, imageBytes);
        assets.push({ path: imagePath, kind: regionType === 'table' ? 'table' : 'figure', page: pageNumber });
      }
      const block = makeBlock(`page-${pageNumber}-region-${index + 1}`, regionType, normalizeText(region.label) || regionType,
        text, pageNumber, region.bbox, imagePath);
      blocks.push(block);
      regions.push({ id: block.id, type: region.type, label: region.label, score: region.score, bbox: region.bbox,
        status: region.status, text, imagePath, formula: region.formula?.formula ?? null, table: region.table?.structure ?? null });
    }
    pageResults.push({ page: pageNumber, text: '', regions });
    if (blocks.length > researchDocumentLimits.maxBlocks) researchJobError('research_document_block_limit');
  }
  return await writeParseResult(job, {
    options,
    modelManifest: input.modelManifest,
    device: service.device,
    pageCount: rasterDocument.pageCount,
    parseMode: 'ocr',
    blocks,
    assets,
    pageResults,
    warnings: []
  });
}

async function parseHtml(job: ResearchJobPaths, options: ResearchParseOptions): Promise<ParseResult> {
  if (options.pageRange.length > 0 && options.pageRange !== '1') researchJobError('research_parse_page_range_invalid');
  const html = await readFile(job.source, 'utf8');
  const document = parseDocument(html, { decodeEntities: true });
  const blocks: ParseBlock[] = [];
  collectHtmlBlocks(document, blocks);
  return await writeParseResult(job, {
    options,
    modelManifest: '',
    device: 'cpu',
    pageCount: 1,
    parseMode: 'html',
    blocks,
    assets: [],
    pageResults: [{ page: 1, text: '', regions: [] }],
    warnings: []
  });
}

type StructureRuntime = { service: PaddleStructureService; device: 'coreml' | 'cpu'; hasFormula: boolean };

async function createStructureService(files: ResearchModelFiles, preferredDevice: ResearchParseOptions['device']): Promise<StructureRuntime> {
  const fileEntries: Array<[string, string]> = [
    ['ocr-det', files.detection], ['ocr-rec', files.recognition], ['ocr-dictionary', files.dictionary], ['layout', files.layout], ['table', files.table]
  ];
  const formulaPath = files.formula;
  const tokenizerPath = files.formulaTokenizer;
  const hasFormula = formulaPath !== undefined && tokenizerPath !== undefined;
  if (hasFormula) {
    fileEntries.push(['formula', formulaPath], ['formula-tokenizer', tokenizerPath]);
  }
  const buffers = new Map<string, Buffer>();
  for (const [id, file] of fileEntries) {
    const bytes = await readFile(file);
    const asset = getModelAsset(id as Parameters<typeof getModelAsset>[0]);
    if (bytes.byteLength !== asset.bytes || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
      throw new ResearchProcessError('research_model_asset_invalid');
    }
    buffers.set(id, bytes);
  }
  const dictionary = buffers.get('ocr-dictionary')?.toString('utf8').trimEnd().split(/\r?\n/u) ?? [];
  if (dictionary.length !== 6904) throw new ResearchProcessError('research_model_dictionary_invalid');
  const ocrDet = buffers.get('ocr-det');
  const ocrRec = buffers.get('ocr-rec');
  const layout = buffers.get('layout');
  const table = buffers.get('table');
  if (!ocrDet || !ocrRec || !layout || !table) throw new ResearchProcessError('research_model_asset_missing');
  let usedCpuFallback = false;
  const configuredOrt: OrtModule = {
    Tensor: ort.Tensor,
    InferenceSession: {
      create: async (modelBuffer) => {
        let session: Awaited<ReturnType<typeof ort.InferenceSession.create>> | undefined;
        const sessionOptions = { intraOpNumThreads: 2, interOpNumThreads: 1 };
        if (preferredDevice === 'coreml') {
          try {
            session = await ort.InferenceSession.create(modelBuffer, { ...sessionOptions, executionProviders: ['coreml', 'cpu'] });
          } catch {
            usedCpuFallback = true;
          }
        }
        session ??= await ort.InferenceSession.create(modelBuffer, { ...sessionOptions, executionProviders: ['cpu'] });
        const nativeSession = session;
        const nativeInputMetadata = nativeSession.inputMetadata;
        const inputMetadataOptions = nativeInputMetadata?.map((metadata) => {
          if ('shape' in metadata) return { shape: metadata.shape };
          return {};
        });
        return {
          inputNames: nativeSession.inputNames,
          ...(inputMetadataOptions === undefined ? {} : { inputMetadata: inputMetadataOptions }),
          outputNames: nativeSession.outputNames,
          run: (feeds: Parameters<typeof nativeSession.run>[0]) => nativeSession.run(feeds),
          release: () => nativeSession.release()
        };
      }
    }
  };
  const formulaOptions = hasFormula
    ? await createFormulaOptions(buffers.get('formula'), buffers.get('formula-tokenizer'))
    : undefined;
  const service = await PaddleStructureService.createInstance({
    ort: configuredOrt,
    ocr: {
      modelPreset: 'PP-OCRv6_tiny',
      detection: { modelBuffer: toArrayBuffer(ocrDet) },
      recognition: { modelBuffer: toArrayBuffer(ocrRec), charactersDictionary: dictionary }
    },
    layout: { modelBuffer: toArrayBuffer(layout), preset: 'PP-DocLayout-S' },
    tableStructure: { modelBuffer: toArrayBuffer(table), preset: 'SLANet' },
    formulaRecognition: formulaOptions,
    options: structureRunOptions(hasFormula)
  });
  return { service, hasFormula, device: preferredDevice === 'coreml' && !usedCpuFallback ? 'coreml' : 'cpu' };
}

async function createFormulaOptions(formula: Buffer | undefined, tokenizer: Buffer | undefined): Promise<{
  modelBuffer: ArrayBuffer;
  preset: 'PP-FormulaNet-S';
  tokenizerVocabulary: string[];
} | undefined> {
  if (formula === undefined || tokenizer === undefined) return undefined;
  try {
    const tokenizerJson: unknown = JSON.parse(tokenizer.toString('utf8')) as unknown;
    return {
      modelBuffer: toArrayBuffer(formula),
      preset: 'PP-FormulaNet-S',
      tokenizerVocabulary: createFormulaTokenizerVocabulary(tokenizerJson)
    };
  } catch {
    throw new ResearchProcessError('research_model_tokenizer_invalid');
  }
}

function structureRunOptions(hasFormula: boolean): PaddleStructureRunOptions {
  return {
    documentOrientation: { enabled: false },
    textImageUnwarping: { enabled: false },
    regionDetection: { enabled: false },
    layout: { enabled: true, fallbackRegionType: false },
    readingOrder: { enabled: true },
    ocr: { enabled: true },
    table: { enabled: true },
    formula: { enabled: hasFormula },
    seal: { enabled: false },
    markdown: { enabled: true },
    includeRegionImage: true
  };
}

async function writeParseResult(job: ResearchJobPaths, input: {
  options: ResearchParseOptions;
  modelManifest: string;
  device: 'coreml' | 'cpu';
  pageCount: number;
  parseMode: ParseResult['parseMode'];
  blocks: ParseBlock[];
  assets: ParseAsset[];
  pageResults: Array<{ page: number; text: string; regions: unknown[] }>;
  warnings: string[];
}): Promise<ParseResult> {
  if (input.blocks.length > researchDocumentLimits.maxBlocks || input.assets.length > researchDocumentLimits.maxAssets) {
    researchJobError('research_document_structure_invalid');
  }
  const content = input.blocks.flatMap((block) => block.text.trim().length > 0 ? [block.text] : []).join('\n\n');
  const parserFingerprint = createHash('sha256').update(JSON.stringify({
    parserVersion: PARSER_VERSION,
    engineVersion: researchModelLock.runtime.paddleocr,
    runtimeVersion: researchModelLock.runtime.onnxruntimeNode,
    modelManifest: input.modelManifest,
    options: input.options,
    parseMode: input.parseMode
  })).digest('hex');
  const markdown = input.blocks.map((block) => block.kind === 'heading' ? `## ${block.text}` : block.text).filter(Boolean).join('\n\n');
  const artifacts = { middleJson: 'artifacts/middle.json', markdown: 'artifacts/document.md', structuredContent: 'artifacts/structured.json' };
  const result = {
    contractVersion: 3 as const,
    engine: 'paddleocr.js' as const,
    engineVersion: researchModelLock.runtime.paddleocr,
    parserVersion: PARSER_VERSION,
    parserFingerprint,
    modelManifest: input.modelManifest,
    runtime: {
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      paddleocr: researchModelLock.runtime.paddleocr,
      onnxruntime: researchModelLock.runtime.onnxruntimeNode
    },
    tier: input.options.tier,
    parseMode: input.parseMode,
    device: input.device,
    pageCount: input.pageCount,
    content,
    blocks: input.blocks,
    assets: input.assets,
    artifacts,
    warnings: input.warnings
  };
  const structured = JSON.stringify({ ...result, pages: input.pageResults }, null, 2);
  await writeText(job.output, artifacts.middleJson, structured);
  await writeText(job.output, artifacts.structuredContent, structured);
  await writeText(job.output, artifacts.markdown, markdown);
  return result;
}

type RasterDocument = { pageCount: number; page(pageNumber: number): Promise<Raster> };

async function decodeRasterDocument(path: string): Promise<RasterDocument> {
  const extension = extname(path).toLowerCase();
  if (extension === '.tif' || extension === '.tiff') {
    const buffer = toArrayBuffer(await readFile(path));
    const pages = UTIF.decode(buffer);
    if (pages.length === 0) researchJobError('research_image_decode_failed');
    return {
      pageCount: pages.length,
      page: async (pageNumber) => {
        const directory = pages[pageNumber - 1];
        if (directory === undefined) researchJobError('research_image_page_invalid');
        UTIF.decodeImage(buffer, directory);
        const width = directory.width;
        const height = directory.height;
        assertRasterSize(width, height);
        return { width, height, data: UTIF.toRGBA8(directory) };
      }
    };
  }
  const image = await loadImage(await readFile(path));
  assertRasterSize(image.width, image.height);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0, image.width, image.height);
  const imageData = context.getImageData(0, 0, image.width, image.height).data;
  const raster = { width: image.width, height: image.height,
    data: new Uint8Array(imageData.buffer, imageData.byteOffset, imageData.byteLength) };
  return {
    pageCount: 1,
    page: async (pageNumber) => {
      if (pageNumber !== 1) researchJobError('research_image_page_invalid');
      return raster;
    }
  };
}

async function imagePng(image: Raster): Promise<Buffer> {
  assertRasterSize(image.width, image.height);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  const imageData = context.createImageData(image.width, image.height);
  if (image.data.byteLength === image.width * image.height * 4) {
    imageData.data.set(image.data);
  } else if (image.data.byteLength === image.width * image.height * 3) {
    for (let source = 0, target = 0; source < image.data.length; source += 3, target += 4) {
      imageData.data[target] = image.data[source];
      imageData.data[target + 1] = image.data[source + 1];
      imageData.data[target + 2] = image.data[source + 2];
      imageData.data[target + 3] = 255;
    }
  } else if (image.data.byteLength === image.width * image.height) {
    for (let source = 0, target = 0; source < image.data.length; source += 1, target += 4) {
      const value = image.data[source];
      imageData.data[target] = value;
      imageData.data[target + 1] = value;
      imageData.data[target + 2] = value;
      imageData.data[target + 3] = 255;
    }
  } else {
    researchJobError('research_image_pixel_buffer_invalid');
  }
  context.putImageData(imageData, 0, 0);
  return Buffer.from(await canvas.encode('png'));
}

function accountAsset(assets: readonly ParseAsset[], budget: { totalBytes: number }, byteLength: number): void {
  if (byteLength > researchDocumentLimits.maxAssetBytes) researchJobError('research_document_asset_too_large');
  if (assets.length >= researchDocumentLimits.maxAssets || budget.totalBytes + byteLength > researchDocumentLimits.maxTotalAssetBytes) {
    researchJobError('research_document_assets_too_large');
  }
  budget.totalBytes += byteLength;
}

async function writePng(root: string, relativePath: string, bytes: Buffer): Promise<void> {
  if (bytes.byteLength > researchDocumentLimits.maxAssetBytes) researchJobError('research_document_asset_too_large');
  const target = join(root, relativePath);
  await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
  await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
}

async function writeText(root: string, relativePath: string, content: string): Promise<void> {
  if (Buffer.byteLength(content, 'utf8') > researchDocumentLimits.maxArtifactBytes) researchJobError('research_document_artifact_too_large');
  const target = join(root, relativePath);
  await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
  await writeFile(target, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

function parsePageRange(value: string, pageCount: number): number[] {
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 10_000) researchJobError('research_pdf_page_limit');
  if (value.trim().length === 0) {
    if (pageCount > MAX_SELECTED_PAGES) researchJobError('research_parse_page_limit');
    return Array.from({ length: pageCount }, (_, index) => index + 1);
  }
  const pages = new Set<number>();
  for (const part of value.split(',')) {
    const match = /^(\d+)(?:-(\d+))?$/u.exec(part.trim());
    if (match === null) researchJobError('research_parse_page_range_invalid');
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (start < 1 || end < start || end > pageCount || end - start + 1 > MAX_SELECTED_PAGES) {
      researchJobError('research_parse_page_range_invalid');
    }
    for (let page = start; page <= end; page += 1) pages.add(page);
    if (pages.size > MAX_SELECTED_PAGES) researchJobError('research_parse_page_limit');
  }
  return [...pages].sort((a, b) => a - b);
}

function makeBlock(id: string, kind: ParseBlock['kind'], label: string, text: string, page: number,
  bbox: [number, number, number, number], imagePath: string | null): ParseBlock {
  return {
    id,
    kind,
    label,
    text: normalizeText(text),
    locator: `page ${page}`,
    imagePath,
    locations: [{ page, bbox, coordinateOrigin: 'TOPLEFT' }]
  };
}

function normalizeRegionType(type: string): ParseBlock['kind'] {
  if (type === 'title' || type === 'doc_title' || type === 'paragraph_title') return 'heading';
  if (type === 'table') return 'table';
  if (type === 'formula' || type === 'equation') return 'formula';
  if (type === 'image' || type === 'figure' || type === 'chart') return 'figure';
  return 'paragraph';
}

function regionTextValue(region: {
  type: string;
  ocr?: readonly { text: string }[];
  table?: { structure?: { html?: string }; ocr?: readonly { text: string }[] };
  formula?: { formula: string };
}): string {
  if ((region.type === 'formula' || region.type === 'equation') && region.formula?.formula) return region.formula.formula;
  if (region.type === 'table' && region.table?.structure?.html) return region.table.structure.html;
  const tableText = region.table?.ocr?.map((item) => item.text).join(' ');
  if (tableText) return tableText;
  return region.ocr?.map((item) => item.text).join(' ') ?? '';
}

function normalizeText(value: string): string {
  return value.replace(/\u0000/gu, '').replace(/[ \t]+/gu, ' ').replace(/\n{3,}/gu, '\n\n').trim();
}

function assertRasterSize(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_PAGE_PIXELS) {
    researchJobError('research_image_too_large');
  }
}

function toArrayBuffer(bytes: Buffer): ArrayBuffer {
  const buffer = bytes.buffer;
  if (buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === buffer.byteLength) return buffer;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) researchJobError('research_process_cancelled');
}

type HtmlNode = { type?: unknown; name?: unknown; data?: unknown; attribs?: unknown; children?: unknown };

function collectHtmlBlocks(document: unknown, output: ParseBlock[]): void {
  const visit = (input: unknown): void => {
    const node = asHtmlNode(input);
    if (node === null) return;
    const name = typeof node.name === 'string' ? node.name.toLowerCase() : '';
    if (['script', 'style', 'noscript', 'template'].includes(name)) return;
    const kind = htmlBlockKind(name);
    if (kind !== null) {
      const text = name === 'table' ? htmlTableText(node) : htmlText(node);
      if (text.length > 0) output.push(makeBlock(`html-${output.length + 1}`, kind, name, text, 1, [0, 0, 0, 0], null));
      return;
    }
    if (name === 'img') {
      const attrs = asRecord(node.attribs);
      const alt = typeof attrs?.alt === 'string' ? normalizeText(attrs.alt) : '';
      if (alt.length > 0) output.push(makeBlock(`html-${output.length + 1}`, 'figure', 'image', alt, 1, [0, 0, 0, 0], null));
      return;
    }
    for (const child of asArray(node.children)) visit(child);
  };
  visit(document);
}

function htmlBlockKind(name: string): ParseBlock['kind'] | null {
  if (/^h[1-6]$/u.test(name)) return 'heading';
  if (name === 'table') return 'table';
  if (['p', 'li', 'blockquote', 'pre', 'figcaption', 'dt', 'dd'].includes(name)) return 'paragraph';
  return null;
}

function htmlTableText(node: HtmlNode): string {
  const rows: string[][] = [];
  const findRows = (input: unknown): void => {
    const current = asHtmlNode(input);
    if (current === null) return;
    if (current.name === 'tr') {
      const cells: string[] = [];
      for (const child of asArray(current.children)) {
        const cell = asHtmlNode(child);
        if (cell !== null && (cell.name === 'td' || cell.name === 'th')) cells.push(htmlText(cell));
      }
      if (cells.length > 0) rows.push(cells);
      return;
    }
    for (const child of asArray(current.children)) findRows(child);
  };
  findRows(node);
  if (rows.length === 0) return htmlText(node);
  return rows.map((row, index) => `| ${row.join(' | ')} |${index === 0 ? `\n| ${row.map(() => '---').join(' | ')} |` : ''}`).join('\n');
}

function htmlText(input: unknown): string {
  const node = asHtmlNode(input);
  if (node === null) return '';
  if (node.type === 'text' && typeof node.data === 'string') return node.data;
  return normalizeText(asArray(node.children).map(htmlText).join(' '));
}

function asHtmlNode(value: unknown): HtmlNode | null {
  if (typeof value !== 'object' || value === null) return null;
  return value as HtmlNode;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}
