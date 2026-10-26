import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { createCanvas, loadImage, PDFDocument } from '@napi-rs/canvas';
import * as vega from 'vega';
import { loader, parse, read, View, type Format, type FormatDSV, type FormatJSON, type FormatSV } from 'vega';
import { compile, type TopLevelSpec } from 'vega-lite';
import { researchFigureRenderJobSchema, researchFigureRenderResultSchema, type ResearchFigureRenderJob } from '../../../shared/schemas/research-figures';
import { runResearchJob } from './research-job';
import { ResearchProcessError } from './process-runner';
import { getResearchFigureRendererEnvironment } from './figure-renderer-environment';

type VegaRandomApi = { random: () => number; setRandom: (next: () => number) => void };
const vegaRandomApi = vega as typeof vega & VegaRandomApi;
const MAX_FIGURE_SPEC_BYTES = 4 * 1024 * 1024;

const MAX_FIGURE_SPEC_DEPTH = 64;
let vegaRandomQueue: Promise<void> = Promise.resolve();

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

async function withSeededVegaRandom<T>(seed: number, render: () => Promise<T>): Promise<T> {
  const previous = vegaRandomQueue;
  let release!: () => void;
  vegaRandomQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  const originalRandom = vegaRandomApi.random;
  vegaRandomApi.setRandom(seededRandom(seed));
  try {
    return await render();
  } finally {
    vegaRandomApi.setRandom(originalRandom);
    release();
  }
}
const MAX_FIGURE_DATA_ROWS = 100_000;
const MAX_FIGURE_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_FIGURE_TOTAL_OUTPUT_BYTES = 128 * 1024 * 1024;
const MAX_FIGURE_PIXELS = 32_000_000;
const MAX_FIGURE_DATA_BYTES = 256 * 1024 * 1024;

type PlainObject = Record<string, unknown>;
type FigureJobPaths = { root: string; output: string };

type RenderBudget = { inputBytes: number; inputRows: number; inputFiles: Set<string>; outputBytes: number };

function fail(code: string): never {
  throw new ResearchProcessError(code);
}

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPathInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function readBoundedFile(root: string, relativePath: string, limit: number): Promise<Buffer> {
  if (isAbsolute(relativePath) || relativePath.includes('\\') || relativePath.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    return fail('research_figure_path_invalid');
  }
  const realRoot = await realpath(root);
  const candidate = resolve(realRoot, relativePath);
  if (!isPathInside(realRoot, candidate)) return fail('research_figure_path_invalid');
  const info = await lstat(candidate).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) return fail('research_figure_file_missing');
  if (info.size > limit) return fail('research_figure_file_too_large');
  const resolved = await realpath(candidate);
  if (!isPathInside(realRoot, resolved)) return fail('research_figure_path_invalid');
  return await readFile(resolved);
}

function inferredFormat(url: string, declared: unknown): Format {
  const extension = extname(url).toLowerCase();
  const declaredRecord = isPlainObject(declared) ? declared : {};
  const type = typeof declaredRecord.type === 'string'
    ? declaredRecord.type
    : extension === '.csv' ? 'csv'
      : extension === '.tsv' ? 'tsv'
        : extension === '.json' ? 'json' : null;
  if (type === 'csv' || type === 'tsv') {
    const format: FormatSV = { type };
    if (Array.isArray(declaredRecord.header) && declaredRecord.header.every((value) => typeof value === 'string')) {
      format.header = declaredRecord.header;
    }
    return format;
  }
  if (type === 'json') {
    const format: FormatJSON = { type };
    if (typeof declaredRecord.property === 'string') format.property = declaredRecord.property;
    return format;
  }
  if (type === 'dsv') {
    if (typeof declaredRecord.delimiter !== 'string' || declaredRecord.delimiter.length !== 1 || /[\u0000\r\n"]/u.test(declaredRecord.delimiter)) {
      return fail('research_figure_data_format_invalid');
    }
    const format: FormatDSV = { type: 'dsv', delimiter: declaredRecord.delimiter };
    if (Array.isArray(declaredRecord.header) && declaredRecord.header.every((value) => typeof value === 'string')) {
      format.header = declaredRecord.header;
    }
    return format;
  }
  return fail('research_figure_data_format_unsupported');
}

async function inlineDataSources(
  value: unknown,
  root: string,
  allowedInputs: ReadonlyMap<string, string>,
  cache: Map<string, unknown[]>,
  budget: RenderBudget,
  depth = 0,
): Promise<unknown> {
  if (depth > MAX_FIGURE_SPEC_DEPTH) return fail('research_figure_spec_depth_limit');
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const item of value) result.push(await inlineDataSources(item, root, allowedInputs, cache, budget, depth + 1));
    return result;
  }
  if (!isPlainObject(value)) return value;

  const result: PlainObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'data' && isPlainObject(child) && Array.isArray(child.values)) {
      budget.inputRows += child.values.length;
      if (budget.inputRows > MAX_FIGURE_DATA_ROWS) return fail('research_figure_data_row_limit');
      result[key] = child;
      continue;
    }
    if (key === 'datasets' && isPlainObject(child)) {
      budget.inputRows += Object.values(child).reduce<number>((count, rows) => count + (Array.isArray(rows) ? rows.length : 0), 0);
      if (budget.inputRows > MAX_FIGURE_DATA_ROWS) return fail('research_figure_data_row_limit');
      result[key] = child;
      continue;
    }
    if (key === 'data' && isPlainObject(child) && typeof child.url === 'string') {
      const url = child.url;
      if (/^[a-z][a-z\d+.-]*:/iu.test(url) || url.startsWith('//') || isAbsolute(url)) {
        return fail('research_figure_remote_data_denied');
      }
      const snapshotPath = allowedInputs.get(url);
      if (snapshotPath === undefined) return fail('research_figure_data_not_declared');
      const format = inferredFormat(url, child.format);
      const cacheKey = `${url}\u0000${JSON.stringify(format)}`;
      let rows = cache.get(cacheKey);
      if (!rows) {
        const bytes = await readBoundedFile(root, snapshotPath, 64 * 1024 * 1024);
        if (!budget.inputFiles.has(snapshotPath)) {
          budget.inputBytes += bytes.byteLength;
          budget.inputFiles.add(snapshotPath);
          if (budget.inputBytes > MAX_FIGURE_DATA_BYTES) return fail('research_figure_data_total_too_large');
        }
        const text = bytes.toString('utf8');
        try {
          const valueRows = read(text, format);
          if (Array.isArray(valueRows)) rows = valueRows;
          else if (isPlainObject(valueRows)) rows = [valueRows];
          else return fail('research_figure_data_invalid');
        } catch (error) {
          if (error instanceof ResearchProcessError) throw error;
          return fail('research_figure_data_invalid');
        }
        cache.set(cacheKey, rows);
      }
      budget.inputRows += rows.length;
      if (budget.inputRows > MAX_FIGURE_DATA_ROWS) return fail('research_figure_data_row_limit');
      const inlineData: PlainObject = { ...child, values: structuredClone(rows) };
      delete inlineData.url;
      delete inlineData.format;
      result[key] = inlineData;
      continue;
    }
    result[key] = await inlineDataSources(child, root, allowedInputs, cache, budget, depth + 1);
  }
  return result;
}

function assertOfflineSpec(value: unknown, path = 'spec', depth = 0): void {
  if (depth > MAX_FIGURE_SPEC_DEPTH) return fail('research_figure_spec_depth_limit');
  if (Array.isArray(value)) {
    if (path === 'spec.datasets' || path.startsWith('spec.datasets.') || path.endsWith('.values')) return;
    for (const child of value) assertOfflineSpec(child, path, depth + 1);
    return;
  }
  if (!isPlainObject(value)) return;
  if (Object.hasOwn(value, 'url')) return fail('research_figure_remote_data_denied');
  if (Object.hasOwn(value, 'href')) return fail('research_figure_external_link_denied');
  if (value.mark === 'image' || (isPlainObject(value.mark) && value.mark.type === 'image')) {
    return fail('research_figure_external_image_denied');
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'values' || key === 'datasets') continue;
    assertOfflineSpec(child, `${path}.${key}`, depth + 1);
  }
}

function svgDimensions(svg: string): { width: number; height: number } {
  const root = svg.match(/<svg\b([^>]*)>/iu)?.[1];
  if (!root) return fail('research_figure_svg_invalid');
  const attribute = (name: string): number | null => {
    const value = root.match(new RegExp(`\\b${name}=["']([^"']+)["']`, 'iu'))?.[1];
    if (value === undefined) return null;
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.ceil(parsed) : null;
  };
  let width = attribute('width');
  let height = attribute('height');
  if (width !== null && height !== null) return { width, height };
  const viewBox = root.match(/\bviewBox=["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)\s*["']/iu);
  if (viewBox) {
    width ??= Math.ceil(Number(viewBox[1]));
    height ??= Math.ceil(Number(viewBox[2]));
  }
  if (width === null || height === null || width < 1 || height < 1) return fail('research_figure_svg_dimensions_invalid');
  return { width, height };
}

async function writeOutput(paths: FigureJobPaths, name: string, bytes: Buffer, budget: RenderBudget): Promise<{ path: 'figure.png' | 'figure.svg' | 'figure.pdf'; size: number; sha256: string }> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_FIGURE_OUTPUT_BYTES) return fail('research_figure_output_too_large');
  budget.outputBytes += bytes.byteLength;
  if (budget.outputBytes > MAX_FIGURE_TOTAL_OUTPUT_BYTES) return fail('research_figure_outputs_total_too_large');
  await writeFile(resolve(paths.output, name), bytes, { flag: 'wx', mode: 0o600 });
  return {
    path: name as 'figure.png' | 'figure.svg' | 'figure.pdf',
    size: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export async function renderResearchFigure(input: ResearchFigureRenderJob, signal?: AbortSignal): Promise<{ engine: 'vega-lite'; rendererHash: string; outputs: Array<{ path: 'figure.png' | 'figure.svg' | 'figure.pdf'; size: number; sha256: string }>; sourceHash: string }> {
  const request = researchFigureRenderJobSchema.parse(input);
  return withSeededVegaRandom(request.figure.seed, () => runResearchJob({
    projectRoot: request.projectRoot,
    sourcePath: request.sourcePath,
    outputDir: request.outputDir,
    maxSourceBytes: MAX_FIGURE_SPEC_BYTES,
    timeoutMs: request.timeoutMs,
    signal,
  }, async (paths) => {
    const specBytes = await readBoundedFile(paths.root, request.sourcePath, MAX_FIGURE_SPEC_BYTES);
    let parsedSpec: unknown;
    try {
      parsedSpec = JSON.parse(specBytes.toString('utf8')) as unknown;
    } catch {
      return fail('research_figure_spec_invalid');
    }
    if (!isPlainObject(parsedSpec)) return fail('research_figure_spec_invalid');
    if (!request.sourcePath.toLowerCase().endsWith('.vl.json')) return fail('research_figure_source_type_invalid');
    const budget: RenderBudget = { inputBytes: 0, inputRows: 0, inputFiles: new Set(), outputBytes: 0 };
    const allowedInputs = new Map(request.inputPaths.map((inputPath) => [inputPath, `input/${inputPath}`]));
    const inlineSpec = await inlineDataSources(parsedSpec, paths.root, allowedInputs, new Map(), budget);
    assertOfflineSpec(inlineSpec);
    if (!isPlainObject(inlineSpec)) return fail('research_figure_spec_invalid');

    const baseWidth = request.figure.widthInches * 72;
    const baseHeight = request.figure.heightInches * 72;
    const spec = { ...inlineSpec, width: baseWidth, height: baseHeight } as TopLevelSpec;
    let svg: string;
    const view = new View(parse(compile(spec).spec), { renderer: 'none', loader: loader() });
    try {
      await view.runAsync();
      svg = await view.toSVG(request.figure.dpi / 72);
    } catch {
      return fail('research_figure_render_failed');
    } finally {
      view.finalize();
    }

    const dimensions = svgDimensions(svg);
    if (dimensions.width * dimensions.height > MAX_FIGURE_PIXELS) return fail('research_figure_pixel_limit');
    const svgBytes = Buffer.from(svg, 'utf8');
    if (svgBytes.byteLength > MAX_FIGURE_OUTPUT_BYTES) return fail('research_figure_output_too_large');
    const image = await loadImage(svgBytes);
    const pngCanvas = createCanvas(dimensions.width, dimensions.height);
    const pngContext = pngCanvas.getContext('2d');
    pngContext.drawImage(image, 0, 0, dimensions.width, dimensions.height);
    const pngBytes = pngCanvas.toBuffer('image/png');

    const widthPoints = dimensions.width * 72 / request.figure.dpi;
    const heightPoints = dimensions.height * 72 / request.figure.dpi;
    const pdf = new PDFDocument({ title: request.label, creator: 'Roc', producer: '@napi-rs/canvas', rasterDPI: request.figure.dpi });
    const pdfContext = pdf.beginPage(widthPoints, heightPoints);
    // SAFETY: `PDFDocument.beginPage()` returns Skia's drawing context at runtime, although the declaration exposes the DOM base type.
    (pdfContext as import('@napi-rs/canvas').SKRSContext2D).drawImage(image, 0, 0, widthPoints, heightPoints);
    pdf.endPage();
    const pdfBytes = pdf.close();

    await mkdir(paths.output, { recursive: true });
    const outputs = [
      await writeOutput(paths, 'figure.png', pngBytes, budget),
      await writeOutput(paths, 'figure.svg', svgBytes, budget),
      await writeOutput(paths, 'figure.pdf', pdfBytes, budget),
    ];
    const environment = getResearchFigureRendererEnvironment();
    return researchFigureRenderResultSchema.parse({ engine: 'vega-lite', rendererHash: environment.hash, outputs });
  }));
}
