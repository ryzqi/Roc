import assert from 'node:assert/strict';
import { _electron as electron } from '@playwright/test';
import { cpSync, mkdtempSync, mkdirSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { importTypeScriptModule } from '../lib/bundle-ts.mjs';
import { waitForAppReady } from '../../tests/smoke/lib/assertions.mjs';
import { makeReport, readArguments, saveReport, summarizeRows, sha256 } from './report-lib.mjs';
import { observeElectronLoop, sampleElectronProcesses } from './electron-metrics.mjs';

const options = readArguments('.artifacts/mac-performance/mac-startup-pr-10-paired-valid.json');
const paths = { before: resolve(process.env.ROC_PERF_FROZEN_DIST ?? '.runtime'),
  after: resolve('dist') };
// Development Main resolves resources and native runtimes relative to its
// module directory. A deeper reference build silently changes those inputs.
for (const path of Object.values(paths)) {
  assert.equal(realpathSync(resolve(path, '..')), realpathSync('.'),
    'Reference and current builds must resolve the same development resources');
}
const fixture = { version: 1, eventCounts: [0, 10000], order: 'alternating pairs',
  beforeGitSha: process.env.ROC_PERF_FROZEN_GIT_SHA ?? 'f1c6d792', samples: options.samples, nativeDialogs: false };
const report = makeReport('macos-startup-paired', fixture, ['src/main/plugins/research/index.ts',
  'src/main/plugins/research/research-plugin-lifecycle.ts', 'dist/main/index.js']);
report.builtMainHashes = Object.fromEntries(Object.entries(paths).map(([variant, path]) =>
  [variant, sha256(readFileSync(join(path, 'main/index.js')))]));
report.limitations.push(
  process.env.ROC_PERF_FROZEN_GIT_SHA === undefined
    ? 'Before replaces the two changed PR-09 Research source files at build time; all other production files, dependencies and development resource roots are identical.'
    : 'Before is the retained exact pre-change build identified by beforeGitSha and the Main hash; both builds resolve the same development resources.',
  'Alternating starts share warm OS caches and development host load. Working-set sums are not private physical footprint.',
  'The 5% regression threshold is unchanged; every paired sample is retained.'
);
const root = mkdtempSync(join(tmpdir(), 'roc-startup-pairs-'));
let app;
try {
  const { seedPerformanceProfiles } = await importTypeScriptModule('tests/smoke/lib/performance-profile-seed.ts',
    { platform: 'node', external: ['better-sqlite3'], tempDir: resolve('.runtime/performance') });
  const templates = { empty: join(root, 'empty'), profile1000: join(root, '1000'), profile10000: join(root, '10000') };
  seedPerformanceProfiles(templates);
  const artifacts = resolve('.artifacts/mac-performance');
  mkdirSync(artifacts, { recursive: true });
  for (const events of fixture.eventCounts) {
    const rows = { before: [], after: [] };
    for (let i = 0; i < options.samples; i++) {
      for (const variant of i % 2 === 0 ? ['before', 'after'] : ['after', 'before']) {
        const dataRoot = join(root, `${events}-${i}-${variant}`);
        cpSync(events === 0 ? templates.empty : templates.profile10000, dataRoot, { recursive: true });
        const started = performance.now();
        app = await electron.launch({
          args: [`--user-data-dir=${join(dataRoot, 'chromium')}`, join(paths[variant], 'main/index.js')],
          env: {...process.env, ROC_SMOKE: '1', ROC_DATA_ROOT: dataRoot}
        });
        await observeElectronLoop(app);
        const page = await app.firstWindow();
        await waitForAppReady(page, `startup-pair-${events}-${i}-${variant}`, artifacts);
        const rendererReadyMs = performance.now() - started;
        await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
        const firstPaintMs = await page.evaluate(() => performance.getEntriesByName('first-contentful-paint')[0]?.startTime);
        assert.ok(Number.isFinite(firstPaintMs));
        await page.locator('[data-testid^="portal-card-open-"]').first().click();
        const inputStarted = performance.now();
        await page.evaluate(() => {
          const url = new URL(location.href); url.searchParams.set('assistant', '1');
          history.pushState({}, '', url); dispatchEvent(new PopStateEvent('popstate'));
        });
        await page.getByTestId('assistant-composer-input').waitFor();
        const inputReadyMs = performance.now() - inputStarted;
        if (events > 0) {
          await page.getByTestId('activity-nav-runs').click();
          if (!await page.getByTestId('context-drawer').isVisible()) await page.getByTestId('titlebar-toggle-sidebar').click();
          await page.getByTestId(`session-row-thread-profile-${events}`).click();
          await page.waitForFunction(marker =>
            document.querySelector('[data-testid="assistant-transcript"]')?.textContent?.includes(marker),
          `profile-marker-${events}-${events}`, { timeout: 15000 });
        }
        const metrics = await sampleElectronProcesses(app);
        report.host.display = metrics.display;
        rows[variant].push({
          rendererReadyMs, firstPaintMs, inputReadyMs, mainRssBytes: metrics.main.rss,
          processWorkingSetSumBytes: metrics.processes.reduce((sum, metric) => sum + metric.workingSetBytes, 0)
        });
        await app.close(); app = null;
      }
      console.log(`Startup events-${events} pair ${i + 1}/${options.samples}`);
    }
    for (const [variant, samples] of Object.entries(rows)) report.scenarios.push({
      id: `events-${events}-${variant}`, samples, summary: summarizeRows(samples)
    });
    saveReport(options.outputPath, report);
  }
  console.log(saveReport(options.outputPath, report));
} finally {
  if (app) await app.close();
  rmSync(root, { recursive: true, force: true });
}
