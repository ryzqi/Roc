import assert from 'node:assert/strict';
import { _electron as electron } from '@playwright/test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { importTypeScriptModule } from '../lib/bundle-ts.mjs';
import { createPerformancePdf } from '../lib/research-pdf-performance-fixture.mjs';
import { waitForAppReady } from '../../tests/smoke/lib/assertions.mjs';
import { observeElectronLoop, sampleElectronProcesses } from './electron-metrics.mjs';
import { makeReport, readArguments, saveReport, sha256, summarizeRows } from './report-lib.mjs';
import {measureRendererWorkload} from './renderer-workload-metrics.mjs';

const options = readArguments('.artifacts/mac-performance/reader-before.json');
const nativeReopen = process.env.ROC_PERF_PDF_BACKGROUND_REOPEN === '1';
const nativeReopenHiddenMs = Number(process.env.ROC_PERF_PDF_HIDDEN_MS ?? 0);
assert.ok(Number.isFinite(nativeReopenHiddenMs) && nativeReopenHiddenMs >= 0, 'hidden_duration_invalid');
const pageTurns = Number(process.env.ROC_PERF_PDF_PAGE_TURNS ?? 0);
assert.ok(Number.isSafeInteger(pageTurns) && pageTurns >= 0 && pageTurns < 400, 'pdf_page_turns_invalid');
const referenceRenderer = process.env.ROC_PERF_PDF_REFERENCE_RENDERER;
const rendererRoot = resolve(referenceRenderer ?? 'dist/renderer');
assert.ok(referenceRenderer === undefined || nativeReopen, 'reference_renderer_requires_reopen_scenario');
const viewport = { width: 900, height: 900 };
const nativeReopenViewport = nativeReopen ? { width: 1400, height: 900 } : null;
const bytes = createPerformancePdf();
const report = makeReport('pdf-reader', { pdfSha256: sha256(bytes), pages: 400, samples: options.samples,
  viewport, nativeReopenViewport, backgroundOperation: 'parseDocument', ipcOperation: 'app.getStatus',
  nativeReopen, nativeReopenHiddenMs, ...(pageTurns > 0 ? {pageTurns} : {}), nativeReopenInputProbe: nativeReopen ? 'shell-and-pdf' : null },
['src/renderer/literature/PaperPdfView.tsx', 'src/main/pdf-preview-protocol.ts',
  'scripts/performance/bench-pdf-reader.mjs', 'scripts/performance/renderer-workload-metrics.mjs',
  'src/main/plugins/research/document-service.ts', 'dist/main/index.js', 'dist/preload/index.cjs']);
report.rendererBuild = {
  variant: referenceRenderer === undefined ? 'current' : 'frozen-pr-10-reader',
  entrySha256: sha256(readFileSync(join(rendererRoot, 'index.html'))),
  manifestSha256: sha256(readFileSync(join(rendererRoot, '.vite/manifest.json'))),
  readerSourceSha256: sha256(readFileSync(referenceRenderer === undefined ?
    'src/renderer/literature/PaperPdfView.tsx' : 'tests/fixtures/performance/legacy-background-paper-pdf-view.tsx'))
};
const root = mkdtempSync(join(tmpdir(), 'roc-reader-performance-'));
mkdirSync(dirname(resolve(options.outputPath)), { recursive: true });
const artifactRoot = process.env.ROC_PERF_KEEP_ARTIFACTS === '1'
  ? mkdtempSync(join(dirname(resolve(options.outputPath)), 'reader-artifacts-')) : join(root, 'diagnostics');
mkdirSync(artifactRoot, {recursive: true});
if (process.env.ROC_PERF_KEEP_ARTIFACTS === '1') report.artifactRoot = artifactRoot;
let app, page;
try {
  const { seedPerformanceProfiles } = await importTypeScriptModule('tests/smoke/lib/performance-profile-seed.ts',
    { platform: 'node', external: ['better-sqlite3'], tempDir: resolve('.runtime/performance') });
  const roots = { empty: join(root, 'empty'), profile1000: join(root, '1000'), profile10000: join(root, '10000') };
  seedPerformanceProfiles(roots);
  const sourcePath = join(root, '400-pages.pdf');
  writeFileSync(sourcePath, bytes);
  app = await electron.launch({ args: [`--user-data-dir=${join(root, 'chromium')}`, resolve('dist/main/index.js')],
    env: { ...process.env, ROC_SMOKE: '1', ROC_DATA_ROOT: roots.empty,
      ...(referenceRenderer === undefined ? {} :
        {ELECTRON_RENDERER_URL: pathToFileURL(join(rendererRoot, 'index.html')).href}) } });
  await observeElectronLoop(app);
  page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await waitForAppReady(page, 'pdf-reader', artifactRoot);
  await page.evaluate(() => {
    window.__rocBenchmarkHidden = false;
    window.roc.window.onHidden(snapshot => { window.__rocBenchmarkHidden = snapshot.hidden; });
    const NativeWorker = window.Worker;
    window.__rocLiveWorkers = 0;
    window.Worker = class extends NativeWorker {
      constructor(...args) { super(...args); window.__rocLiveWorkers++; }
      terminate() {
        if (!this.__rocTerminated) { this.__rocTerminated = true; window.__rocLiveWorkers--; }
        return super.terminate();
      }
    };
    const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width');
    window.__rocRasterAllocations = 0;
    Object.defineProperty(HTMLCanvasElement.prototype, 'width', {
      ...descriptor, set(value) {
        if (value > 0 && this.dataset.testid === 'reader-pdf-canvas') window.__rocRasterAllocations++;
        descriptor.set.call(this, value);
      }
    });
  });
  await page.locator('[data-testid^="portal-card-open-"]').first().click();
  const projectId = 'project-performance-0';
  const imported = await page.evaluate(async input => await window.roc.research.importDocument(input),
    { target: 'new-item', projectId, sourcePath, title: 'Generated 400 page benchmark', citationKey: 'performance400' });
  assert.ok(imported.ok, JSON.stringify(imported));
  const document = imported.data;
  const navigate = async view => {
    await page.evaluate(({ projectId, view }) => {
      const url = new URL(location.href);
      url.searchParams.set('page', 'research'); url.searchParams.set('project', projectId); url.searchParams.set('view', view);
      history.pushState({}, '', url); dispatchEvent(new PopStateEvent('popstate'));
    }, { projectId, view });
  };
  const waitForPdf = async () => await page.waitForFunction(() => {
    const canvas = document.querySelector('[data-testid="reader-pdf-canvas"]');
    return canvas?.width > 0 && canvas.height > 0 && canvas.parentElement.style.visibility === 'visible';
  }, null, { timeout: 30_000 });
  const showSourcePdf = async () => {
    const control = page.getByTestId(referenceRenderer === undefined ? 'reader-original-pdf' : 'reader-compare-pdf');
    if (await control.getAttribute('aria-pressed') !== 'true') await control.click();
  };
  const rows = [], processSamples = [], requests = [];
  await navigate('literature');
  await page.getByTestId('literature-hub').waitFor();
  if (await page.getByTestId('context-drawer').isVisible()) await page.getByTestId('titlebar-toggle-sidebar').click();
  await page.getByTestId('literature-hub').getByTestId('literature-refresh').click();
  await page.setViewportSize(viewport);
  const picker = page.getByRole('combobox', { name: '选择当前文献', exact: true });
  await picker.waitFor({ state: 'visible' });
  // Wait for responsive layout before dismissing its retained sidebar.
  if (await page.getByTestId('sidebar-drawer').isVisible()) {
    await page.getByTestId('sidebar-drawer-close').click();
    await page.getByTestId('sidebar-drawer').waitFor({ state: 'hidden' });
  }
  page.on('request', request => {
    if (request.url().startsWith('roc-preview://research/')) {
      requests.push({ url: request.url().replace(/projects\/[^/]+\/documents\/[^/]+/u, 'projects/generated/documents/generated'),
        range: request.headers().range ?? null, method: request.method() });
    }
  });
  for (let iteration = 0; iteration < options.samples; iteration++) {
    const modes = process.env.ROC_PERF_PDF_SOURCE_PAIRED === '1'
      ? (iteration % 2 === 0 ? ['legacy', 'verified'] : ['verified', 'legacy']) : [null];
    for (const sourceMode of modes) {
    if (sourceMode !== null) await app.evaluate(mode => {
      process.env.ROC_PERF_PDF_RANGE_READER = mode === 'legacy' ? '0' : '1';
    }, sourceMode);
    const initial = await page.evaluate(() => window.__rocRasterAllocations);
    const started = performance.now();
    await navigate('literature');
    await picker.selectOption(document.libraryItemId);
    await page.getByTestId('paper-reader').waitFor();
    // Original source mode is available before parsing; comparison requires a
    // parsed document and is only used by the frozen legacy renderer fixture.
    await showSourcePdf();
    await waitForPdf();
    const firstRasterMs = performance.now() - started;
    const metrics = await sampleElectronProcesses(app);
    report.host.display = metrics.display;
    processSamples.push(metrics);
    rows.push({ firstRasterMs, sourceMode, rasterAllocations: await page.evaluate(() => window.__rocRasterAllocations) - initial,
      mainRssBytes: metrics.main.rss, mainExternalBytes: metrics.main.external,
      processWorkingSetSumBytes: metrics.processes.reduce((sum, process) => sum + process.workingSetBytes, 0) });
    // Canvas views remain mounted while hidden. Closing the current selection
    // exercises the real Reader teardown instead of mistaking navigation for it.
    await picker.selectOption('');
    await page.getByTestId('reader-pdf').waitFor({ state: 'detached' });
    await navigate('overview');
    processSamples.push(await sampleElectronProcesses(app));
    console.log(JSON.stringify({ readerSample: iteration + 1, sourceMode, firstRasterMs }));
    }
  }
  if (process.env.ROC_PERF_PDF_SOURCE_PAIRED === '1') {
    for (const mode of ['legacy', 'verified']) {
      const samples = rows.filter(row => row.sourceMode === mode);
      report.scenarios.push({id: `400-page-open-close-${mode}`, samples, summary: summarizeRows(samples)});
    }
    report.limitations.push('Alternating legacy/verified Main source reads share the final Renderer and one application; this refines source-path cost, not every earlier Renderer change.');
    await app.evaluate(() => {process.env.ROC_PERF_PDF_RANGE_READER = '1';});
  } else report.scenarios.push({ id: '400-page-open-close', samples: rows, summary: summarizeRows(rows) });
  if (pageTurns > 0) {
    await navigate('literature');
    await picker.selectOption(document.libraryItemId);
    await page.getByTestId('paper-reader').waitFor();
    await showSourcePdf();
    await waitForPdf();
    const pageInput = page.getByRole('spinbutton', {name: 'PDF 页码'});
    await pageInput.fill('1');
    await pageInput.press('Enter');
    await waitForPdf();
    const measurement = await measureRendererWorkload(page, async () => {
      const samples = [];
      for (let index = 0; index < pageTurns; index++) {
        const allocations = await page.evaluate(() => window.__rocRasterAllocations);
        const started = performance.now();
        await page.getByTestId('reader-pdf').getByRole('button', {name: '下一页', exact: true}).click();
        // A positive canvas alone could be the old page. Require both selected page and
        // a new allocation before waiting for the production visibility-on-raster latch.
        await page.waitForFunction(({target, allocations}) =>
          document.querySelector('input[aria-label="PDF 页码"]')?.value === String(target) &&
          window.__rocRasterAllocations > allocations, {target: index + 2, allocations});
        await waitForPdf();
        samples.push({page: index + 2, rasterReadyMs: performance.now() - started,
          rasterAllocations: await page.evaluate(() => window.__rocRasterAllocations) - allocations,
          ...(await readerOwnership())});
      }
      return samples;
    }, {rawTracePath: process.env.ROC_PERF_RAW_TRACE_DIR === undefined ? null :
      join(resolve(process.env.ROC_PERF_RAW_TRACE_DIR), `pdf-${pageTurns}-page-turns.trace.json`)});
    report.scenarios.push({id: `400-page-${pageTurns}-continuous-turns`, samples: measurement.result,
      summary: summarizeRows(measurement.result), measurement});
    processSamples.push(await sampleElectronProcesses(app));
    saveReport(options.outputPath, report);
    await picker.selectOption('');
    await page.getByTestId('reader-pdf').waitFor({state: 'detached'});
  }
  const started = performance.now();
  const parsePromise = page.evaluate(async documentId => await window.roc.research.parseDocument({ documentId, tier: 'compact' }), document.id);
  await closeWindow();
  const busyRows = [];
  for (let iteration = 0; iteration < options.samples; iteration++) {
    const ipcStarted = performance.now();
    const status = await page.evaluate(async () => await window.roc.app.getStatus());
    assert.ok(status.ok, JSON.stringify(status));
    busyRows.push({ ipcMs: performance.now() - ipcStarted });
    processSamples.push(await sampleElectronProcesses(app));
  }
  const parsed = await parsePromise;
  assert.ok(parsed.ok && parsed.data.status === 'ready', JSON.stringify(parsed));
  report.backgroundParseMs = performance.now() - started;
  report.scenarios.push({ id: 'hidden-parser-ipc-competition', samples: busyRows, summary: summarizeRows(busyRows) });
  await reopenWindow();
  await navigate('literature');
  await picker.selectOption(document.libraryItemId);
  await page.getByTestId('paper-reader').waitFor();
  if (nativeReopen) {
    // Select through the compact picker first, then expose the actual composer.
    // Wide layouts replace the picker with the literature list.
    await page.setViewportSize(nativeReopenViewport);
    const openAssistant = page.getByRole('button', {name: '打开助手', exact: true});
    if (await openAssistant.isVisible()) await openAssistant.click();
    await page.getByTestId('assistant-composer-input').waitFor({state: 'visible'});
    await showSourcePdf();
    await waitForPdf();
    const reopenRows = [];
    for (let iteration = 0; iteration < options.samples; iteration++) {
      const visible = await readerOwnership();
      await closeWindow();
      if (nativeReopenHiddenMs > 0) await page.evaluate(ms => new Promise(done => setTimeout(done, ms)), nativeReopenHiddenMs);
      const expectReclaimed = referenceRenderer === undefined && nativeReopenHiddenMs >= 30_000;
      if (expectReclaimed) {
        await page.waitForFunction(() => window.__rocLiveWorkers === 0 &&
          [...document.querySelectorAll('[data-testid="reader-pdf-canvas"]')]
            .every(canvas => canvas.width * canvas.height === 0), null, {timeout: 10_000, polling: 20});
      } else {
        await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
      }
      const hidden = await readerOwnership();
      assert.equal(hidden.workers, expectReclaimed ? 0 : 1, 'hidden_worker_ownership');
      assert.equal(hidden.bitmapBytes, expectReclaimed ? 0 : visible.bitmapBytes, 'hidden_bitmap_ownership');
      const hiddenMetrics = await sampleElectronProcesses(app);
      const reopenedAt = performance.now();
      await reopenWindow();
      await page.getByTestId('assistant-composer-input').fill('Generated reopen input probe');
      const shellInputReadyMs = performance.now() - reopenedAt;
      const ipcAt = performance.now();
      const status = await page.evaluate(async () => await window.roc.app.getStatus());
      assert.ok(status.ok, JSON.stringify(status));
      const ipcMs = performance.now() - ipcAt;
      const pageInput = page.getByRole('spinbutton', {name: 'PDF 页码'});
      await pageInput.fill('1');
      const inputReadyMs = performance.now() - reopenedAt;
      await waitForPdf();
      const reopenRasterMs = performance.now() - reopenedAt;
      const restored = await readerOwnership();
      assert.equal(restored.workers, 1, 'reopened_worker_count');
      assert.ok(restored.bitmapBytes > 0, 'reopened_canvas_empty');
      const metrics = await sampleElectronProcesses(app);
      await page.getByTestId('assistant-composer-input').fill('');
      reopenRows.push({shellInputReadyMs, inputReadyMs, ipcMs, reopenRasterMs, hiddenWorkers: hidden.workers,
        hiddenBitmapBytes: hidden.bitmapBytes, visibleWorkers: visible.workers,
        visibleBitmapBytes: visible.bitmapBytes, hiddenMainRssBytes: hiddenMetrics.main.rss,
        visibleMainRssBytes: metrics.main.rss});
      processSamples.push(hiddenMetrics, metrics);
      console.log(JSON.stringify({nativeReopenSample: iteration + 1, shellInputReadyMs, inputReadyMs, ipcMs, reopenRasterMs}));
    }
    report.scenarios.push({id: 'native-hidden-reader-reopen', samples: reopenRows, summary: summarizeRows(reopenRows)});
  }
  report.processSamples = processSamples;
  report.requests = requests;
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(artifactRoot, 'reader-baseline.png') });
  report.limitations.push('Native canvas positive-width assignments count raster allocation, not direct PDFPageProxy.render calls.',
    'Repeated opens use one application and the fixed 625447-byte, 400-page native fixture; 300–500 MiB transport is a separate PR-06 workload.',
    'Hidden parsing is a real production worker concurrent with status IPC. Process metrics do not include detached research workers.',
    'Native close-to-hide and second-instance reopen assert production Renderer hidden notifications. Playwright disables Chromium occlusion/backgrounding.',
    'Native reopen shell-input-ready tests the actual assistant composer before PDF readiness; input-ready is the actual page-number edit. Selected PDFs remain warm during the 30-second hidden grace; longer hiding measures verified source loading and fresh PDF Worker creation.',
    'Working-set sums include shared pages. No exclusive macOS footprint or IOSurface estimate.');
  if (pageTurns > 0) report.limitations.push('Continuous PDF turns use the real Next page control from page 1 and require the requested page, a fresh canvas allocation and completed visible raster for every step. Tracing/RAF observers add overhead; RAF cadence is not compositor FPS.');
  if (referenceRenderer !== undefined) report.limitations.push(
    'Reference replaces only PaperPdfView.tsx with the exact PR-10 source in a separately built production Renderer. Main, preload, source protocol, shell and dependencies are current; reference intentionally retains the hidden Worker/canvas.');
  console.log(saveReport(options.outputPath, report));
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(artifactRoot, 'reader-failure.png') });
    writeFileSync(join(artifactRoot, 'reader-failure.html'), await page.content());
  }
  throw error;
} finally {
  try {if (app) await app.close();}
  finally {rmSync(root, { recursive: true, force: true });}
}

async function closeWindow() {
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().forEach(window => window.close()));
  assert.ok(await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().every(window => !window.isVisible())),
    'native_window_not_hidden');
  await page.waitForFunction(() => window.__rocBenchmarkHidden === true, null, {polling: 20});
}

async function reopenWindow() {
  await app.evaluate(({app}) => app.emit('second-instance', {}, ['roc']));
  await page.waitForFunction(() => window.__rocBenchmarkHidden === false, null, {polling: 20});
  assert.ok(await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().some(window => window.isVisible())),
    'native_window_not_visible');
}

async function readerOwnership() {
  return await page.evaluate(() => ({workers: window.__rocLiveWorkers,
    bitmapBytes: [...document.querySelectorAll('[data-testid="reader-pdf-canvas"]')]
      .reduce((bytes, canvas) => bytes + canvas.width * canvas.height * 4, 0)}));
}
