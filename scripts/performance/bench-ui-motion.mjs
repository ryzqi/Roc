import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {_electron as electron} from '@playwright/test';
import {importTypeScriptModule} from '../lib/bundle-ts.mjs';
import {waitForAppReady} from '../../tests/smoke/lib/assertions.mjs';
import {startSmokeProvider} from '../../tests/smoke/lib/fixtures.mjs';
import {benchmarkChildEnvironment} from './child-environment.mjs';
import {closeBenchmarkElectron, launchBenchmarkElectron, recordBenchmarkFailure} from './electron-lifecycle.mjs';
import {observeElectronLoop, sampleElectronProcesses} from './electron-metrics.mjs';
import {measureRendererWorkload} from './renderer-workload-metrics.mjs';
import {commandText, makeReport, summarize, summarizeRows} from './report-lib.mjs';

const usage = 'node scripts/performance/bench-ui-motion.mjs <report.json> [--samples 5] [--history-messages 500|5000] [--stream-chunks 500] [--reduced-motion]';
if (process.argv.includes('--help')) {console.log(usage); process.exit(0);}
const args = process.argv.slice(2);
const output = resolve(args.shift() ?? 'docs/ux-motion/motion-baseline.json');
const options = {samples: 5, historyMessages: 500, streamChunks: 500, reducedMotion: 'no-preference'};
while (args.length > 0) {
  const name = args.shift();
  if (name === '--reduced-motion') {options.reducedMotion = 'reduce'; continue;}
  const value = Number(args.shift());
  assert.ok(Number.isSafeInteger(value) && value > 0, `motion_option_invalid:${name}`);
  if (name === '--samples') options.samples = value;
  else if (name === '--history-messages') options.historyMessages = value;
  else if (name === '--stream-chunks') options.streamChunks = value;
  else throw new Error(`motion_option_unknown:${name}`);
}
assert.equal(process.platform, 'darwin', 'macos_required');
assert.equal(process.arch, 'arm64', 'arm64_required');
assert.ok([500, 5000].includes(options.historyMessages), 'motion_history_fixture_invalid');
assert.ok(output.endsWith('.json') && !existsSync(output), 'motion_new_json_output_required');
const buildDir = resolve('dist');
assert.ok(!existsSync(join(buildDir, 'renderer/.vite/profiling-build.json')), 'motion_requires_ordinary_build');
assert.notEqual(process.env.ROC_PERF_REQUIRE_PROFILE, '1', 'motion_requires_ordinary_environment');
const viewport = {width: 1440, height: 900};
const scenarioIds = ['project-reorder', 'project-menu', 'sidebar-reverse', 'assistant-reverse', 'assistant-reverse-keyboard', 'divider-drag', 'divider-escape', 'stream-completion'];
const fixture = {independentRuns: options.samples, buildMode: 'production', viewport, narrowZoomFactor: 2,
  historyMessages: options.historyMessages, streamChunks: options.streamChunks, streamChunkIntervalMs: 1,
  repetitions: 5, scenarioIds, reducedMotion: options.reducedMotion};
const report = makeReport('macos-ui-motion', fixture, [
  'scripts/performance/bench-ui-motion.mjs', 'scripts/performance/renderer-workload-metrics.mjs',
  'scripts/performance/child-environment.mjs',
  'scripts/performance/electron-lifecycle.mjs', 'scripts/performance/electron-metrics.mjs',
  'tests/smoke/lib/performance-profile-seed.ts', 'tests/smoke/lib/fixtures.mjs',
  'dist/renderer/.vite/manifest.json', 'dist/main/index.js', 'dist/preload/index.cjs']);
const hash = createHash('sha256');
function hashBuild(directory, prefix = '') {
  for (const entry of readdirSync(directory, {withFileTypes: true}).sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    const relative = join(prefix, entry.name), path = join(directory, entry.name);
    if (entry.isDirectory()) hashBuild(path, relative);
    else {hash.update(relative); hash.update('\0'); hash.update(readFileSync(path));}
  }
}
hashBuild(buildDir);
report.source.distSha256 = hash.digest('hex');
report.host.powerCurrent = commandText('/usr/bin/pmset', ['-g']);
report.host.powerSource = commandText('/usr/bin/pmset', ['-g', 'batt']);
report.measurement = {...report.measurement,
  frames: 'RAF intervals during short instrumented actions; nearest-rank P50/P95/P99. Not compositor or display FPS.',
  feedback: 'Trusted input to first changed target DOM/style observed on RAF; a paint-opportunity proxy, not physical presentation latency.',
  pointerInput: 'Menu/drawer clicks use focused BrowserWindow webContents.sendInputEvent at rounded CSS center × native content width / CSS viewport width. Record getZoomFactor() as reportedZoom; trusted pointerdown target and CSS coordinates verified within 1px. Divider drag uses Playwright page.mouse at zoom=1.',
  storage: 'Storage.setItem calls for roc.ui.*; duringDrag counts workspace.layout writes between trusted pointerdown and pointerup/cancel/Escape.'};
report.calibration = {
  electronZoomPointerCoordinates: {
    zoomFactor: 2, cssPoint: {x: 694, y: 18.75},
    unscaledCdpInputObserved: {clientX: 347, clientY: 9.375, isTrusted: true, target: 'titlebar-search'},
    cssHitTest: 'titlebar-toggle-assistant',
    scaledCdpInput: 'Repeated Playwright/CDP clicks remained unstable; coordinate multiplication alone was not a verified resolution.',
    nativeWindowInputObserved: {zoomFactor: 2, sidebarCssPoint: {x: 100, y: 19}, assistantCssPoint: {x: 694, y: 19},
      repetitionsPerButton: 4, intervalMs: 60, toggleStatesCorrect: true, trustedPointerdownTargetsCorrect: true},
    nativeWindowZoomMismatchObserved: {reportedZoom: 1, effectiveScale: 2,
      cssViewport: {width: 720, height: 450}, nativeContentSize: {width: 1440, height: 900},
      cssPoint: {x: 694, y: 18.75}, sentUsingReportedZoom: {x: 694, y: 19},
      trustedPointerdown: {x: 347, y: 9.5, target: 'titlebar-search'}},
    nativeWindowInputSequenceObserved: {
      sequence: ['project-menu', 'close-assistant', 'zoom=2', 'close-sidebar', 'sidebar-reverse', 'assistant-reverse'],
      repetitionsPerSeries: 10, intervalMs: 60, nativeContentSize: {width: 1440, height: 900},
      projectMenu: {cssViewport: {width: 1440, height: 900}, effectiveScale: 1},
      drawers: {cssViewport: {width: 720, height: 450}, effectiveScale: 2},
      assistantReportedZoom: [2, 1], trustedPointerEvents: ['pointerdown', 'pointerup', 'click'],
      targetsAndCoordinatesCorrect: true, toggleStatesCorrect: true,
      directZoom1Restore: {assistantPressed: false, reportedZoomBefore: 2, cssViewport: {width: 1440, height: 900}}
    },
    resolution: 'Hit-test CSS centers; focus BrowserWindow, measure native content width / CSS viewport width, and send rounded native mouseMove/left mouseDown/mouseUp with webContents.sendInputEvent. Record reportedZoom, effectiveScale and nativeContentSize; verify trusted pointerdown target and CSS point.',
    productObstructionConfirmed: false
  }
};
report.limitations.push(
  'Each round starts a fresh Electron process and cloned isolated profile. Ordinary prebuilt dist only; no profiling build, OS cache flush, or external service.',
  'CDP trace and RAF/style observers add overhead. Trace long tasks are not automatically attributable to animations. Heap/DOM/process memory are point samples.',
  'Physical display frequency is reported only when Electron exposes it. Zoom=2 creates a 720×450 CSS viewport inside the same native 1440×900 content area.',
  'One aggregate sample per scenario per independent round. With five rounds the nearest-rank P95 is the maximum. Individual input/RAF events are not independent rounds.',
  'No raw trace, screenshots, video, provider request bodies, secrets or disposable child reports retained. Human perception, touchpad, IME, VoiceOver, another Mac and low-power comparisons require separate acceptance.');
report.status = 'incomplete';
report.completedRuns = 0;
report.runs = [];
const save = () => {
  report.scenarios = scenarioIds.map(id => {
    const scenes = report.runs.flatMap(run => run.scenarios.filter(scene => scene.id === id));
    const samples = scenes.filter(scene => scene.status === 'complete').map(scene => scene.metrics);
    const blockedRuns = scenes.filter(scene => scene.status === 'blocked').length;
    return {id, status: blockedRuns > 0 ? 'blocked' : samples.length === options.samples ? 'complete' : 'incomplete',
      completedRuns: samples.length, blockedRuns, missingRuns: options.samples - scenes.length,
      samples, summary: samples.length === 0 ? {} : summarizeRows(samples)};
  });
  mkdirSync(dirname(output), {recursive: true});
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
};
const scratch = mkdtempSync(join(tmpdir(), 'roc-ui-motion-'));
mkdirSync(resolve('.runtime'), {recursive: true});
const bundleDir = mkdtempSync(resolve('.runtime/bench-ui-motion-'));
const paint = page => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
const delay = ms => new Promise(done => setTimeout(done, ms));

// Only fixture data is observed. Restore the native storage method and listeners
// at every workload boundary; no observer survives into the next scenario.
async function startProbe(page) {
  await page.evaluate(() => {
    const started = performance.now(), intervals = [], feedback = [], writes = [], pointerInputs = [];
    const original = Storage.prototype.setItem;
    let previous = null, handle = 0, armed = null, pending = null, dragging = false;
    const snapshot = selector => {
      const node = document.querySelector(selector);
      if (node === null) return null;
      const style = getComputedStyle(node), rect = node.getBoundingClientRect();
      return JSON.stringify({display: style.display, opacity: style.opacity, transform: style.transform,
        x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        pressed: node.getAttribute('aria-pressed'), disabled: node.getAttribute('disabled'),
        text: node.tagName === 'BUTTON' ? node.textContent : null});
    };
    const tick = now => {
      if (previous !== null) intervals.push(now - previous);
      previous = now;
      if (pending !== null && snapshot(pending.target) !== pending.before) {
        feedback.push({type: pending.type, ms: now - pending.at});
        pending = null;
      }
      handle = requestAnimationFrame(tick);
    };
    const onInput = event => {
      if (!event.isTrusted) return;
      if (event.type === 'pointerdown') pointerInputs.push({trusted: event.isTrusted, x: event.clientX, y: event.clientY,
        target: (event.target.closest('button') ?? event.target.closest('[data-testid]'))?.getAttribute('data-testid') ?? null});
      if (event.type === 'pointerdown' && event.target.closest('[role="separator"]')) dragging = true;
      if (event.type === 'pointerup' || event.type === 'pointercancel' || (event.type === 'keydown' && event.key === 'Escape')) dragging = false;
      if (armed !== null && event.type === armed.eventType && event.target.closest(armed.trigger) &&
          (armed.key === null || (event.type === 'keydown' && event.key.toLowerCase() === armed.key))) {
        pending = {...armed, type: event.type, at: performance.now(), before: snapshot(armed.target)};
        armed = null;
      }
    };
    const types = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'keydown', 'input'];
    types.forEach(type => document.addEventListener(type, onInput, {capture: true, passive: true}));
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith('roc.ui.')) writes.push({key, duringDrag: dragging, atMs: performance.now() - started});
      return original.call(this, key, value);
    };
    handle = requestAnimationFrame(tick);
    window.__rocMotionProbe = {
      arm(input) {
        if (pending !== null) feedback.push({type: pending.type, ms: null});
        pending = null;
        armed = input;
      },
      stop() {
        cancelAnimationFrame(handle);
        types.forEach(type => document.removeEventListener(type, onInput, true));
        Storage.prototype.setItem = original;
        if (pending !== null) feedback.push({type: pending.type, ms: null});
        delete window.__rocMotionProbe;
        return {intervals, feedback, writes, pointerInputs};
      }
    };
  });
}
const arm = (page, trigger, target, key = null, eventType = key === null ? 'pointerdown' : 'keydown') =>
  page.evaluate(input => window.__rocMotionProbe.arm(input), {trigger, target, key, eventType});
const testId = id => `[data-testid="${id}"]`;
function frameSummary(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {...summarize(values), p99: sorted[Math.ceil(sorted.length * .99) - 1], over50Ms: values.filter(ms => ms > 50).length};
}
async function measure(page, app, run, id, action) {
  let probe;
  const measured = await measureRendererWorkload(page, async () => {
    await startProbe(page);
    try {const result = await action(); await paint(page); return result;}
    finally {probe = await page.evaluate(() => window.__rocMotionProbe.stop());}
  });
  if (measured.result.pointerClicks !== undefined) {
    assert.equal(probe.pointerInputs.length, measured.result.pointerClicks.length, 'motion_native_pointer_event_count_failed');
    measured.result.pointerClicks.forEach((click, index) => {
      const actual = probe.pointerInputs[index];
      assert.ok(actual.trusted && actual.target === click.hitTest.target.testId &&
        Math.abs(actual.x - click.hitTest.point.x) <= 1 && Math.abs(actual.y - click.hitTest.point.y) <= 1,
      `motion_native_pointer_mismatch:${JSON.stringify({expected: click, actual})}`);
    });
  }
  const raf = frameSummary(probe.intervals);
  const responses = probe.feedback.filter(sample => sample.ms !== null).map(sample => sample.ms);
  const feedback = responses.length === 0 ? null : summarize(responses);
  const workspaceWrites = probe.writes.filter(write => write.key === 'roc.ui.workspace.layouts');
  const processes = await sampleElectronProcesses(app);
  const metrics = {elapsedMs: measured.elapsedMs, rafP95Ms: raf.p95, rafP99Ms: raf.p99, rafOver50Ms: raf.over50Ms,
    longTaskCount: measured.trace.longTaskCount, longestTaskMs: measured.trace.longestTaskMs,
    workspaceWrites: workspaceWrites.length, duringDragWrites: workspaceWrites.filter(write => write.duringDrag).length,
    feedbackSamples: responses.length, feedbackMissing: probe.feedback.length - responses.length,
    heapUsedBytes: measured.after.heapUsedBytes, domNodes: measured.after.domNodes,
    ...(feedback === null ? {} : {feedbackP95Ms: feedback.p95}),
    ...(measured.result.mountedRows === undefined ? {} : {mountedRows: measured.result.mountedRows})};
  run.scenarios.push({id, status: 'complete', metrics, result: measured.result, raf, feedback, feedbackEvents: probe.feedback,
    pointerInputs: probe.pointerInputs,
    trace: measured.trace, before: measured.before, after: measured.after, processes,
    viewport: await page.evaluate(() => ({width: innerWidth, height: innerHeight, devicePixelRatio}))});
  save();
  console.log(JSON.stringify({round: run.index, scenario: id, ...metrics}));
}
async function setZoom(app, page, factor) {
  await app.evaluate(({BrowserWindow}, zoom) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(zoom), factor);
  await page.waitForFunction(width => innerWidth === width, viewport.width / factor);
  await paint(page);
}
async function readPointerTarget(button) {
  return button.evaluate(target => {
    const rect = target.getBoundingClientRect();
    const point = {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2};
    const hit = document.elementFromPoint(point.x, point.y);
    return {point, blocked: target.matches(':disabled') || hit === null || !target.contains(hit),
      target: {testId: target.getAttribute('data-testid'), x: rect.x, y: rect.y, width: rect.width, height: rect.height},
      hit: hit?.closest('[data-testid]')?.getAttribute('data-testid') ?? null,
      viewport: {width: innerWidth, height: innerHeight}, pressed: target.getAttribute('aria-pressed')};
  });
}
async function clickPointer(app, page, button) {
  const hitTest = await readPointerTarget(button);
  if (hitTest.blocked) {
    const error = new Error('motion_pointer_target_blocked');
    error.hitTest = hitTest;
    throw error;
  }
  const native = await app.evaluate(({BrowserWindow}, input) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.focus();
    const bounds = window.getContentBounds();
    const reportedZoom = window.webContents.getZoomFactor();
    const effectiveScale = bounds.width / input.viewport.width;
    const x = Math.round(input.point.x * effectiveScale), y = Math.round(input.point.y * effectiveScale);
    window.webContents.sendInputEvent({type: 'mouseMove', x, y});
    window.webContents.sendInputEvent({type: 'mouseDown', x, y, button: 'left', clickCount: 1});
    window.webContents.sendInputEvent({type: 'mouseUp', x, y, button: 'left', clickCount: 1});
    return {reportedZoom, effectiveScale, nativeContentSize: {width: bounds.width, height: bounds.height}, x, y};
  }, hitTest);
  return {hitTest, native};
}
async function closePane(app, page, buttonId) {
  const button = page.getByTestId(buttonId);
  if (await button.getAttribute('aria-pressed') === 'true') {await clickPointer(app, page, button); await delay(250);}
}
async function reverseSeries(app, page, buttonId, target, shortcut = null, attempts = null) {
  const button = page.getByTestId(buttonId);
  const pointerClicks = [];
  for (let index = 0; index < 10; index++) {
    const before = await button.getAttribute('aria-pressed');
    await arm(page, shortcut === null ? testId(buttonId) : 'body', target, shortcut === null ? null : 'l');
    const attempt = attempts === null ? null : {index: index + 1, before, completed: false};
    if (attempt !== null) attempts.push(attempt);
    if (shortcut === null) pointerClicks.push(await clickPointer(app, page, button));
    else await page.keyboard.press(shortcut);
    if (attempt !== null) attempt.completed = true;
    await delay(60);
    if (before !== null) {
      const after = await button.getAttribute('aria-pressed');
      if (attempt !== null) attempt.after = after;
      assert.equal(after, before === 'true' ? 'false' : 'true', 'motion_toggle_state_failed');
    }
  }
  await delay(250);
  return {toggleInputs: 10, input: shortcut === null ? 'pointer' : 'keyboard', shortcut,
    ...(shortcut === null ? {pointerClicks} : {})};
}
async function recordAssistantPointer(app, page, run, record) {
  const initialHitTest = await readPointerTarget(page.getByTestId('titlebar-toggle-assistant'));
  const attempts = [];
  try {
    await record('assistant-reverse', () => reverseSeries(app, page, 'titlebar-toggle-assistant', 'aside[aria-label="研究助手"]', null, attempts));
  } catch (error) {
    if (error.message !== 'motion_pointer_target_blocked') throw error;
    run.scenarios.push({id: 'assistant-reverse', status: 'blocked', metrics: null,
      result: {input: 'pointer', initialHitTest, blockedHitTest: error.hitTest,
        series: {plannedInputs: 10, attemptedInputs: attempts.length,
          completedInputs: attempts.filter(attempt => attempt.completed).length, attempts}}});
    save();
    console.log(JSON.stringify({round: run.index, scenario: 'assistant-reverse', status: 'blocked', blocker: error.hitTest.hit}));
  }
}
async function dragDivider(page, cancel) {
  const divider = page.getByTestId('divider-sidebar');
  const startWidth = Number(await divider.getAttribute('aria-valuenow'));
  const min = Number(await divider.getAttribute('aria-valuemin')), max = Number(await divider.getAttribute('aria-valuemax'));
  const delta = startWidth <= (min + max) / 2 ? 60 : -60;
  const rect = await divider.boundingBox();
  const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let index = 1; index <= 20; index++) {
    await arm(page, testId('divider-sidebar'), 'aside[aria-label="项目上下文"]', null, 'pointermove');
    await page.mouse.move(x + delta * Math.sin(index / 20 * Math.PI / 2), y);
    await paint(page);
  }
  if (cancel) await page.keyboard.press('Escape');
  await page.mouse.up();
  await paint(page);
  const finalWidth = Number(await divider.getAttribute('aria-valuenow'));
  if (cancel) assert.equal(finalWidth, startWidth, 'motion_escape_width_not_restored');
  return {pointerMoves: 20, cancelled: cancel, delta, startWidth, finalWidth};
}

let app, provider, activeScenario = 'prepare';
try {
  const {seedUiPerformanceProfile} = await importTypeScriptModule('tests/smoke/lib/performance-profile-seed.ts',
    {platform: 'node', external: ['better-sqlite3'], tempDir: bundleDir});
  const template = join(scratch, 'template');
  seedUiPerformanceProfile(template);
  for (let iteration = 1; iteration <= options.samples; iteration++) {
    const dataRoot = join(scratch, `round-${iteration}`);
    cpSync(template, dataRoot, {recursive: true});
    const run = {index: iteration, scenarios: []};
    report.runs.push(run);
    activeScenario = `round-${iteration}-startup`;
    const launched = await launchBenchmarkElectron(electron, {
      args: [`--user-data-dir=${join(dataRoot, 'chromium')}`, join(buildDir, 'main/index.js')],
      env: benchmarkChildEnvironment(process.env, {ROC_SMOKE: '1', ROC_DATA_ROOT: dataRoot, ROC_PERF_REQUIRE_PROFILE: '0'})
    }, async application => {
      await observeElectronLoop(application);
      const page = await application.firstWindow();
      await page.emulateMedia({reducedMotion: options.reducedMotion});
      await application.evaluate(({BrowserWindow}, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), viewport);
      await waitForAppReady(page, `motion-${iteration}`, join(scratch, 'diagnostics'));
      return page;
    });
    app = launched.app;
    const page = launched.value;
    report.host.display ??= await app.evaluate(({screen}) => screen.getAllDisplays().map(display => ({
      size: display.size, scaleFactor: display.scaleFactor, refreshHz: display.displayFrequency ?? null
    })));
    const record = async (id, action) => {activeScenario = id; await measure(page, app, run, id, action);};
    await page.getByTestId('portal-view-list').click();
    await page.getByTestId('portal-search').fill('Performance Profile 3');
    await page.getByTestId('portal-card-pin-project-performance-39').waitFor();
    await record('project-reorder', async () => {
      for (let index = 0; index < 10; index++) {
        await arm(page, testId('portal-card-pin-project-performance-39'), testId('portal-card-project-performance-39'));
        await page.getByTestId('portal-card-pin-project-performance-39').click();
        await paint(page);
      }
      return {toggleInputs: 10, mountedRows: await page.locator('[data-project-body]').count()};
    });
    await page.getByTestId('portal-search').fill('');
    await page.getByTestId('portal-card-open-project-performance-0').click();
    await page.getByTestId('titlebar-projects').waitFor();
    await record('project-menu', () => reverseSeries(app, page, 'titlebar-projects', '.titlebar-project-menu'));
    await closePane(app, page, 'titlebar-toggle-assistant');
    await setZoom(app, page, 2);
    await closePane(app, page, 'titlebar-toggle-sidebar');
    await record('sidebar-reverse', () => reverseSeries(app, page, 'titlebar-toggle-sidebar', 'aside[aria-label="项目上下文"]'));
    activeScenario = 'assistant-reverse';
    await recordAssistantPointer(app, page, run, record);
    await record('assistant-reverse-keyboard', () => reverseSeries(app, page, 'titlebar-toggle-assistant', 'aside[aria-label="研究助手"]', 'Meta+L'));
    await setZoom(app, page, 1);
    await closePane(app, page, 'titlebar-toggle-assistant');
    if (await page.getByTestId('titlebar-toggle-sidebar').getAttribute('aria-pressed') !== 'true') {
      await clickPointer(app, page, page.getByTestId('titlebar-toggle-sidebar'));
    }
    await record('divider-drag', () => dragDivider(page, false));
    await record('divider-escape', () => dragDivider(page, true));
    provider = await startSmokeProvider();
    const configured = await page.evaluate(async endpoint => {
      const current = await window.roc.settings.get();
      if (!current.ok) return current;
      const providerId = 'motion-fixture', modelId = 'motion-fixture';
      const saved = await window.roc.settings.save({settings: current.data.settings,
        permissions: current.data.permissions, defaultModelId: `${providerId}:${modelId}`,
        providers: [{id: providerId, name: 'Motion fixture', type: 'openai_compatible', endpoint,
          credentialRef: `secret:${providerId}`, enabled: true,
          models: [{id: modelId, displayName: 'Motion fixture', enabled: true,
            supportsStreaming: true, supportsToolCalls: true, supportsImages: false}]}]});
      if (!saved.ok) return saved;
      return await window.roc.settings.setProviderSecret({providerId, plaintext: 'isolated-motion-fixture'});
    }, provider.endpoint);
    assert.ok(configured.ok, 'motion_fixture_provider_setup_failed');
    await page.reload();
    await page.getByTestId('activity-nav-runs').click();
    if (await page.getByTestId('titlebar-toggle-sidebar').getAttribute('aria-pressed') !== 'true') {
      await clickPointer(app, page, page.getByTestId('titlebar-toggle-sidebar'));
    }
    await page.getByTestId(`session-row-thread-profile-${options.historyMessages}`).click();
    await page.waitForFunction(marker => document.querySelector('[data-testid="assistant-transcript"]')?.textContent?.includes(marker),
      `profile-marker-${options.historyMessages}-${options.historyMessages}`);
    await closePane(app, page, 'titlebar-toggle-sidebar');
    await page.evaluate(() => {
      window.__rocMotionRun = {runId: null, terminal: null};
      window.__rocMotionRunUnsubscribe = window.roc.chat.onRunEvent(raw => {
        const event = raw !== null && typeof raw === 'object' && !('type' in raw) && 'event' in raw ? raw.event : raw;
        if (event.type === 'run_started') window.__rocMotionRun.runId = event.runId;
        if (event.runId === window.__rocMotionRun.runId && ['run_completed', 'run_failed', 'run_cancelled'].includes(event.type)) {
          window.__rocMotionRun.terminal = {type: event.type, at: performance.now()};
        }
      });
    });
    const input = page.getByTestId('assistant-composer-input');
    const tag = `MOTION${iteration}`;
    await input.fill(`ROC-P4-MODE:slow ROC-P4-RUN:motion${iteration} ROC-P4-SLOW:${options.streamChunks}x1 ROC-P4-SLOW-TAG:${tag}`);
    await paint(page);
    await record('stream-completion', async () => {
      await arm(page, testId('assistant-composer-input'), testId('assistant-composer-send'), 'enter');
      await input.press('Enter');
      await page.waitForFunction(() => window.__rocMotionRun.terminal !== null, null, {timeout: 120_000});
      assert.equal(await page.evaluate(() => window.__rocMotionRun.terminal.type), 'run_completed', 'motion_stream_failed');
      await page.waitForFunction(marker => document.querySelector('[data-testid="assistant-transcript"]')?.textContent?.includes(marker),
        `${tag}-${String(options.streamChunks).padStart(4, '0')}`);
      const mountedRows = await page.locator('[data-testid="assistant-message-user"], [data-testid="assistant-message-assistant"]').count();
      assert.ok(mountedRows > 0 && mountedRows < 100, 'motion_transcript_not_windowed');
      assert.equal(provider.requests.length, 1, 'motion_fixture_duplicate_request');
      return {historyMessages: options.historyMessages, streamChunks: options.streamChunks, mountedRows, providerRequests: provider.requests.length};
    });
    await page.evaluate(() => {window.__rocMotionRunUnsubscribe(); delete window.__rocMotionRunUnsubscribe; delete window.__rocMotionRun;});
    await provider.close({force: true}); provider = undefined;
    await closeBenchmarkElectron(app); app = undefined;
    run.status = run.scenarios.some(scene => scene.status === 'blocked') ? 'complete_with_blocked_scenarios' : 'complete';
    report.completedRuns = iteration;
    save();
  }
  report.status = report.runs.some(run => run.status === 'complete_with_blocked_scenarios') ? 'complete_with_blocked_scenarios' : 'complete';
  save();
} catch (error) {
  recordBenchmarkFailure(report, error, activeScenario);
  save();
  throw error;
} finally {
  try {if (provider) await provider.close({force: true});}
  finally {
    try {if (app) await closeBenchmarkElectron(app);}
    finally {rmSync(scratch, {recursive: true, force: true}); rmSync(bundleDir, {recursive: true, force: true});}
  }
}
