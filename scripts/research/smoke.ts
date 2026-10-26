import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createCanvas } from '@napi-rs/canvas';
import { getDocument, type PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { ResearchModelStore, type ResearchModelLease } from '../../src/main/plugins/research/model-store.ts';
import { pdfjsAssetDirectory } from '../../src/main/plugins/research/pdfjs-assets.ts';
import { verifyManifest, type Manifest } from './manifest.ts';
import { decodeJson } from '../lib/decode-json.ts';

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(import.meta.url);
const TSX_CLI = require.resolve('tsx/cli');
const PARSER_CLI = join(PROJECT_ROOT, 'src/main/plugins/research/research-job-cli.ts');

export const OFFLINE_PROFILE = '(version 1)(allow default)(deny network*)';

type SmokeParseOptions = { tier: 'compact' | 'complete'; pageRange: string; device: 'coreml' | 'cpu' };
type SmokeParseResult = {
  content: string;
  pageCount: number;
  blocks: Array<{ kind: string; text?: string }>;
  warnings: unknown;
};

const smokeOptions = (tier: SmokeParseOptions['tier'], pageRange = ''): SmokeParseOptions => ({
  tier, pageRange, device: 'coreml'
});
export const LATEX = "\\documentclass[fontset=fandol]{ctexart}\n\\usepackage{amsmath,booktabs,graphicx}\n\\begin{document}\n\\section{\u7814\u7a76\u6570\u636e\u4e0e\u65b9\u6cd5 Research methods}\nThis experiment compares control and treatment groups.\n\\begin{table}[h]\n\\centering\n\\caption{Study participants and results}\n\\begin{tabular}{lrr}\n\\toprule\nGroup & Patients & Improvement \\\\\n\\midrule\nControl & 12 & 10 \\\\\nTreatment & 18 & 50 \\\\\n\\bottomrule\n\\end{tabular}\n\\end{table}\nThe energy equation is:\n\\begin{equation}E = mc^2\\end{equation}\n\\begin{figure}[h]\n\\centering\n\\includegraphics[width=0.65\\textwidth]{figure.png}\n\\caption{Measured improvement by study group.}\n\\end{figure}\n\\end{document}\n";

type SmokeResult = {
  architecture: string;
  versions: Manifest['versions'];
  network: 'denied';
  pageCount: number;
  blockKinds: string[];
  blockCount: number;
  warnings: unknown;
  nativePdfBlocks: number;
  htmlBlocks: number;
  figures: string[];
  integrity: 'passed';
};

function fail(code: string): never {
  throw new Error(code);
}

async function pathInfo(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function renderSmokePdf(sourcePath: string, outputDir: string): Promise<{ path: string; text: string; pageCount: number }> {
  const bytes = await readFile(sourcePath);
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
    const page: PDFPageProxy = await pdf.getPage(1);
    try {
      const viewport = page.getViewport({ scale: 2 });
      const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
      await page.render({ canvasContext: canvas.getContext('2d'), viewport, canvas } as never).promise;
      const target = join(outputDir, 'page-1.png');
      await mkdir(outputDir, { recursive: true });
      await writeFile(target, await canvas.encode('png'));
      const textContent = await page.getTextContent();
      const text = textContent.items.map((item) => 'str' in item ? String(item.str) : '').join('').replaceAll('\r\n', '\n');
      return { path: target, text, pageCount: pdf.numPages };
    } finally {
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
}

function smokeEnvironment(toolchain: string, temporary: string, cache: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ['HOME', 'USER', 'LOGNAME', 'LANG'] as const) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  environment.PATH = `${toolchain}/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
  environment.TMPDIR = temporary;
  environment.XDG_CACHE_HOME = cache;
  environment.TECTONIC_CACHE_DIR = join(cache, 'tectonic');
  return environment;
}

async function runLabeled(
  output: string,
  environment: NodeJS.ProcessEnv,
  label: string,
  command: string[],
  options: { request?: unknown; timeoutMs?: number } = {}
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  const stdout = await new Promise<string>((resolvePromise, reject) => {
    const child = spawn('/usr/bin/sandbox-exec', ['-p', OFFLINE_PROFILE, ...command], {
      cwd: output,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`research_smoke_failed:${label}:timeout`));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', async (code) => {
      clearTimeout(timer);
      const stdoutText = Buffer.concat(out).toString('utf8');
      const stderrText = Buffer.concat(err).toString('utf8');
      try {
        await writeFile(join(output, `${label}.stdout.log`), stdoutText, 'utf8');
        await writeFile(join(output, `${label}.stderr.log`), stderrText, 'utf8');
      } catch (error) {
        reject(error);
        return;
      }
      if (code !== 0) {
        reject(new Error(`research_smoke_failed:${label}:exit=${code}; logs=${output}`));
        return;
      }
      console.log(`通过：${label}`);
      resolvePromise(stdoutText);
    });
    if (options.request !== undefined) child.stdin.write(JSON.stringify(options.request));
    child.stdin.end();
  });
  return stdout;
}

export async function smoke(toolchainPath: string, outputPath: string): Promise<SmokeResult> {
  return await smokeWithModels(toolchainPath, outputPath, resolve(PROJECT_ROOT, '.runtime/research-models'));
}

export async function smokeWithModels(toolchainPath: string, outputPath: string, modelsPath: string): Promise<SmokeResult> {
  const toolchain = await realpath(toolchainPath);
  const manifest = await verifyManifest(toolchain);
  if (await pathInfo(outputPath) !== null) fail('research_smoke_output_exists');
  await mkdir(outputPath, { recursive: true });
  const output = await realpath(outputPath);
  const modelStore = new ResearchModelStore(await realpath(modelsPath));
  const modelSet = await modelStore.requireReady('complete');
  const cache = join(output, 'cache');
  const temporary = join(cache, 'tmp');
  await mkdir(temporary, { recursive: true });
  const environment = smokeEnvironment(toolchain, temporary, cache);
  const run = (
    label: string,
    command: string[],
    options?: { request?: unknown; timeoutMs?: number }
  ): Promise<string> => runLabeled(output, environment, label, command, options);
  const parseDocument = async (
    label: string,
    sourcePath: string,
    outputDir: string,
    options: SmokeParseOptions,
    models: ResearchModelLease | null
  ): Promise<SmokeParseResult> => {
    const response = decodeJson<{ ok: boolean; result: SmokeParseResult }>(
      await run(label, [process.execPath, TSX_CLI, PARSER_CLI], {
        request: {
          operation: 'parse_document', projectRoot: output, sourcePath, outputDir, options,
          modelFiles: models?.files ?? null, modelManifest: models?.manifest ?? ''
        }
      }),
      'research_smoke_parser_output_corrupt'
    );
    if (!response.ok) fail('research_smoke_parse_failed');
    return response.result;
  };

  const figureInput = join(output, 'input');
  await mkdir(figureInput, { recursive: true });
  await writeFile(join(figureInput, 'results.csv'), 'Group,Improvement\nControl,10\nTreatment,50\n', 'utf8');
  const figureSpec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    data: { url: 'results.csv' },
    mark: { type: 'bar', color: '#20736b' },
    encoding: {
      x: { field: 'Group', type: 'nominal' },
      y: { field: 'Improvement', type: 'quantitative', title: 'Improvement (percent)' },
      tooltip: [{ field: 'Group', type: 'nominal' }, { field: 'Improvement', type: 'quantitative' }]
    }
  };
  await writeFile(join(figureInput, 'figure.vl.json'), `${JSON.stringify(figureSpec, null, 2)}\n`, 'utf8');
  const figureOutput = join(output, 'vega-render');
  const figureReply = decodeJson<{ ok: boolean; result: { outputs: Array<{ path: string }> } }>(
    await run('vega-figure', [process.execPath, TSX_CLI, PARSER_CLI], {
      request: {
        operation: 'render_figure', projectRoot: output, sourcePath: 'input/figure.vl.json', outputDir: figureOutput,
        inputPaths: ['results.csv'], label: 'Measured improvement by study group.', timeoutMs: 120_000,
        figure: { widthInches: 5, heightInches: 2.5, dpi: 180, seed: 7 }
      }
    }),
    'research_smoke_figure_output_corrupt'
  );
  if (!figureReply.ok || figureReply.result.outputs.length !== 3) fail('research_smoke_figure_failed');
  for (const [extension, signature] of [['png', Buffer.from([0x89, 0x50, 0x4e, 0x47])], ['pdf', Buffer.from('%PDF')]] as const) {
    const bytes = await readFile(join(figureOutput, `figure.${extension}`));
    if (!bytes.subarray(0, signature.length).equals(signature)) fail(`research_smoke_figure_invalid:${extension}`);
    await writeFile(join(output, `figure.${extension}`), bytes);
  }
  const svgBytes = await readFile(join(figureOutput, 'figure.svg'));
  if (!svgBytes.toString('utf8', 0, 512).includes('<svg')) fail('research_smoke_figure_invalid:svg');
  await writeFile(join(output, 'figure.svg'), svgBytes);
  await writeFile(join(output, 'paper.tex'), LATEX, 'utf8');
  const compiled = join(output, 'compiled');
  await mkdir(compiled);
  await run('latex', [
    join(toolchain, 'bin/tectonic'), '--bundle', join(toolchain, 'tex/bundle.zip'), '--only-cached',
    '--untrusted', '--keep-logs', '--outdir', compiled, 'paper.tex'
  ], { timeoutMs: 180_000 });
  const pdf = join(compiled, 'paper.pdf');
  if (!(await readFile(pdf)).subarray(0, 4).equals(Buffer.from('%PDF'))) fail('research_smoke_pdf_invalid');
  const rendered = await renderSmokePdf(pdf, join(output, 'rendered'));
  await writeFile(join(output, 'render.stdout.log'), `${JSON.stringify({ path: rendered.path, text: rendered.text, pageCount: rendered.pageCount })}\n`, 'utf8');
  console.log('通过：render');
  if (!rendered.text.includes('研究数据与方法')) fail('research_smoke_pdf_text_missing');
  const parsed = await parseDocument(
    'ocr-table-formula', rendered.path, join(output, 'parsed'), smokeOptions('complete'), modelSet
  );
  const content = parsed.content;
  const kinds = new Set(parsed.blocks.map((block) => block.kind));
  // The rendered PDF page is sent through the native PaddleOCR + ONNX pipeline. Assert table cells from the table block itself because Control is also a chart label.
  const tableText = parsed.blocks.find((block) => block.kind === 'table')?.text ?? '';
  const tableCellsKept = ['Control', 'Patients', '18', 'Improvement'].every((token) => tableText.includes(token));
  if (!content.includes('研究数据与方法') || !tableCellsKept
      || !['table', 'formula', 'figure'].every((kind) => kinds.has(kind))) {
    fail(`research_smoke_parse_content_incomplete:${[...kinds].sort().join(',')}`);
  }
  await writeFile(join(output, 'parse-result.json'), `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  const native = await parseDocument(
    'native-pdf', pdf, join(output, 'parsed-pdf'), smokeOptions('complete'), modelSet
  );
  if (!native.content.includes('Treatment') || native.pageCount !== 1) {
    fail('research_smoke_native_pdf_incomplete');
  }
  const html = join(output, 'paper.html');
  await writeFile(html, '<html><body><h1>研究方法</h1><p>Local HTML evidence.</p>'
    + '<table><tr><th>Group</th><th>Patients</th></tr><tr><td>Treatment</td><td>18</td></tr></table>'
    + '</body></html>', 'utf8');
  const parsedHtml = await parseDocument(
    'html', html, join(output, 'parsed-html'), smokeOptions('compact'), null
  );
  if (!parsedHtml.content.includes('研究方法') || !parsedHtml.content.includes('18')) {
    fail('research_smoke_html_incomplete');
  }
  await verifyManifest(toolchain);
  const result: SmokeResult = {
    architecture: manifest.architecture,
    versions: manifest.versions,
    network: 'denied',
    pageCount: rendered.pageCount,
    blockKinds: [...kinds].sort(),
    blockCount: parsed.blocks.length,
    warnings: parsed.warnings,
    nativePdfBlocks: native.blocks.length,
    htmlBlocks: parsedHtml.blocks.length,
    figures: ['png', 'svg', 'pdf'],
    integrity: 'passed'
  };
  await writeFile(join(output, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(result));
  return result;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { toolchain: { type: 'string' }, output: { type: 'string' }, models: { type: 'string' } },
    strict: true
  });
  if (values.toolchain === undefined || values.toolchain === '' || values.output === undefined || values.output === '') {
    fail('research_smoke_arguments_required');
  }
  const models = values.models === undefined || values.models === ''
    ? resolve(PROJECT_ROOT, '.runtime/research-models') : values.models;
  await smokeWithModels(values.toolchain, values.output, models);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
