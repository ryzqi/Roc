import assert from 'node:assert/strict';
import { _electron as electron } from '@playwright/test';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { importTypeScriptModule } from '../lib/bundle-ts.mjs';
import { waitForAppReady } from '../../tests/smoke/lib/assertions.mjs';
import { makeReport, protocol, readArguments, saveReport, summarizeRows } from './report-lib.mjs';
import { observeElectronLoop, sampleElectronProcesses } from './electron-metrics.mjs';
import {rendererSnapshot} from './renderer-workload-metrics.mjs';
import {runUiWorkloads, uiWorkloadFixture} from './ui-workload-scenarios.mjs';
import {sustainedStreamConfig} from './sustained-stream-scenario.mjs';

assert.equal(process.platform, 'darwin', 'macos_required');
assert.equal(process.arch, 'arm64', 'arm64_required');
const options = readArguments('.artifacts/mac-performance/app-before.json');
const idleVisibility = process.env.ROC_PERF_IDLE_VISIBILITY ?? 'hidden';
assert.ok(['visible', 'hidden', 'both'].includes(idleVisibility), 'idle_visibility_invalid');
const uiWorkloads = process.env.ROC_PERF_UI_WORKLOADS === '1';
const sustainedStream = sustainedStreamConfig(process.env.ROC_PERF_STREAM_MINUTES);
assert.ok(sustainedStream === null || uiWorkloads, 'stream_minutes_requires_ui_workloads');
const appBuildDir = process.env.ROC_PERF_APP_DIR === undefined ? 'dist' : resolve(process.env.ROC_PERF_APP_DIR);
const profilingBuild = process.env.ROC_PERF_REQUIRE_PROFILE === '1';
const viewport = { width: 1440, height: 900 };
const report = makeReport('macos-app', { events: protocol.app.events, samples: options.samples,
  idleMinutes: options.idleMinutes, viewport, buildMode: profilingBuild ? 'react-production-profiling' : 'production', appBuildDir,
  ...(options.idleMinutes > 0 && idleVisibility !== 'hidden' ? {idleVisibility} : {}),
  ...(uiWorkloads ? {uiWorkloads: {...uiWorkloadFixture, sustainedStream}} : {}) },
  ['src/main/index.ts', 'src/main/main-kernel-bootstrap.ts', 'src/main/plugins/research/index.ts',
    'src/renderer/assistant/use-chat-run.ts', 'scripts/performance/bench-macos-app.mjs',
    'scripts/performance/renderer-workload-metrics.mjs', 'scripts/performance/ui-workload-scenarios.mjs',
    'scripts/performance/sustained-stream-scenario.mjs',
    'tests/smoke/lib/performance-profile-seed.ts', 'tests/smoke/lib/fixtures.mjs',
    join(appBuildDir,'renderer/.vite/manifest.json'), join(appBuildDir,'main/index.js'), join(appBuildDir,'preload/index.cjs')]);
const root = mkdtempSync(join(tmpdir(), 'roc-app-performance-'));
mkdirSync(dirname(resolve(options.outputPath)), {recursive: true});
const artifactDir = process.env.ROC_PERF_KEEP_ARTIFACTS === '1'
  ? mkdtempSync(join(dirname(resolve(options.outputPath)), 'app-artifacts-')) : join(root, 'diagnostics');
mkdirSync(artifactDir, { recursive: true });
if (process.env.ROC_PERF_KEEP_ARTIFACTS === '1') report.artifactRoot = artifactDir;
let app;

try {
  const { seedPerformanceProfiles, seedUiPerformanceProfile } = await importTypeScriptModule('tests/smoke/lib/performance-profile-seed.ts',
    { platform: 'node', external: ['better-sqlite3'], tempDir: resolve('.runtime/performance') });
  const templates = { empty: join(root, 'template-empty'), profile1000: join(root, 'template-1000'), profile10000: join(root, 'template-10000') };
  seedPerformanceProfiles(templates);
  for (const eventCount of protocol.app.events) {
    const rows = [], processSamples = [], idleSamples = [];
    for (let iteration = 0; iteration < options.samples; iteration++) {
      const dataRoot = join(root, `${eventCount}-${iteration}`);
      cpSync(eventCount === 0 ? templates.empty : eventCount === 1000 ? templates.profile1000 : templates.profile10000, dataRoot, { recursive: true });
      const startedAt = performance.now();
      app = await electron.launch({ args: [`--user-data-dir=${join(dataRoot, 'chromium')}`, resolve(appBuildDir,'main/index.js')],
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
        const checkpoints = [0, ...protocol.app.idleMinutes.filter(minutes => minutes <= options.idleMinutes)];
        if (!checkpoints.includes(options.idleMinutes)) checkpoints.push(options.idleMinutes);
        for (const visibility of idleVisibility === 'both' ? ['visible', 'hidden'] : [idleVisibility]) {
          if (visibility === 'hidden') {
            await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().forEach(window => window.close()));
            await page.waitForFunction(() => window.__rocBenchmarkHidden === true, null, {polling: 50});
          }
          const idleStarted = performance.now();
          let previous = null;
          for (const minutes of checkpoints) {
            // Only external wall-clock waiting: no RAF sampler or tracing changes the idle workload.
            const deadline = idleStarted + minutes * 60_000;
            for (let remainingMs = deadline - performance.now(); remainingMs > 0; remainingMs = deadline - performance.now()) {
              await new Promise(done => setTimeout(done, Math.max(1, remainingMs)));
            }
            const forwardedHidden = await page.evaluate(() => window.__rocBenchmarkHidden);
            const nativeVisible = await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().some(window => window.isVisible()));
            assert.equal(forwardedHidden, visibility === 'hidden', 'idle_forwarded_visibility_changed');
            assert.equal(nativeVisible, visibility === 'visible', 'idle_native_visibility_changed');
            const processes = await sampleElectronProcesses(app);
            const elapsedMs = performance.now() - idleStarted;
            const sample = {minutes, elapsedMs, visibility, forwardedHidden, nativeVisible,
              renderer: await rendererSnapshot(page), ...processes,
              mainCpuOneCorePercent: previous === null ? null :
                (processes.cpu.user + processes.cpu.system - previous.cpu.user - previous.cpu.system) /
                ((elapsedMs - previous.elapsedMs) * 1000) * 100};
            idleSamples.push(sample);
            previous = sample;
            report.idleSamples = idleSamples;
            saveReport(options.outputPath, report);
            console.log(JSON.stringify({idle: visibility, minutes, mainCpuOneCorePercent: sample.mainCpuOneCorePercent}));
          }
        }
        if (idleVisibility !== 'visible') {
          const reopenStarted = performance.now();
          await app.evaluate(({app}) => app.emit('second-instance', {}, ['roc']));
          await page.waitForFunction(() => window.__rocBenchmarkHidden === false, null, {polling: 50});
          await page.getByTestId('assistant-composer-input').waitFor({state: 'visible'});
          report.reopenMs = performance.now() - reopenStarted;
        }
      }
      await app.close(); app = null;
      console.log(JSON.stringify({ eventCount, sample: iteration + 1, rendererReadyMs }));
    }
    report.scenarios.push({ id: `events-${eventCount}`, summary: summarizeRows(rows), samples: rows, processSamples, idleSamples });
    saveReport(options.outputPath, report);
  }
  if (uiWorkloads) {
    const dataRoot = join(root, 'ui-workloads');
    seedUiPerformanceProfile(dataRoot);
    app = await electron.launch({args: [`--user-data-dir=${join(dataRoot, 'chromium')}`, resolve(appBuildDir,'main/index.js')],
      env: {...process.env, ROC_SMOKE: '1', ROC_DATA_ROOT: dataRoot}});
    await observeElectronLoop(app);
    const page = await app.firstWindow();
    await app.evaluate(({BrowserWindow}, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), viewport);
    await waitForAppReady(page, 'ui-workloads', artifactDir);
    try {
      await runUiWorkloads({app, page, report, sustainedStream, save: () => saveReport(options.outputPath, report)});
    } catch (error) {
      // Preserve bounded, structured error evidence before the isolated profile is
      // removed. Provider credentials and request bodies are never copied.
      try {
        report.mainErrors = readFileSync(join(dataRoot, 'logs', 'app.jsonl'), 'utf8').trim().split('\n')
          .flatMap(line => {try {return [JSON.parse(line)];} catch {return [];}})
          .filter(entry => entry.error).slice(-10)
          .map(entry => ({timestamp: entry.timestamp, message: entry.message,
            service: entry.service, component: entry.component, error: entry.error}));
      } catch (logError) {report.mainErrorsUnavailable = String(logError);}
      saveReport(options.outputPath, report);
      throw error;
    }
    await app.close(); app = null;
  }
  if (profilingBuild) report.limitations.push('This is a dedicated React production profiling build with explicit component boundaries and preload IPC counters. Instrumentation adds overhead; its wall-clock, CPU, heap and startup observations cannot be substituted for the ordinary production benchmark.');
  report.limitations.push('Fresh isolated profiles/launches; OS filesystem cache remains warm.',
    'Renderer DOM and JS heap are CDP point-in-time samples after history readiness; neither peak heap nor a leak verdict. Fixture events are user messages, not streaming model output.',
    'When hidden idle is selected, native close-to-hide and second-instance reopen exercise production host forwarding; hidden checkpoints confirm the Renderer received hidden=true.',
    'Summed working sets include shared pages; not application exclusive footprint.',
    'CPU interval averages share app.getAppMetrics sampling intervals with diagnostics.',
    'Idle visibility is asserted in both BrowserWindow and Renderer forwarding. visible+hidden observes two separate intervals in that order; checkpoints alone cannot prove zero activity between samples.',
    'mainCpuOneCorePercent uses process.cpuUsage delta / elapsed wall time; 100% means one logical CPU core. It is not normalized by host logical CPU count and differs from Electron process interval metrics.',
    'PDF/OCR, background-busy and long idle are separate explicitly selected workloads; this startup report does not establish them.');
  saveReport(options.outputPath, report);
} finally {
  try {if (app) await app.close();}
  finally {rmSync(root, { recursive: true, force: true });}
}
