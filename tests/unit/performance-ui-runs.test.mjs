import assert from 'node:assert/strict';
import test from 'node:test';
import {summarizeUiRuns, uiScenarioIds} from '../../scripts/performance/summarize-ui-runs.mjs';

function run(elapsedMs) {
  const snapshot = {heapUsedBytes: 100, heapTotalBytes: 200, domNodes: 30, documents: 1};
  return {fixture: {buildMode: 'production', idleMinutes: 0, uiWorkloads: {sustainedStream: null}},
    protocolSha256: 'protocol', fixtureSha256: 'fixture', source: {gitSha: 'commit', sourceSha256: 'source', lockSha256: 'lock'},
    host: {identitySha256: 'host', display: {width: 1440}}, scenarios: uiScenarioIds.map(id => ({id,
      samples: Array.from({length: id === '20-canvas-switches' ? 20 : 1}, () => ({elapsedMs: 1})),
      measurement: {elapsedMs, before: snapshot, after: snapshot, trace: {eventCount: 10, rendererThreadCount: 1,
        taskCount: 2, busyMs: 3, longTaskCount: 0, longTaskMs: 0, longestTaskMs: 3, layoutMs: 1, paintMs: 1},
      frameIntervalMs: {count: 4, p50: 16, p95: 18, max: 18}, inputToSecondRafMs: null, observedRafHz: 60}}))};
}

test('ordinary UI aggregation counts independent rounds, preserving absent input samples', () => {
  const runs = [50, 10, 30, 20, 40].map(run);
  runs[1].scenarios.reverse();
  const scenes = summarizeUiRuns(runs);
  assert.equal(scenes.length, 7);
  assert.deepEqual(scenes.find(scene => scene.id === '20-canvas-switches').summary.elapsedMs,
    {count: 5, min: 10, p50: 30, p95: 50, max: 50});
  assert.equal(scenes[0].summary['inputToSecondRafMs.p95'], undefined);
  assert.equal(scenes[0].missingSamples['inputToSecondRafMs.p95'], 5);
  runs[0].scenarios[0].measurement.inputToSecondRafMs = {count: 2, p50: 10, p95: 20, max: 20};
  const partial = summarizeUiRuns(runs)[0];
  assert.equal(partial.summary['inputToSecondRafMs.p95'].count, 1);
  assert.equal(partial.missingSamples['inputToSecondRafMs.p95'], 4);
});

test('UI aggregation rejects missing, duplicate and extra measured scenarios', () => {
  for (const mutate of [scenes => scenes.pop(), scenes => scenes.push(scenes[0]),
    scenes => {scenes[0].id = 'unknown';}]) {
    const value = run(10); mutate(value.scenarios);
    assert.throws(() => summarizeUiRuns([value]), /ui_run_scenario_mismatch/u);
  }
  assert.throws(() => summarizeUiRuns([]), /ui_runs_required/u);
});

test('UI aggregation rejects incomparable runs, profiling, soak and invalid metrics', () => {
  for (const mutate of [value => {value.source.sourceSha256 = 'changed';}, value => {value.fixtureSha256 = 'changed';},
    value => {value.host.display.width = 800;}, value => {value.fixture.buildMode = 'react-production-profiling';},
    value => {value.fixture.idleMinutes = 30;}, value => {value.fixture.uiWorkloads.sustainedStream = {minutes: 30};},
    value => {value.scenarios[0].measurement.reactProfile = {};}, value => {value.scenarios[0].measurement.elapsedMs = NaN;},
    value => {value.scenarios[0].measurement.frameIntervalMs.p95 = Infinity;}]) {
    const value = run(20); mutate(value);
    assert.throws(() => summarizeUiRuns([run(10), value]), /ui_run_/u);
  }
});
