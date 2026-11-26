import {parsePageRange} from './parse-page-range';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { extname, join } from 'node:path';
import {decodeRasterDocument, imagePng, type Raster} from './research-raster';
import { parseDocument } from 'htmlparser2';
import {attachPaperTables} from './pdf-table-extractor';
import {paperTableVersion} from '../../../shared/schemas/research-paper-table';
import {attachPaperEquations} from './pdf-equation-extractor';
import {paperEquationVersion, latexNormalizationVersion} from '../../../shared/schemas/research-paper-equation';
import {attachPaperVisuals} from './pdf-caption-linker';
import {paperVisualVersion} from '../../../shared/schemas/research-paper-visual';
import {assessPdfQuality} from './pdf-quality-assessor';
import {paperQualityVersion} from '../../../shared/schemas/research-paper-quality';
import {
  getObjectDetectionPreset,
  matchTableStructureToOcr,
  parseRecognitionDictionary,
  PaddleStructureService,
  type OrtModule,
  type PaddleStructureRegionResult,
  type PaddleStructureTableResult,
  type PaddleStructureRunOptions
} from 'paddleocr';
import { researchDocumentLimits, researchParseOptionsSchema, researchParsedDocumentSchema, researchParseContractVersion, researchParserVersion, type ResearchParseOptions } from '../../../shared/schemas/research-production';
import type { z } from 'zod';
import { ResearchProcessError } from './process-runner';
import {researchCoordinateFrameContractVersion, researchRasterCoordinateFrameSchema, type ResearchDocumentCoordinateFrame} from '../../../shared/schemas/research-document-coordinates';
import { runResearchJob, researchJobError, type ResearchJobPaths } from './research-job';
import {
  extractResearchPdfPageNativeText,
  measureResearchPdfPage,
  renderResearchPdfPage,
  researchPdfPageHasVisualContent,
  withResearchPdf,
  type ResearchPdfPageImage,
  type ResearchPdfPageLayout,
  type ResearchPdfStage,
  type ResearchPdfStageObserver
} from './pdf-render';
import { researchOcrRuntime, getModelAsset, modelPackManifest } from './model-catalog';
import type { ResearchModelFiles } from './model-store';
import { withOcrSessionScope, type OcrSessionRegistrar } from './ocr-session-scope';
import {OcrStageSessions} from './ocr-stage-sessions';
import type {ResearchProcessingTrace, ProcessingStage} from './processing-trace';
import {projectNativeTextItems, type NativeTextItem} from './pdf-native-text';
import {fusePdfPage, pdfBoxIou, type FusionRegion, type RecognitionProvenance} from './pdf-layout-merge';
import {annotatePdfDocumentReading, pdfDocumentReadingVersion} from './pdf-document-reading';
import {buildPaperStructure, paperStructureVersion} from './paper-structure';

const MAX_SOURCE_BYTES = 512 * 1024 * 1024;
const MAX_HTML_BYTES = 64 * 1024 * 1024;
const MAX_SELECTED_PAGES = 500;
const MIN_NATIVE_TEXT_CHARACTERS = 600;
const MIN_NATIVE_TEXT_WORDS = 80;
const MIN_NATIVE_TEXT_PRINTABLE_RATIO = 0.9;
const PARSER_VERSION = researchParserVersion;
const SUPPORTED_EXTENSIONS = ['.pdf', '.html', '.htm', '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp'] as const;

type ParsedPage = {page: number; text: string; regions: unknown[]; coordinateFrame: ResearchDocumentCoordinateFrame | null;
  nativeTextItems?: NativeTextItem[];
  fusion?: {version: 1; provenance: RecognitionProvenance[]; warnings: string[]; duplicatedRegionCount: number}};
type ParseDocument = z.infer<typeof researchParsedDocumentSchema>;
type ParseBlock = ParseDocument['blocks'][number];
type ParseAsset = ParseDocument['assets'][number];
type ParseResult = {
  contractVersion: typeof researchParseContractVersion;
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
  structure: ReturnType<typeof buildPaperStructure>;
  quality: ReturnType<typeof assessPdfQuality>;
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
  onStage?: ResearchPdfStageObserver;
  trace?: ResearchProcessingTrace;
};

export async function parseResearchDocument(input: ParserInput): Promise<ParseDocument> {
  const operation = async (): Promise<ParseDocument> => await parseResearchDocumentImpl(input);
  return input.trace ? await input.trace.run('document_parse', operation, {unit: 'blocks'}, result => result.blocks.length)
    : await operation();
}

async function parseResearchDocumentImpl(input: ParserInput): Promise<ParseDocument> {
  const options = researchParseOptionsSchema.parse(input.options);
  if (options.tier !== 'compact') researchJobError('research_model_pack_unsupported');
  const extension = extname(input.sourcePath).toLowerCase();
  if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(extension)) {
    researchJobError('research_document_format_unsupported');
  }
  if (input.modelFiles !== null && input.modelManifest !== modelPackManifest('compact')) {
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
    signal: input.signal,
    awaitOperationCleanupOnAbort: true
  }, async (job, signal) => await withOcrSessionScope(async (registerSession) => {
    input.trace?.bind({source_hash: job.sourceHash});
    throwIfAborted(signal);
    if (extension === '.pdf') return await parsePdf(job, input, options, registerSession, signal);
    if (extension === '.html' || extension === '.htm') return await parseHtml(job, options, input.trace);
    return await parseImage(job, input, options, registerSession, signal);
  }));
  input.trace?.bind({parser_fingerprint: result.parserFingerprint});
  return researchParsedDocumentSchema.parse(result);
}

async function parsePdf(
  job: ResearchJobPaths,
  input: ParserInput,
  options: ResearchParseOptions,
  registerSession: OcrSessionRegistrar,
  signal: AbortSignal
): Promise<ParseResult> {
  const bytes = input.trace ? await input.trace.run('source_read', async () => await readFile(job.source),
    {unit: 'bytes'}, result => result.length) : await readFile(job.source);
  return await withResearchPdf(bytes, async (pdf) => {
    const pages = parsePageRange(options.pageRange, pdf.numPages);
    if (pages.length > MAX_SELECTED_PAGES) researchJobError('research_parse_page_limit');
    let service: StructureRuntime | null = null;
    const pageBlocks: ParseBlock[] = [];
    const assets: ParseAsset[] = [];
    const assetBudget = { totalBytes: 0 };
    const pageResults: ParsedPage[] = [];
    const nativeTextPages: string[] = [];
    let usedOcr = false;
    let actualDevice: 'coreml' | 'cpu' = 'cpu';
    // Basic OCR uses the fixed 108 DPI raster.
    const ocrScale = 1.5;
    for (const pageNumber of pages) {
      if (input.trace) input.trace.page = pageNumber;
      throwIfAborted(signal);
      const page = await pdf.getPage(pageNumber);
      let ocrImage: ResearchPdfPageImage['image'] = null;
      try {
        const extract = async () => await extractResearchPdfPageNativeText(page, pageNumber, input.onStage);
        const native = input.trace ? await input.trace.run('native_text_extract', extract,
          {inputCount: 1, unit: 'pages'}, () => 1) : await extract();
        const nativeText = normalizeText(native.text);
        throwIfAborted(signal);
        const hasHighQualityText = hasHighQualityNativeText(nativeText);
        let hasVisualContent = false;
        if (hasHighQualityText) {
          const visualInspectionStartedAt = performance.now();
          try {
            hasVisualContent = input.trace ? await input.trace.run('visual_inspection', async () => await researchPdfPageHasVisualContent(page),
              {inputCount: 1, unit: 'pages'}, () => 1) : await researchPdfPageHasVisualContent(page);
          } finally {
            recordPdfStage(input.onStage, 'visual-inspection', pageNumber, visualInspectionStartedAt);
          }
          throwIfAborted(signal);
        }
        const nativeTextOnly = input.modelFiles === null
          ? nativeText.length > 0
          : hasHighQualityText && !hasVisualContent;
        const omitPageImage = nativeTextOnly && hasHighQualityText && !hasVisualContent;
        let pageLayout: ResearchPdfPageLayout;
        if (omitPageImage) {
          pageLayout = measureResearchPdfPage({
            page, pageNumber, pageCount: pdf.numPages, text: nativeText, scale: 1.5, clampToPixelLimit: true, onStage: input.onStage
          });
        } else {
          const rendered = await renderResearchPdfPage(page, pageNumber, pdf.numPages, join(job.output, 'pages'), ocrScale, true,
            researchDocumentLimits.maxAssetBytes, {
              includeRgbaImage: !nativeTextOnly,
              text: nativeText,
              onStage: input.onStage
            });
          // A Pick annotation alone would still retain the RGBA property.
          pageLayout = {
            page: rendered.page, pageCount: rendered.pageCount, width: rendered.width, height: rendered.height,
            text: rendered.text, coordinateFrame: rendered.coordinateFrame
          };
          ocrImage = rendered.image;
          rendered.image = null;
          accountAsset(assets, assetBudget, rendered.pngBytes);
          assets.push({ path: `pages/page-${pageNumber}.png`, kind: 'page', page: pageNumber });
        }
        throwIfAborted(signal);
        nativeTextPages.push(nativeText);
        const nativeTextItems = projectNativeTextItems(native.items, pageLayout.coordinateFrame);
        if (nativeTextOnly) {
          const {blocks, ...fusion} = fusePdfPage({page: pageNumber, width: pageLayout.width, nativeItems: nativeTextItems, regions: []});
          pageBlocks.push(...blocks);
          pageResults.push({page: pageNumber, text: nativeText, regions: [], coordinateFrame: pageLayout.coordinateFrame,
            nativeTextItems, fusion: {version: 1, ...fusion}});
          if (pageBlocks.length > researchDocumentLimits.maxBlocks) researchJobError('research_document_block_limit');
          continue;
        }
        if (input.modelFiles === null) researchJobError('research_model_pack_required');
        service ??= await createStructureService(input.modelFiles, options.device, registerSession, signal, input.onStage, input.trace);
        throwIfAborted(signal);
        if (ocrImage === null) researchJobError('research_pdf_ocr_raster_missing');
        const inferenceStartedAt = performance.now();
        let inference: Awaited<ReturnType<PaddleStructureService['run']>>;
        try {
          inference = await service.service.run(ocrImage, structureRunOptions());
          await service.sessions.releaseIdle();
        } catch (error) {
          input.trace?.flushModels(error);
          throw error;
        } finally {
          input.trace?.flushModels();
          ocrImage = null;
          recordPdfStage(input.onStage, 'ocr-inference', pageNumber, inferenceStartedAt);
        }
        throwIfAborted(signal);
        usedOcr = true;
        actualDevice = service.device;
        const pageRegions: unknown[] = [];
        const fusionRegions: FusionRegion[] = [];
        for (const [regionIndex, region] of inference.regions.entries()) {
          const regionType = normalizeRegionType(region.type);
          const regionContent = extractResearchRegionContent(region);
          const regionText = regionContent.text;
          const regionImage = region.image;
          const relativeImagePath = regionImage === undefined ? null : `regions/page-${pageNumber}-region-${regionIndex + 1}.png`;
          if (regionImage !== undefined && relativeImagePath !== null) {
            const regionWriteStartedAt = performance.now();
            try {
              const assetKind = regionType === 'table' ? 'table' : 'figure';
              const bytes = await imagePng(regionImage);
              accountAsset(assets, assetBudget, bytes.byteLength);
              await writePng(job.output, relativeImagePath, bytes);
              assets.push({ path: relativeImagePath, kind: assetKind, page: pageNumber });
            } finally {
              recordPdfStage(input.onStage, 'region-write', pageNumber, regionWriteStartedAt);
            }
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
          if (publishLayoutRegion(region, inference.regions)) {
            fusionRegions.push({block, score: Number.isFinite(region.score) ? region.score : null});
          }
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
            table: regionContent.table?.structure ?? null,
            tableMatches: regionContent.table?.matched ?? null
          });
        }
        const {blocks, ...fusion} = fusePdfPage({page: pageNumber, width: pageLayout.width,
          nativeItems: nativeTextItems, regions: fusionRegions});
        pageBlocks.push(...blocks);
        pageResults.push({page: pageNumber, text: nativeText, regions: pageRegions, coordinateFrame: pageLayout.coordinateFrame,
          nativeTextItems, fusion: {version: 1, ...fusion}});
        if (pageBlocks.length > researchDocumentLimits.maxBlocks) researchJobError('research_document_block_limit');
      } finally {
        ocrImage = null;
        page.cleanup();
        if (input.trace) input.trace.page = null;
      }
    }
    if (input.modelFiles === null && nativeTextPages.every((text) => text.length === 0)) researchJobError('research_model_pack_required');
    let parseMode: ParseResult['parseMode'] = 'native-text';
    if (usedOcr) {
      parseMode = nativeTextPages.some((text) => text.length > 0) ? 'mixed' : 'ocr';
    }
    const warnings = [...(input.modelFiles === null ? ['research_models_missing_native_text_only'] : []),
      ...pageResults.flatMap(page => page.fusion?.warnings ?? [])];
    const artifactWriteStartedAt = performance.now();
    try {
      return await writeParseResult(job, {
        options,
        modelManifest: service === null ? '' : input.modelManifest,
        device: actualDevice,
        pageCount: pdf.numPages,
        parseMode,
        blocks: annotatePdfDocumentReading(pageBlocks, pageResults),
        assets,
        pageResults,
        warnings
      });
    } finally {
      recordPdfStage(input.onStage, 'parse-artifact-write', null, artifactWriteStartedAt);
    }
  });
}

async function parseImage(
  job: ResearchJobPaths,
  input: ParserInput,
  options: ResearchParseOptions,
  registerSession: OcrSessionRegistrar,
  signal: AbortSignal
): Promise<ParseResult> {
  if (input.modelFiles === null) researchJobError('research_model_pack_required');
  const rasterDocument = input.trace ? await input.trace.run('source_read', async () => await decodeRasterDocument(await readFile(job.source), extname(job.source)),
    {unit: 'pages'}, result => result.pageCount) : await decodeRasterDocument(await readFile(job.source), extname(job.source));
  throwIfAborted(signal);
  const pages = parsePageRange(options.pageRange, rasterDocument.pageCount);
  const service = await createStructureService(input.modelFiles, options.device, registerSession, signal, input.onStage, input.trace);
  const blocks: ParseBlock[] = [];
  const assets: ParseAsset[] = [];
  const assetBudget = { totalBytes: 0 };
  const pageResults: ParsedPage[] = [];
  for (const pageNumber of pages) {
    if (input.trace) input.trace.page = pageNumber;
    throwIfAborted(signal);
    let raster: Raster | null = await rasterDocument.page(pageNumber);
    const {width, height} = raster;
    const pageImagePath = `pages/page-${pageNumber}.png`;
    let pagePng: Buffer | undefined = await imagePng(raster);
    accountAsset(assets, assetBudget, pagePng.byteLength);
    await writePng(job.output, pageImagePath, pagePng);
    pagePng = undefined;
    assets.push({ path: pageImagePath, kind: 'page', page: pageNumber });
    throwIfAborted(signal);
    let inference: Awaited<ReturnType<PaddleStructureService['run']>>;
    try {
      inference = await service.service.run(raster, structureRunOptions());
      await service.sessions.releaseIdle();
    } catch (error) {
      input.trace?.flushModels(error);
      throw error;
    } finally {
      input.trace?.flushModels();
      if (input.trace) input.trace.page = null;
      raster = null;
    }
    throwIfAborted(signal);
    const regions: unknown[] = [];
    for (const [index, region] of inference.regions.entries()) {
      const regionType = normalizeRegionType(region.type);
      const regionContent = extractResearchRegionContent(region);
      const text = regionContent.text;
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
      if (publishLayoutRegion(region, inference.regions)) blocks.push(block);
      regions.push({ id: block.id, type: region.type, label: region.label, score: region.score, bbox: region.bbox,
        status: region.status, text, imagePath, formula: region.formula?.formula ?? null,
        table: regionContent.table?.structure ?? null, tableMatches: regionContent.table?.matched ?? null });
    }
    pageResults.push({ page: pageNumber, text: '', regions, coordinateFrame: researchRasterCoordinateFrameSchema.parse({
      kind: 'image', page: pageNumber, unit: 'raster-pixel', coordinateOrigin: 'TOPLEFT', width, height
    }) });
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

async function parseHtml(job: ResearchJobPaths, options: ResearchParseOptions, trace?: ResearchProcessingTrace): Promise<ParseResult> {
  if (options.pageRange.length > 0 && options.pageRange !== '1') researchJobError('research_parse_page_range_invalid');
  const bytes = trace ? await trace.run('source_read', async () => await readFile(job.source),
    {unit: 'bytes'}, result => result.length) : await readFile(job.source);
  const html = bytes.toString('utf8');
  const blocks: ParseBlock[] = [];
  const regions: unknown[] = [];
  const extract = (): void => collectHtmlBlocks(parseDocument(html, {
    decodeEntities: true, withStartIndices: true, withEndIndices: true
  }), blocks, (block, node) => {
    if (typeof node.startIndex === 'number' && typeof node.endIndex === 'number') {
      regions.push({id: block.id, rawHtml: html.slice(node.startIndex, node.endIndex + 1)});
    }
  });
  if (trace) trace.sync('native_text_extract', extract, {inputCount: 1, unit: 'blocks'}, () => blocks.length);
  else extract();
  return await writeParseResult(job, {
    options,
    modelManifest: '',
    device: 'cpu',
    pageCount: 1,
    parseMode: 'html',
    blocks,
    assets: [],
    pageResults: [{ page: 1, text: '', regions, coordinateFrame: null }],
    warnings: []
  });
}

type StructureRuntime = { service: PaddleStructureService; sessions: OcrStageSessions; device: 'coreml' | 'cpu' };

// Legacy CoreML neural networks trap on PP-DocLayout-S and misplace SLANet row bounds.
const COREML_FLAG_CREATE_MLPROGRAM = 0x010;
const layoutPreset = getObjectDetectionPreset('PP-DocLayout-S');
const defaultLayoutThreshold = 0.5;
// Use the model's NMS score floor for scientific charts and formulae on dense pages.
const layoutThresholds = layoutPreset.options.labels?.map(label => label === 'formula' || label === 'chart' ? 0.3 : defaultLayoutThreshold);

// Keep every detection in middle.json. A lower-confidence chart or formula may
// add a block only when a stronger detection does not already cover that region.
function publishLayoutRegion(region: PaddleStructureRegionResult, regions: PaddleStructureRegionResult[]): boolean {
  return region.score >= defaultLayoutThreshold || !regions.some(other =>
    other.score >= defaultLayoutThreshold && pdfBoxIou(region.bbox, other.bbox) >= 0.5);
}

async function createStructureService(
  files: ResearchModelFiles,
  preferredDevice: ResearchParseOptions['device'],
  registerSession: OcrSessionRegistrar,
  signal: AbortSignal,
  onStage?: ResearchPdfStageObserver,
  trace?: ResearchProcessingTrace
): Promise<StructureRuntime> {
  const fileEntries: Array<[string, string]> = [
    ['ocr-det', files.detection], ['ocr-rec', files.recognition], ['ocr-dictionary', files.dictionary], ['layout', files.layout], ['table', files.table]
  ];
  const buffers = new Map<string, Buffer>();
  const modelValidationStartedAt = performance.now();
  try {
    for (const [id, file] of fileEntries) {
      throwIfAborted(signal);
      const bytes = await readFile(file);
      const asset = getModelAsset(id as Parameters<typeof getModelAsset>[0]);
      if (bytes.byteLength !== asset.bytes || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
        throw new ResearchProcessError('research_model_asset_invalid');
      }
      buffers.set(id, bytes);
    }
  } finally {
    recordPdfStage(onStage, 'model-validation', null, modelValidationStartedAt);
  }
  const dictionary = buffers.get('ocr-dictionary');
  const ocrDet = buffers.get('ocr-det');
  const ocrRec = buffers.get('ocr-rec');
  const layout = buffers.get('layout');
  const table = buffers.get('table');
  if (!ocrDet || !ocrRec || !dictionary || !layout || !table) throw new ResearchProcessError('research_model_asset_missing');
  // Native-text PDFs and HTML need no ONNX binding. Load it after OCR asset validation.
  throwIfAborted(signal);
  const ort = await import('onnxruntime-node');
  throwIfAborted(signal);
  let usedCpuFallback = false;
  const modelStages = new Map<ArrayBuffer, ProcessingStage>();
  const modelBuffer = (buffer: Buffer, stage: ProcessingStage): ArrayBuffer => {
    const value = toArrayBuffer(buffer);
    modelStages.set(value, stage);
    return value;
  };
  const sessions = new OcrStageSessions(signal);
  registerSession(sessions);
  const configuredOrt: OrtModule = {
    Tensor: ort.Tensor,
    InferenceSession: {
      create: async (modelBuffer) => {
        const stage = modelStages.get(modelBuffer);
        const nativeSession = await sessions.create(stage ?? 'unknown', async () => {
          let session: Awaited<ReturnType<typeof ort.InferenceSession.create>> | undefined;
          // Sessions are reopened at stage boundaries. CPU arenas retain large
          // allocations for reuse; avoid that extra footprint in this lifecycle.
          const sessionOptions = { intraOpNumThreads: 2, interOpNumThreads: 1, enableCpuMemArena: false };
          throwIfAborted(signal);
          if (preferredDevice === 'coreml') {
            try {
              const provider = stage === 'layout_inference' || stage === 'table_reconstruction'
                ? { name: 'coreml', coreMlFlags: COREML_FLAG_CREATE_MLPROGRAM } : 'coreml';
              session = await ort.InferenceSession.create(modelBuffer, { ...sessionOptions, executionProviders: [provider, 'cpu'] });
            } catch {
              usedCpuFallback = true;
              throwIfAborted(signal);
            }
          }
          return session ?? await ort.InferenceSession.create(modelBuffer, { ...sessionOptions, executionProviders: ['cpu'] });
        });
        return {
          inputNames: nativeSession.inputNames,
          inputMetadata: nativeSession.inputMetadata.map(metadata => metadata.isTensor ? { shape: metadata.shape } : {}),
          outputNames: nativeSession.outputNames,
          run: (feeds: Parameters<typeof nativeSession.run>[0]) => trace && stage
            ? trace.modelRun(stage, async () => await nativeSession.run(feeds)) : nativeSession.run(feeds),
          release: nativeSession.release
        };
      }
    }
  };
  throwIfAborted(signal);
  const modelInitializationStartedAt = performance.now();
  try {
    const service = await PaddleStructureService.createInstance({
      ort: configuredOrt,
      ocr: {
        modelPreset: 'PP-OCRv6_tiny',
        detection: { modelBuffer: modelBuffer(ocrDet, 'ocr_inference') },
        recognition: { modelBuffer: modelBuffer(ocrRec, 'ocr_inference'), charactersDictionary: parseRecognitionDictionary(dictionary.toString('utf8')) }
      },
      layout: { modelBuffer: modelBuffer(layout, 'layout_inference'), preset: layoutPreset.name, threshold: layoutThresholds },
      tableStructure: { modelBuffer: modelBuffer(table, 'table_reconstruction'), preset: 'SLANet' },
      options: structureRunOptions()
    });
    await sessions.releaseIdle();
    return { service, sessions, get device() { return preferredDevice === 'coreml' && !usedCpuFallback ? 'coreml' : 'cpu'; } };
  } finally {
    recordPdfStage(onStage, 'model-initialization', null, modelInitializationStartedAt);
  }
}

function structureRunOptions(): PaddleStructureRunOptions {
  return {
    documentOrientation: { enabled: false },
    textImageUnwarping: { enabled: false },
    regionDetection: { enabled: false },
    layout: { enabled: true, fallbackRegionType: false },
    readingOrder: { enabled: true },
    ocr: { enabled: true },
    table: { enabled: true },
    formula: { enabled: false },
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
  pageResults: ParsedPage[];
  warnings: string[];
}): Promise<ParseResult> {
  if (input.blocks.length > researchDocumentLimits.maxBlocks || input.assets.length > researchDocumentLimits.maxAssets) {
    researchJobError('research_document_structure_invalid');
  }
  const blocks = attachPaperVisuals(attachPaperEquations(attachPaperTables(input.blocks, input.pageResults), input.pageResults));
  const content = input.blocks.flatMap((block) => block.text.trim().length > 0 ? [block.text] : []).join('\n\n');
  const parserFingerprint = createHash('sha256').update(JSON.stringify({
    parserVersion: PARSER_VERSION,
    documentReadingVersion: input.parseMode === 'html' ? null : pdfDocumentReadingVersion,
    paperStructureVersion,
    paperTableVersion,
    paperEquationVersion, latexNormalizationVersion,
    paperVisualVersion,
    paperQualityVersion,
    engineVersion: researchOcrRuntime.paddleocr,
    runtimeVersion: researchOcrRuntime.onnxruntimeNode,
    modelManifest: input.modelManifest,
    options: input.options,
    parseMode: input.parseMode
  })).digest('hex');
  const markdown = input.blocks.map((block) => block.kind === 'heading' ? `## ${block.text}` : block.text).filter(Boolean).join('\n\n');
  const artifacts = { middleJson: 'artifacts/middle.json', markdown: 'artifacts/document.md', structuredContent: 'artifacts/structured.json' };
  const result = {
    contractVersion: researchParseContractVersion as typeof researchParseContractVersion,
    engine: 'paddleocr.js' as const,
    engineVersion: researchOcrRuntime.paddleocr,
    parserVersion: PARSER_VERSION,
    parserFingerprint,
    modelManifest: input.modelManifest,
    runtime: {
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      paddleocr: researchOcrRuntime.paddleocr,
      onnxruntime: researchOcrRuntime.onnxruntimeNode
    },
    tier: input.options.tier,
    parseMode: input.parseMode,
    device: input.device,
    pageCount: input.pageCount,
    content,
    blocks,
    structure: buildPaperStructure(input.blocks),
    quality: assessPdfQuality({pages: input.pageResults, blocks}),
    assets: input.assets,
    artifacts,
    warnings: input.warnings
  };
  const structured = JSON.stringify({ ...result, coordinateFrameContractVersion: researchCoordinateFrameContractVersion,
    pages: input.pageResults }, null, 2);
  await writeText(job.output, artifacts.middleJson, structured);
  await writeText(job.output, artifacts.markdown, markdown);
  await writeText(job.output, artifacts.structuredContent, structured);
  return result;
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


function makeBlock(id: string, kind: ParseBlock['kind'], label: string, text: string, page: number,
  bbox: [number, number, number, number] | null, imagePath: string | null): ParseBlock {
  return {
    id,
    kind,
    label,
    text: normalizeText(text),
    locator: `page ${page}`,
    imagePath,
    locations: [{ page, bbox, coordinateOrigin: bbox === null ? null : 'TOPLEFT' }]
  };
}

function normalizeRegionType(type: string): ParseBlock['kind'] {
  if (type === 'title' || type === 'doc_title' || type === 'paragraph_title') return 'heading';
  if (type === 'table') return 'table';
  if (type === 'formula' || type === 'equation') return 'formula';
  if (type === 'image' || type === 'figure' || type === 'chart') return 'figure';
  return 'paragraph';
}

export function extractResearchRegionContent(region: PaddleStructureRegionResult): {
  text: string;
  table: PaddleStructureTableResult | null;
} {
  let table = region.table ?? null;
  if (region.type === 'table' && table !== null) {
    if (region.image !== undefined && table.structure !== undefined && table.ocr !== undefined) {
      const { width, height } = region.image;
      // The locked PaddleX SLANet model normalizes boxes to the source crop.
      // paddleocr.js 1.2 decodes against square padding instead; undo that scale
      // before matching OCR. Otherwise every row of a wide table lands in row 1.
      const side = Math.max(width, height);
      const structure = { ...table.structure, bbox: table.structure.bbox.map((box) =>
        box.map((value, index) => value * (index % 2 === 0 ? width : height) / side)) };
      table = { ...table, structure, matched: matchTableStructureToOcr(structure, table.ocr) };
    }
    const html = table.matched?.html || table.structure?.html;
    if (html) {
      const document = parseDocument(html);
      if (htmlText(document).trim().length > 0) return { text: htmlTableText(document), table };
    }
    const text = table.ocr?.map((item) => item.text).join(' ');
    if (text) return { text, table };
  }
  if ((region.type === 'formula' || region.type === 'equation') && region.formula?.formula) {
    return { text: region.formula.formula, table };
  }
  return { text: region.ocr?.map((item) => item.text).join(' ') ?? '', table };
}

function normalizeText(value: string): string {
  return value.replace(/\u0000/gu, '').replace(/[ \t]+/gu, ' ').replace(/\n{3,}/gu, '\n\n').trim();
}

function hasHighQualityNativeText(value: string): boolean {
  if (value.length < MIN_NATIVE_TEXT_CHARACTERS) return false;
  const wordCount = value.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  if (wordCount < MIN_NATIVE_TEXT_WORDS) return false;
  const printableCount = value.match(/[\p{L}\p{N}\p{P}\p{Zs}]/gu)?.length ?? 0;
  return printableCount / value.length >= MIN_NATIVE_TEXT_PRINTABLE_RATIO;
}

function recordPdfStage(observer: ResearchPdfStageObserver | undefined, stage: ResearchPdfStage, page: number | null,
  startedAt: number): void {
  observer?.({ stage, page, durationMs: performance.now() - startedAt });
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

type HtmlNode = { type?: unknown; name?: unknown; data?: unknown; attribs?: unknown; children?: unknown;
  startIndex?: unknown; endIndex?: unknown };

function collectHtmlBlocks(document: unknown, output: ParseBlock[], table: (block: ParseBlock, node: HtmlNode) => void): void {
  const visit = (input: unknown): void => {
    const node = asHtmlNode(input);
    if (node === null) return;
    const name = typeof node.name === 'string' ? node.name.toLowerCase() : '';
    if (['script', 'style', 'noscript', 'template'].includes(name)) return;
    const kind = htmlBlockKind(name);
    if (kind !== null) {
      const text = name === 'table' ? htmlTableText(node) : htmlText(node);
      if (text.length > 0) {
        const block = makeBlock(`html-${output.length + 1}`, kind, name, text, 1, null, null);
        output.push(block);
        if (kind === 'table') table(block, node);
      }
      return;
    }
    if (name === 'img') {
      const attrs = asRecord(node.attribs);
      const alt = typeof attrs?.alt === 'string' ? normalizeText(attrs.alt) : '';
      if (alt.length > 0) output.push(makeBlock(`html-${output.length + 1}`, 'figure', 'image', alt, 1, null, null));
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
