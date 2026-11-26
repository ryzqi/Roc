import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {materializeScannedSource} from '../tests/fixtures/research-scanned-source.mjs';
import {importTypeScriptModule} from './lib/bundle-ts.mjs';
import {makeReport, sha256} from './performance/report-lib.mjs';

assert.ok([3, 4].includes(process.argv.length),
  'Usage: node scripts/benchmark-scientific-sustained.mjs NEW_OUTPUT_DIRECTORY [EXISTING_100_PAGE_PDF]');
const root = resolve(process.argv[2]);
await mkdir(root, {recursive: false});
const save = (name, value) => writeFile(join(root, name), JSON.stringify(value, null, 2) + '\n', {flag: 'wx'});
const sourcePath = join(root, 'scanned-100.pdf');
if (process.argv[3]) {
  await writeFile(sourcePath, await readFile(resolve(process.argv[3])), {flag: 'wx'});
} else {
  const source = await materializeScannedSource(join(root, 'source'));
  const original = await PDFDocument.load(await readFile(source.sourcePath));
  const long = await PDFDocument.create();
  // Repeat the three independently defined raster pages. This is a workload,
  // not a hundred-paper dataset or a recognition-quality experiment.
  const pages = await long.copyPages(original, Array.from({length: 100}, (_, index) => index % 3));
  for (const page of pages) long.addPage(page);
  await writeFile(sourcePath, await long.save(), {flag: 'wx'});
}
const sourceHash = sha256(await readFile(sourcePath));
const report = makeReport('scientific-sustained-ocr', {pages: 100, sourceHash, tier: 'compact', device: 'cpu',
  tailPages: 40, rssScreenGrowthBytes: 256 * 1024 * 1024, rssScreenSlopeBytesPerPage: 1024 * 1024},
['src/main/plugins/research/document-parser.ts', 'src/main/plugins/research/ocr-stage-sessions.ts',
  'scripts/benchmark-scientific-sustained.mjs']);
const opts = {platform: 'node', external: ['onnxruntime-node', 'paddleocr',
  '@napi-rs/canvas', 'pdfjs-dist', 'zod', 'sharp', 'utif', 'htmlparser2'], tempDir: '.runtime/performance'};
const {parseResearchDocument} = await importTypeScriptModule('src/main/plugins/research/document-parser.ts', opts);
const {ResearchModelStore} = await importTypeScriptModule('src/main/plugins/research/model-store.ts', opts);
const models = new ResearchModelStore(resolve('.runtime/research-models'));
const lease = await models.requireReady('compact');
const samples = [], started = performance.now();
try {
  const parsed = await parseResearchDocument({projectRoot: resolve('.'), sourcePath, outputDir: join(root, 'output'),
    options: {tier: 'compact', device: 'cpu', pageRange: ''}, modelFiles: lease.files, modelManifest: lease.manifest,
    signal: AbortSignal.timeout(900000), onStage: event => {
      if (event.stage !== 'ocr-inference') return;
      const sample = {...event, elapsedMs: performance.now() - started, ...process.memoryUsage()};
      samples.push(sample);
      if (samples.length % 10 === 0) console.log(JSON.stringify({pages: samples.length, rss: sample.rss}));
    }});
  assert.equal(parsed.pageCount, 100);
  assert.equal(samples.length, 100);
  assert.equal(parsed.sourceHash, sourceHash);
  assert.equal(sha256(await readFile(sourcePath)), sourceHash);
  assert.equal(parsed.parseMode, 'ocr');
  await save('parsed.json', parsed);
  const tail = samples.slice(-40), mean = tail.reduce((sum, row) => sum + row.rss, 0) / tail.length;
  const midpoint = (tail.length - 1) / 2;
  const slope = tail.reduce((sum, row, index) => sum + (index - midpoint) * (row.rss - mean), 0) /
    tail.reduce((sum, _, index) => sum + (index - midpoint) ** 2, 0);
  const growth = tail.at(-1).rss - tail[0].rss;
  report.observations = {elapsedMs: performance.now() - started, peakRssBytes: process.resourceUsage().maxRSS * 1024,
    final: process.memoryUsage(), tailGrowthBytes: growth, tailSlopeBytesPerPage: slope,
    boundedGrowthScreenPassed: growth <= report.fixture.rssScreenGrowthBytes &&
      slope <= report.fixture.rssScreenSlopeBytesPerPage, modelManifest: lease.manifest};
  report.scenarios.push({id: 'scanned-100', samples});
  report.limitations.push('One 100-page controlled raster workload; repeated pages are not independent scientific samples.',
    'Page-boundary RSS includes retained output and native allocator caches. The bounded-growth screen is not proof of zero leaks.',
    'No forced GC, OS cache flush, or quality improvement claim. Failure remains recorded for investigation.');
  await save('report.json', report);
  console.log(JSON.stringify(report.observations));
  assert.ok(report.observations.boundedGrowthScreenPassed, 'sustained OCR memory screen exceeded');
} finally {models.release(lease.pack);}
