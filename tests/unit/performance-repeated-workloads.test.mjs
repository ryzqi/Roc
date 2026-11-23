import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {assertOrdinaryBuild, readRepeatedArguments, repeatedChildEnvironment, runRepeatedWorkloads} from '../../scripts/performance/repeated-workload-runner.mjs';
import {summarizeRepeatedWorkloads} from '../../scripts/performance/summarize-repeated-workloads.mjs';
import {sustainedStreamConfig} from '../../scripts/performance/sustained-stream-scenario.mjs';
import {uiScenarioIds} from '../../scripts/performance/summarize-ui-runs.mjs';

const snapshot = () => ({heapUsedBytes: 100, heapTotalBytes: 200, domNodes: 30, documents: 1});
const processes = () => ({main: {rss: 100, heapTotal: 200, heapUsed: 150, external: 20, arrayBuffers: 10},
  mainPrivateMemoryBytes: 60, processes: [{type: 'Browser', workingSetBytes: 100, cpuPercent: 2},
    {type: 'Tab', workingSetBytes: 200, cpuPercent: 3}, {type: 'Tab', workingSetBytes: 50, cpuPercent: 4}],
  eventLoopDelay: {p50Ms: 1, p95Ms: 2, maxMs: 3}});
const measurement = elapsedMs => ({elapsedMs, before: snapshot(), after: snapshot(), trace: {
  eventCount: 10, rendererThreadCount: 1, taskCount: 2, busyMs: 3, longTaskCount: 0, longTaskMs: 0,
  longestTaskMs: 3, layoutMs: 1, paintMs: 1}, frameIntervalMs: {count: 10, p50: 16, p95: 18, max: 20},
  inputToSecondRafMs: null, observedRafHz: 60});
const identity = () => ({protocolSha256: 'protocol', fixtureSha256: 'fixture',
  source: {gitSha: 'commit', sourceSha256: 'source', lockSha256: 'lock'},
  host: {identitySha256: 'host', display: [{size: {width: 1512, height: 982}, scaleFactor: 2}]}, limitations: []});

function pdf(elapsedMs = 10) {
  return {...identity(), kind: 'pdf-reader', fixture: {samples: 1, pages: 400, pageTurns: 200, nativeReopen: false},
    rendererBuild: {variant: 'current', manifestSha256: 'manifest'}, backgroundParseMs: elapsedMs * 2,
    scenarios: [{id: '400-page-open-close', samples: [{firstRasterMs: elapsedMs, rasterAllocations: 1,
      mainRssBytes: 100, mainExternalBytes: 20, processWorkingSetSumBytes: 300}]},
    {id: '400-page-200-continuous-turns', measurement: measurement(elapsedMs),
      samples: Array.from({length: 200}, (_, index) => ({page: index + 2, rasterReadyMs: index + 1,
        rasterAllocations: 1, workers: 1, bitmapBytes: 4000}))},
    {id: 'hidden-parser-ipc-competition', samples: [{ipcMs: elapsedMs / 2}]}]};
}

function endurance(elapsedMs = 10) {
  const config = sustainedStreamConfig('30');
  const streamScenes = config.checkpointMinutes.map(minutes => ({id: `history-5000-sustained-${minutes}m`,
    samples: [{minutes, elapsedMs: minutes * 60_000 + 3000, textDeltaCount: minutes * 100 + 20, windowTextDeltas: 10, mountedRows: 13}],
    measurement: measurement(elapsedMs), processes: processes()}));
  const idleSamples = ['visible', 'hidden'].flatMap(visibility => [0, 5, 30].map(minutes => ({visibility, minutes,
    nativeVisible: visibility === 'visible', forwardedHidden: visibility === 'hidden', elapsedMs: minutes * 60_000 + 1,
    mainCpuOneCorePercent: minutes === 0 ? null : 1, renderer: snapshot(), ...processes()})));
  return {...identity(), kind: 'macos-app', fixture: {buildMode: 'production', samples: 1, idleMinutes: 30,
    idleVisibility: 'both', uiWorkloads: {sustainedStream: config}}, reopenMs: elapsedMs,
    sustainedStream: {config, runId: 'stream', seededHistoryMessages: 5000, precedingShortRunsInThread: 1, firstChunkMs: elapsedMs,
      checkpoints: streamScenes.map(scene => ({scenarioId: scene.id, ...scene.samples[0]})),
      completed: {terminal: {type: 'run_completed', runId: 'stream'}, elapsedMs: 1_815_000,
        streamDurationMs: 1_810_000, textDeltaCount: 5050, receivedEvents: 5100}},
    scenarios: [{id: 'events-0', idleSamples}, {id: 'events-1000'}, {id: 'events-10000'},
      ...uiScenarioIds.map(id => ({id})), ...streamScenes]};
}

test('repeat options require an explicit workload and default to five independent rounds', () => {
  assert.deepEqual(readRepeatedArguments(['new.json', '--workload', 'endurance']), {outputPath: 'new.json', samples: 5, workload: 'endurance'});
  assert.equal(readRepeatedArguments(['new.json', '--samples', '3', '--workload', 'pdf']).samples, 3);
  for (const args of [[], ['new.txt'], ['new.json'], ['new.json', '--workload', 'unknown'],
    ['new.json', '--workload', 'pdf', '--samples', '0'], ['new.json', '--workload', 'pdf', '--samples', '1.5'],
    ['new.json', '--workload', 'pdf', '--samples'], ['new.json', '--workload', 'pdf', '--samples', '5', '--samples', '2'],
    ['new.json', '--workload', 'pdf', '--idle-minutes', '1']]) assert.throws(() => readRepeatedArguments(args), /repeat_/u);
});

test('repeat children use ordinary production settings and cannot inherit profiling, reference PDF or trace retention', () => {
  const input = {PATH: '/bin', ROC_PERF_REQUIRE_PROFILE: '1', ROC_PERF_RAW_TRACE_DIR: '/trace',
    ROC_PERF_KEEP_ARTIFACTS: '1', ROC_PERF_PDF_REFERENCE_RENDERER: '/old', ROC_PERF_PDF_SOURCE_PAIRED: '1',
    ROC_PERF_PDF_BACKGROUND_REOPEN: '1', ROC_PERF_PDF_RANGE_READER: '0', ELECTRON_RENDERER_URL: 'https://example.test',
    ELECTRON_RUN_AS_NODE: '1'};
  for (const workload of ['endurance', 'pdf']) {
    const env = repeatedChildEnvironment(workload, input, '/app/dist');
    assert.equal(env.PATH, '/bin'); assert.equal(env.ROC_PERF_APP_DIR, '/app/dist');
    assert.equal(env.ROC_PERF_REQUIRE_PROFILE, '0'); assert.equal(env.ROC_PERF_KEEP_ARTIFACTS, '0');
    for (const name of ['ROC_PERF_RAW_TRACE_DIR', 'ROC_PERF_PDF_REFERENCE_RENDERER', 'ROC_PERF_PDF_SOURCE_PAIRED',
      'ROC_PERF_PDF_BACKGROUND_REOPEN', 'ROC_PERF_PDF_RANGE_READER', 'ELECTRON_RENDERER_URL', 'ELECTRON_RUN_AS_NODE']) assert.equal(env[name], undefined);
    assert.equal(env.ROC_PERF_STREAM_MINUTES, workload === 'endurance' ? '30' : '0');
    assert.equal(env.ROC_PERF_PDF_PAGE_TURNS, workload === 'pdf' ? '200' : '0');
  }
  assert.equal(input.ROC_PERF_REQUIRE_PROFILE, '1');
  const directory = mkdtempSync(join(tmpdir(), 'roc-repeat-build-test-'));
  try {
    assert.throws(() => assertOrdinaryBuild(directory), /repeat_build_missing/u);
    for (const file of ['main/index.js', 'preload/index.cjs', 'renderer/index.html', 'renderer/.vite/manifest.json']) {
      mkdirSync(dirname(join(directory, file)), {recursive: true}); writeFileSync(join(directory, file), 'fixture');
    }
    assertOrdinaryBuild(directory);
    writeFileSync(join(directory, 'renderer/.vite/profiling-build.json'), '{}');
    assert.throws(() => assertOrdinaryBuild(directory), /repeat_requires_ordinary_build/u);
  } finally {rmSync(directory, {recursive: true, force: true});}
});

test('PDF aggregation uses five process samples, keeping 200-page percentiles separate from cross-round percentiles', () => {
  const result = summarizeRepeatedWorkloads('pdf', [50, 10, 30, 20, 40].map(pdf));
  const scene = result.find(row => row.id === '400-page-200-continuous-turns');
  assert.deepEqual(scene.summary.elapsedMs, {count: 5, min: 10, p50: 30, p95: 50, max: 50});
  assert.equal(scene.summary['pageRasterReadyMs.p95'].count, 5);
  assert.equal(scene.summary['pageRasterReadyMs.p95'].p50, 190);
  assert.equal(scene.samples[0].pageTurns, 200);
  assert.equal(scene.missingSamples['inputToSecondRafMs.p95'], 5);
  assert.equal(scene.summary['inputToSecondRafMs.p95'], undefined);
});

test('endurance aggregates matching 30-minute stream and visible/hidden checkpoints independently', () => {
  const result = summarizeRepeatedWorkloads('endurance', [50, 10, 30, 20, 40].map(endurance));
  assert.equal(result.length, 12);
  assert.equal(result.find(row => row.id === 'history-5000-sustained-30m').summary.elapsedMs.p50, 30);
  for (const visibility of ['visible', 'hidden']) {
    const first = result.find(row => row.id === `idle-${visibility}-0m`);
    assert.equal(first.summary.mainCpuOneCorePercent, undefined);
    assert.equal(first.missingSamples.mainCpuOneCorePercent, 5);
    const final = result.find(row => row.id === `idle-${visibility}-30m`);
    assert.equal(final.summary.mainCpuOneCorePercent.count, 5);
    assert.equal(final.summary.rendererProcessCount.p50, 2);
    assert.equal(final.summary.rendererAppMetricsCpuPercentSum.p50, 7);
    assert.equal(final.summary.rendererWorkingSetBytesSum.p50, 250);
  }
});

test('absent Renderer app metrics are explicit missing observations, never zero CPU or working set', () => {
  const run = endurance();
  run.scenarios[0].idleSamples[0].processes = [{type: 'Browser', workingSetBytes: 100, cpuPercent: 2}];
  const first = summarizeRepeatedWorkloads('endurance', [run]).find(row => row.id === 'idle-visible-0m');
  assert.equal(first.samples[0].rendererProcessCount, 0);
  for (const key of ['rendererAppMetricsCpuPercentSum', 'rendererWorkingSetBytesSum']) {
    assert.equal(first.samples[0][key], null); assert.equal(first.summary[key], undefined); assert.equal(first.missingSamples[key], 1);
  }
});

test('repeated aggregation rejects incomplete, incompatible, profiling and malformed child reports', () => {
  const changes = [value => {value.source.sourceSha256 = 'changed';}, value => {value.fixtureSha256 = 'changed';},
    value => {value.host.display[0].scaleFactor = 1;}, value => {value.failedWorkload = {};},
    value => {value.scenarios.push(value.scenarios[0]);}, value => {value.rendererBuild.variant = 'frozen-pr-10-reader';},
    value => {value.scenarios[1].samples.pop();}, value => {value.scenarios[1].samples[0].page = 3;},
    value => {value.scenarios[1].samples[0].rasterAllocations = 0;}, value => {value.scenarios[1].measurement.reactProfile = {};},
    value => {value.scenarios[1].measurement.elapsedMs = NaN;}, value => {value.backgroundParseMs = -1;}];
  for (const change of changes) {const value = pdf(); change(value); assert.throws(() => summarizeRepeatedWorkloads('pdf', [pdf(), value]), /repeat_|ui_run_/u);}
  for (const change of [value => {delete value.sustainedStream.completed;},
    value => {value.sustainedStream.completed.streamDurationMs = 1799999;},
    value => {value.fixture.buildMode = 'react-production-profiling';}, value => {value.scenarios[0].idleSamples.pop();},
    value => {value.scenarios[0].idleSamples[1].mainCpuOneCorePercent = null;},
    value => {value.scenarios[0].idleSamples[3].nativeVisible = true;},
    value => {value.scenarios[0].idleSamples[2].elapsedMs = 10;},
    value => {value.sustainedStream.checkpoints[0].windowTextDeltas = 0;}]) {
    const value = endurance(); change(value); assert.throws(() => summarizeRepeatedWorkloads('endurance', [value]), /repeat_/u);
  }
});

function runnerFixture(workload, samples = 5) {
  const directory = mkdtempSync(join(tmpdir(), 'roc-repeat-runner-test-'));
  const outputPath = join(directory, 'report.json');
  return {directory, outputPath, options: {outputPath, workload, samples, appBuildDir: '/app/dist',
    report: {...identity(), kind: 'repeated-test', fixture: {}, scenarios: []}},
    dispose: () => rmSync(directory, {recursive: true, force: true})};
}

test('runner awaits each child, embeds raw reports and cleans all temporary reports on success', async () => {
  for (const workload of ['endurance', 'pdf']) {
    const f = runnerFixture(workload), calls = [];
    let active = 0;
    try {
      const report = await runRepeatedWorkloads(f.options, {executeChild: async input => {
        assert.equal(active++, 0, 'children must not overlap'); calls.push(input);
        assert.equal(input.args[2], '--samples'); assert.equal(input.args[3], '1');
        assert.deepEqual(input.args.slice(4), workload === 'endurance' ? ['--idle-minutes', '30'] : []);
        await new Promise(done => setTimeout(done, 2));
        writeFileSync(input.outputPath, JSON.stringify((workload === 'endurance' ? endurance : pdf)(input.iteration * 10)));
        writeFileSync(input.outputPath.replace('.json', '.md'), 'temporary child markdown');
        active--; return {exitCode: 0, signal: null};
      }});
      assert.equal(report.status, 'complete'); assert.equal(report.completedRuns, 5);
      assert.equal(calls.length, 5); assert.equal(new Set(calls.map(call => call.outputPath)).size, 5);
      assert.equal(existsSync(dirname(calls[0].outputPath)), false, 'temporary child reports removed');
      const saved = JSON.parse(readFileSync(f.outputPath, 'utf8'));
      assert.ok(saved.runs.every(run => run.status === 'complete' && run.report.fixture.samples === 1));
      assert.equal(saved.runs[4].report.kind, workload === 'endurance' ? 'macos-app' : 'pdf-reader');
      assert.match(readFileSync(f.outputPath.replace('.json', '.md'), 'utf8'), /Run status: complete\. Completed independent rounds: 5\/5/u);
    } finally {f.dispose();}
  }
});

test('failed child preserves its partial report and previous summary, skips later rounds, and cleans temporary files', async () => {
  const f = runnerFixture('pdf'); let calls = 0, temporary;
  try {
    await assert.rejects(runRepeatedWorkloads(f.options, {executeChild: async input => {
      calls++; temporary = dirname(input.outputPath);
      const report = pdf(); if (calls === 2) report.scenarios.pop();
      writeFileSync(input.outputPath, JSON.stringify(report));
      return {exitCode: calls === 2 ? 1 : 0, signal: null, stderrTail: 'fixture child failure'};
    }}), /repeat_child_failed/u);
    const saved = JSON.parse(readFileSync(f.outputPath, 'utf8'));
    assert.equal(calls, 2); assert.equal(existsSync(temporary), false);
    assert.equal(saved.status, 'failed'); assert.equal(saved.completedRuns, 1);
    assert.deepEqual(saved.runs.map(run => run.status), ['complete', 'failed', 'not_run', 'not_run', 'not_run']);
    assert.equal(saved.runs[1].report.scenarios.length, 2);
    assert.equal(saved.runs[1].process.stderrTail, 'fixture child failure');
    assert.equal(saved.scenarios[0].summary.elapsedMs.count, 1);
    assert.match(readFileSync(f.outputPath.replace('.json', '.md'), 'utf8'), /Run status: failed/u);
  } finally {f.dispose();}
});

test('invalid report, incompatible successful exit and launch failure all retain explicit failed status', async () => {
  for (const failure of ['json', 'mismatch', 'launch']) {
    const f = runnerFixture('pdf', 2); let temporary;
    try {
      await assert.rejects(runRepeatedWorkloads(f.options, {executeChild: async input => {
        temporary = dirname(input.outputPath);
        if (failure === 'launch') throw new Error('fixture spawn error');
        if (failure === 'json') writeFileSync(input.outputPath, '{broken');
        else {const report = pdf(); if (input.iteration === 2) report.host.display[0].scaleFactor = 1; writeFileSync(input.outputPath, JSON.stringify(report));}
        return {exitCode: 0, signal: null};
      }}));
      const saved = JSON.parse(readFileSync(f.outputPath, 'utf8'));
      assert.equal(saved.status, 'failed'); assert.equal(existsSync(temporary), false);
      assert.equal(saved.completedRuns, failure === 'mismatch' ? 1 : 0);
      if (failure === 'json') assert.equal(saved.runs[0].unparsedReport, '{broken');
    } finally {f.dispose();}
  }
});

test('runner refuses to overwrite either an existing JSON or Markdown report', async () => {
  for (const extension of ['json', 'md']) {
    const f = runnerFixture('pdf');
    try {
      const existing = f.outputPath.replace(/json$/u, extension); writeFileSync(existing, 'keep');
      await assert.rejects(runRepeatedWorkloads(f.options, {executeChild: async () => assert.fail('must not launch')}), /repeat_output_already_exists/u);
      assert.equal(readFileSync(existing, 'utf8'), 'keep');
    } finally {f.dispose();}
  }
});
