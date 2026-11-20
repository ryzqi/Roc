import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {importTypeScriptModule} from '../lib/bundle-ts.mjs';
import {createPerformancePdf} from '../lib/research-pdf-performance-fixture.mjs';
import {makeReport, readArguments, saveReport, sha256, summarizeRows} from './report-lib.mjs';

const bytes = createPerformancePdf();
async function rasterSample(pages) {
  const {withResearchPdf, renderResearchPdfPage} = await importTypeScriptModule(
    'src/main/plugins/research/pdf-render.ts', {platform: 'node',
      external: ['@napi-rs/canvas', 'pdfjs-dist/legacy/build/pdf.mjs'], tempDir: '.runtime/performance'});
  const root = await mkdtemp(join(tmpdir(), 'roc-page-raster-'));
  const canvases = [], output = createHash('sha256');
  const canvasBytes = () => canvases.reduce((sum, ref) => {
    const canvas = ref.deref();
    return sum + (canvas === undefined ? 0 : canvas.width * canvas.height * 4);
  }, 0);
  globalThis.gc?.();
  const baseline = process.memoryUsage(), cpu = process.cpuUsage(), started = performance.now();
  const result = {pages, renderCalls: 0, pngBytes: 0, rgbaBytes: 0, peakCanvasBytes: 0,
    peakRssBytes: baseline.rss, peakExternalBytes: baseline.external, peakArrayBuffersBytes: baseline.arrayBuffers};
  const sampleMemory = () => {
    const memory = process.memoryUsage();
    result.peakRssBytes = Math.max(result.peakRssBytes, memory.rss);
    result.peakExternalBytes = Math.max(result.peakExternalBytes, memory.external);
    result.peakArrayBuffersBytes = Math.max(result.peakArrayBuffersBytes, memory.arrayBuffers);
    result.peakCanvasBytes = Math.max(result.peakCanvasBytes, canvasBytes());
  };
  try {
    await withResearchPdf(Uint8Array.from(bytes), async pdf => {
      for (let number = 1; number <= pages; number++) {
        const page = await pdf.getPage(number), render = page.render.bind(page);
        page.render = options => {
          canvases.push(new WeakRef(options.canvas)); result.renderCalls++;
          return render(options);
        };
        try {
          const image = await renderResearchPdfPage(page, number, pdf.numPages, root, 1.5, true,
            undefined, {includeRgbaImage: true, onStage: sampleMemory});
          assert.ok(image.image);
          sampleMemory();
          const png = await readFile(image.path);
          result.pngBytes += png.length; result.rgbaBytes += image.image.data.byteLength;
          output.update(JSON.stringify({page: number, text: image.text, width: image.width, height: image.height,
            frame: image.coordinateFrame, png: sha256(png), rgba: sha256(image.image.data)}));
          image.image = null;
        } finally {page.cleanup();}
      }
    });
    result.retainedCanvasBytes = canvasBytes();
    result.outputDigest = output.digest('hex');
    result.elapsedMs = performance.now() - started;
    const used = process.cpuUsage(cpu);
    result.cpuUserMicros = used.user; result.cpuSystemMicros = used.system;
    result.rssGrowthBytes = result.peakRssBytes - baseline.rss;
    return result;
  } finally {await rm(root, {recursive: true, force: true});}
}

if (process.argv[2] === '--worker') {
  const pages = Number(process.argv[3]);
  assert.ok(pages === 100 || pages === 400);
  console.log(JSON.stringify({performanceResult: await rasterSample(pages)}));
} else {
  const options = readArguments('.artifacts/mac-performance/mac-pdf-raster.json');
  const report = makeReport('pdf-raster', {pdfSha256: sha256(bytes), pageCounts: [100, 400],
    scale: 1.5, png: 'required', rgba: true, samples: options.samples},
  ['src/main/plugins/research/pdf-render.ts', 'src/main/plugins/research/document-parser.ts']);
  for (const pages of [100, 400]) {
    const samples = [];
    for (let sample = 0; sample < options.samples; sample++) {
      const child = spawn(process.execPath, ['--expose-gc', import.meta.filename, '--worker', String(pages)],
        {stdio: ['ignore', 'pipe', 'pipe'], shell: false});
      let stdout = '', stderr = '';
      child.stdout.on('data', bytes => {stdout += bytes;});
      child.stderr.on('data', bytes => {stderr += bytes;});
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject); child.once('exit', resolve);
      });
      assert.equal(code, 0, stderr);
      const row = JSON.parse(stdout.trim().split('\n').at(-1)).performanceResult;
      assert.equal(row.renderCalls, pages);
      if (samples.length > 0) assert.equal(row.outputDigest, samples[0].outputDigest);
      samples.push(row);
      console.log(JSON.stringify({pages, sample: sample + 1, elapsedMs: row.elapsedMs,
        peakRssBytes: row.peakRssBytes, retainedCanvasBytes: row.retainedCanvasBytes}));
    }
    report.scenarios.push({id: `${pages}-page-raster`, samples, summary: summarizeRows(samples),
      behaviorSha256: samples[0].outputDigest});
    saveReport(options.outputPath, report);
  }
  report.limitations.push('Actual PDF.js/native canvas pages are deliberately rasterized with PNG and RGBA even though the text-only parser can omit images.',
    'Canvas bytes are logical pixel dimensions of live weak references, not macOS footprint or an immediate allocator-return claim.',
    'Peak native RSS/external is observed at real stage boundaries; a fresh process runs every sample.',
    'PNG, RGBA, text and coordinate digests must match across all samples and before/after.');
  console.log(saveReport(options.outputPath, report));
}
