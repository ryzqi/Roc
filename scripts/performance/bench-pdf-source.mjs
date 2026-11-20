import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {_electron} from '@playwright/test';
import {importTypeScriptModule} from '../lib/bundle-ts.mjs';
import {waitForAppReady} from '../../tests/smoke/lib/assertions.mjs';
import {writeLargePerformancePdf} from './large-pdf-fixture.mjs';
import {makeReport, readArguments, saveReport, summarizeRows} from './report-lib.mjs';
import {sampleElectronProcesses} from './electron-metrics.mjs';

const options = readArguments('.artifacts/mac-performance/pdf-source.json');
const sizes = [300, 500].map(mib => mib * 1024 * 1024);
const report = makeReport('pdf-source', {sizes, pages: 400, samples: options.samples,
  viewport: {width: 900, height: 900}, padding: 'PDF comments; repeated original startxref'},
['dist/main/index.js', 'dist/renderer/.vite/manifest.json']);
const root = await mkdtemp(join(tmpdir(), 'roc-pdf-source-performance-'));
const artifacts = resolve('.artifacts/mac-performance');
await mkdir(artifacts, {recursive: true});
let app, page;
try {
  const {seedPerformanceProfiles} = await importTypeScriptModule('tests/smoke/lib/performance-profile-seed.ts',
    {platform: 'node', external: ['better-sqlite3'], tempDir: resolve('.runtime/performance')});
  const roots = {empty: join(root, 'empty'), profile1000: join(root, '1000'), profile10000: join(root, '10000')};
  seedPerformanceProfiles(roots);
  app = await _electron.launch({args: ['--js-flags=--expose-gc', `--user-data-dir=${join(root, 'chromium')}`, resolve('dist/main/index.js')],
    env: {...process.env, ROC_SMOKE: '1', ROC_DATA_ROOT: roots.empty}});
  page = await app.firstWindow();
  await waitForAppReady(page, 'pdf-source', artifacts);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.locator('[data-testid^="portal-card-open-"]').first().click();
  const navigate = async view => page.evaluate(view => {
    const url = new URL(location.href);
    url.searchParams.set('page', 'research'); url.searchParams.set('project', 'project-performance-0'); url.searchParams.set('view', view);
    history.pushState({}, '', url); dispatchEvent(new PopStateEvent('popstate'));
  }, view);
  await app.evaluate(({BrowserWindow}) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setMinimumSize(0, 0); window.setContentSize(1100, 900);
  });
  await navigate('literature');
  await page.getByTestId('literature-hub').waitFor();
  const picker = page.getByRole('combobox', {name: '选择当前文献', exact: true});
  await page.evaluate(() => {
    const native = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await native(...args);
      if (String(args[0]).startsWith('roc-preview://research/projects/')) {
        const arrayBuffer = response.arrayBuffer.bind(response);
        response.arrayBuffer = async () => {
          const bytes = await arrayBuffer();
          window.__sourceBytes += bytes.byteLength;
          window.__sourceFullBuffer = Math.max(window.__sourceFullBuffer, bytes.byteLength);
          return bytes;
        };
        if (response.body) {
          const getReader = response.body.getReader.bind(response.body);
          response.body.getReader = (...args) => {
            const reader = getReader(...args), read = reader.read.bind(reader);
            reader.read = async () => {
              const result = await read();
              window.__sourceBytes += result.value?.byteLength ?? 0;
              return result;
            };
            return reader;
          };
        }
        window.__sourceRequests.push({method: args[1]?.method ?? 'GET', range: args[1]?.headers?.range ?? null, status: response.status});
      }
      return response;
    };
  });
  report.corpora = [];
  for (const size of sizes) {
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setContentSize(1100, 900));
    await page.waitForFunction(() => innerWidth >= 1100);
    const sourcePath = join(root, `${size}.pdf`);
    const corpus = await writeLargePerformancePdf(sourcePath, size); report.corpora.push(corpus);
    const imported = await page.evaluate(async input => window.roc.research.importDocument(input),
      {target: 'new-item', projectId: 'project-performance-0', sourcePath, title: `Generated ${size} byte PDF`, citationKey: `source${size}`});
    assert.ok(imported.ok, JSON.stringify(imported));
    assert.equal(imported.data.sourceHash, corpus.sha256);
    // Imports use the native API for generated fixtures. Refresh the shared
    // store before timing even when its canvas list is retained in a hidden tab.
    await page.getByTestId('literature-refresh').evaluate(button => button.click());
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setContentSize(900, 900));
    await page.waitForFunction(() => innerWidth === 900);
    report.viewport = await page.evaluate(() => ({width: innerWidth, height: innerHeight, devicePixelRatio}));
    const closeSidebarDrawer = async () => {
      if (await page.getByTestId('sidebar-drawer').isVisible()) {
        await page.getByTestId('sidebar-drawer-close').click();
        await page.getByTestId('sidebar-drawer').waitFor({state: 'hidden'});
      }
    };
    await closeSidebarDrawer();
    await picker.waitFor({state: 'visible'});
    await page.waitForFunction(id => [...document.querySelector('[aria-label="选择当前文献"]').options].some(option => option.value === id),
      imported.data.libraryItemId);
    const rows = [];
    for (let sample = 0; sample < options.samples; sample++) {
      await picker.selectOption('');
      await page.getByTestId('reader-pdf').waitFor({state: 'detached'});
      await app.evaluate(() => {globalThis.gc?.();});
      await page.evaluate(() => {window.gc?.(); window.__sourceBytes = 0; window.__sourceFullBuffer = 0; window.__sourceRequests = [];});
      await app.evaluate(() => {
        const baseline = process.memoryUsage();
        globalThis.__sourceMemory = {baseline, rss: baseline.rss, external: baseline.external, arrayBuffers: baseline.arrayBuffers};
        globalThis.__sourceTimer = setInterval(() => {
          const memory = process.memoryUsage(), peak = globalThis.__sourceMemory;
          for (const key of ['rss', 'external', 'arrayBuffers']) peak[key] = Math.max(peak[key], memory[key]);
        }, 20);
      });
      const started = performance.now();
      await picker.selectOption(imported.data.libraryItemId);
      await page.getByTestId('paper-reader').waitFor();
      await closeSidebarDrawer();
      await page.getByTestId('reader-compare-pdf').click();
      await page.waitForFunction(() => {
        const canvas = document.querySelector('[data-testid="reader-pdf-canvas"]');
        return canvas?.width > 0 && canvas.height > 0 && canvas.parentElement.style.visibility === 'visible';
      }, null, {timeout: 60_000});
      const firstRasterMs = performance.now() - started;
      const memory = await app.evaluate(() => {clearInterval(globalThis.__sourceTimer); return globalThis.__sourceMemory;});
      const browser = await page.evaluate(() => ({sourceBytes: window.__sourceBytes, fullBuffer: window.__sourceFullBuffer,
        requests: window.__sourceRequests, heap: performance.memory?.usedJSHeapSize ?? null}));
      assert.ok(browser.sourceBytes > 0, 'the Reader did not consume measured source bytes');
      const processes = await sampleElectronProcesses(app);
      report.host.display = processes.display;
      rows.push({firstRasterMs, sourceBytes: browser.sourceBytes, rendererFullSourceBufferBytes: browser.fullBuffer,
        mainPeakRssBytes: memory.rss, mainPeakExternalBytes: memory.external, mainPeakArrayBuffersBytes: memory.arrayBuffers,
        mainExternalGrowthBytes: memory.external - memory.baseline.external,
        processWorkingSetSumBytes: processes.processes.reduce((sum, row) => sum + row.workingSetBytes, 0),
        ranges: browser.requests.filter(row => row.range !== null).length, requests: browser.requests});
      console.log(JSON.stringify({size, sample: sample + 1, firstRasterMs, sourceBytes: browser.sourceBytes, ranges: rows.at(-1).ranges}));
      await picker.selectOption('');
      await page.getByTestId('reader-pdf').waitFor({state: 'detached'});
    }
    report.scenarios.push({id: `${size / 1024 / 1024}-mib-open-close`, samples: rows, summary: summarizeRows(rows)});
  }
  assert.deepEqual(errors, []);
  report.limitations.push('Generated inert padding is a transport/memory fixture, not a representative image-heavy scientific PDF.',
    'Main memory peaks are sampled at 20ms; process working-set sums include shared pages and are not macOS footprint.',
    'Renderer full-source buffer counts actual response.arrayBuffer allocations; bounded stream bytes are counted at consumption.',
    'Explicit GC runs only in this isolated benchmark between samples, not in production.');
  report.limitations.push('Generated imports use the native API; the shared store refresh runs programmatically outside timed Reader interaction.');
  console.log(saveReport(options.outputPath, report));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({path: join(artifacts, 'pdf-source-failure.png')});
  throw error;
} finally {
  if (app) await app.close();
  await rm(root, {recursive: true, force: true});
}
