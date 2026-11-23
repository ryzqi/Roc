import assert from 'node:assert/strict';
import { _electron as electron } from '@playwright/test';
import { cpSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { importTypeScriptModule } from '../lib/bundle-ts.mjs';
import { waitForAppReady } from '../../tests/smoke/lib/assertions.mjs';
import { makeReport, protocol, readArguments, saveReport, summarizeRows } from './report-lib.mjs';
import { observeElectronLoop, sampleElectronProcesses } from './electron-metrics.mjs';

assert.equal(process.platform, 'darwin', 'macos_required');
assert.equal(process.arch, 'arm64', 'arm64_required');
const options = readArguments('.artifacts/mac-performance/app-before.json');
const viewport = { width: 1440, height: 900 };
const report = makeReport('macos-app', { events: protocol.app.events, samples: options.samples, idleMinutes: options.idleMinutes, viewport },
  ['src/main/index.ts', 'src/main/main-kernel-bootstrap.ts', 'src/main/plugins/research/index.ts',
    'src/renderer/assistant/use-chat-run.ts', 'scripts/performance/bench-macos-app.mjs',
    'dist/renderer/.vite/manifest.json', 'dist/main/index.js', 'dist/preload/index.cjs']);
const root = mkdtempSync(join(tmpdir(), 'roc-app-performance-'));
const artifactDir = dirname(resolve(options.outputPath));
mkdirSync(artifactDir, { recursive: true });
let app;

try {
  const { seedPerformanceProfiles } = await importTypeScriptModule('tests/smoke/lib/performance-profile-seed.ts',
    { platform: 'node', external: ['better-sqlite3'], tempDir: resolve('.runtime/performance') });
  const templates = { empty: join(root, 'template-empty'), profile1000: join(root, 'template-1000'), profile10000: join(root, 'template-10000') };
  seedPerformanceProfiles(templates);
  for (const eventCount of protocol.app.events) {
    const rows = [], processSamples = [], idleSamples = [];
    for (let iteration = 0; iteration < options.samples; iteration++) {
      const dataRoot = join(root, `${eventCount}-${iteration}`);
      cpSync(eventCount === 0 ? templates.empty : eventCount === 1000 ? templates.profile1000 : templates.profile10000, dataRoot, { recursive: true });
      const startedAt = performance.now();
      app = await electron.launch({ args: [`--user-data-dir=${join(dataRoot, 'chromium')}`, resolve('dist/main/index.js')],
        env: { ...process.env, ROC_SMOKE: '1', ROC_DATA_ROOT: dataRoot } });
      await observeElectronLoop(app);
      const page = await app.firstWindow();
      const pageErrors = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), viewport);
      await waitForAppReady(page, `app-${eventCount}-${iteration}`, artifactDir);
      assert.deepEqual(await page.evaluate(() => ({ width: innerWidth, height: innerHeight })), viewport,
        'actual_renderer_viewport');
      const rendererReadyMs = performance.now() - startedAt;
      await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
      const firstPaintMs = await page.evaluate(() => performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null);
      assert.ok(firstPaintMs !== null, 'first_paint_missing');
      await page.locator('[data-testid^="portal-card-open-"]').first().click();
      const inputStartedAt = performance.now();
      await page.evaluate(() => {
        const url = new URL(location.href); url.searchParams.set('assistant', '1');
        history.pushState({}, '', url); dispatchEvent(new PopStateEvent('popstate'));
      });
      await page.getByTestId('assistant-composer-input').waitFor();
      const inputReadyMs = performance.now() - inputStartedAt;
      let historyReadyMs = 0;
      if (eventCount > 0) {
        const historyStarted = performance.now();
        await page.getByTestId('activity-nav-runs').click();
        if (!await page.getByTestId('context-drawer').isVisible()) await page.getByTestId('titlebar-toggle-sidebar').click();
        await page.getByTestId(`session-row-thread-profile-${eventCount}`).click();
        await page.waitForFunction(marker => document.querySelector('[data-testid="assistant-transcript"]')?.textContent?.includes(marker),
          `profile-marker-${eventCount}-${eventCount}`, { timeout: 15_000 });
        historyReadyMs = performance.now() - historyStarted;
      }
      const metrics = await sampleElectronProcesses(app);
      const cdp = await page.context().newCDPSession(page);
      let renderer;
      try {
        await cdp.send('Performance.enable');
        const { metrics: values } = await cdp.send('Performance.getMetrics');
        const measured = Object.fromEntries(values.map(({ name, value }) => [name, value]));
        renderer = {
          rendererHeapUsedBytes: measured.JSHeapUsedSize,
          rendererHeapTotalBytes: measured.JSHeapTotalSize,
          rendererDomNodes: measured.Nodes,
          rendererDocuments: measured.Documents,
          mountedMessageRows: await page.locator('[data-testid="assistant-message-user"], [data-testid="assistant-message-assistant"]').count()
        };
        assert.ok(Object.values(renderer).every(Number.isFinite), 'renderer_metrics_missing');
      } finally {
        await cdp.detach();
      }
      assert.deepEqual(pageErrors, [], 'renderer_page_errors');
      report.host.display = metrics.display;
      processSamples.push(metrics);
      rows.push({ rendererReadyMs, firstPaintMs, inputReadyMs, historyReadyMs, ...renderer, mainRssBytes: metrics.main.rss,
        mainHeapUsedBytes: metrics.main.heapUsed, mainExternalBytes: metrics.main.external, mainArrayBufferBytes: metrics.main.arrayBuffers,
        mainPrivateMemoryBytes: metrics.mainPrivateMemoryBytes,
        processWorkingSetSumBytes: metrics.processes.reduce((sum, metric) => sum + metric.workingSetBytes, 0) });
      if (options.idleMinutes > 0 && eventCount === 0 && iteration === 0) {
        await page.evaluate(() => {
          window.__rocBenchmarkHidden = false;
          window.roc.window.onHidden(snapshot => { window.__rocBenchmarkHidden = snapshot.hidden; });
        });
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.close()));
        assert.ok(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible())),
          'native_window_not_hidden');
        await page.waitForFunction(() => window.__rocBenchmarkHidden === true, null, {polling: 50});
        const checkpoints = [0, ...protocol.app.idleMinutes.filter(minutes => minutes <= options.idleMinutes)];
        if (!checkpoints.includes(options.idleMinutes)) checkpoints.push(options.idleMinutes);
        const idleStarted = performance.now();
        for (const minutes of checkpoints) {
          // Long observation waits run in this external benchmark; Codex remains free to work and report.
          const remainingMs = minutes * 60_000 - (performance.now() - idleStarted);
          if (remainingMs > 0) await new Promise(done => setTimeout(done, remainingMs));
          const forwardedHidden = await page.evaluate(() => window.__rocBenchmarkHidden);
          assert.equal(forwardedHidden, true, 'hidden_policy_lost');
          idleSamples.push({ minutes, forwardedHidden, ...(await sampleElectronProcesses(app)) });
          report.idleSamples = idleSamples;
          saveReport(options.outputPath, report);
        }
        const reopenStarted = performance.now();
        await app.evaluate(({ app }) => app.emit('second-instance', {}, ['roc']));
        await page.waitForFunction(() => window.__rocBenchmarkHidden === false, null, {polling: 50});
        await page.getByTestId('assistant-composer-input').waitFor({ state: 'visible' });
        report.reopenMs = performance.now() - reopenStarted;
      }
      await app.close(); app = null;
      console.log(JSON.stringify({ eventCount, sample: iteration + 1, rendererReadyMs }));
    }
    report.scenarios.push({ id: `events-${eventCount}`, summary: summarizeRows(rows), samples: rows, processSamples, idleSamples });
    saveReport(options.outputPath, report);
  }
  report.limitations.push('Fresh isolated profiles/launches; OS filesystem cache remains warm.',
    'Renderer DOM and JS heap are CDP point-in-time samples after history readiness; neither peak heap nor a leak verdict. Fixture events are user messages, not streaming model output.',
    'Native close-to-hide and second-instance reopen exercise production host forwarding; each idle checkpoint confirms the Renderer received hidden=true.',
    'Summed working sets include shared pages; not application exclusive footprint.',
    'CPU interval averages share app.getAppMetrics sampling intervals with diagnostics.',
    'PDF/OCR, background-busy and long idle are separate explicitly selected workloads; this startup report does not establish them.');
  saveReport(options.outputPath, report);
} finally {
  if (app) await app.close();
  rmSync(root, { recursive: true, force: true });
}
