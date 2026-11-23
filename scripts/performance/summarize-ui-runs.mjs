import assert from 'node:assert/strict';
import {summarize} from './report-lib.mjs';

export const uiScenarioIds = ['100-project-search', 'literature-100', 'literature-2000',
  'literature-10000', '20-canvas-switches', 'history-500-stream-500', 'history-5000-stream-5000'];

export function rendererWorkloadSample(scene) {
  const value = scene.measurement;
  assert.ok(value && value.buildMode === undefined && value.reactProfile === undefined && value.ipcProfile === undefined,
    'ui_run_contains_profiling');
  const row = {elapsedMs: value.elapsedMs};
  for (const phase of ['before', 'after']) {
    for (const key of ['heapUsedBytes', 'heapTotalBytes', 'domNodes', 'documents']) row[`${phase}.${key}`] = value[phase]?.[key];
  }
  for (const key of ['eventCount', 'rendererThreadCount', 'taskCount', 'busyMs', 'longTaskCount', 'longTaskMs', 'longestTaskMs', 'layoutMs', 'paintMs']) {
    row[`trace.${key}`] = value.trace?.[key];
  }
  assert.ok(Object.values(row).every(number => Number.isFinite(number) && number >= 0), 'ui_run_metrics_invalid');
  for (const name of ['frameIntervalMs', 'inputToSecondRafMs']) {
    const distribution = value[name];
    assert.ok(distribution === null || (Number.isSafeInteger(distribution?.count) && distribution.count > 0), 'ui_run_distribution_invalid');
    for (const key of ['count', 'p50', 'p95', 'max']) row[`${name}.${key}`] = distribution === null ? null : distribution[key];
  }
  row.observedRafHz = value.observedRafHz;
  assert.ok(Object.values(row).every(number => number === null || (Number.isFinite(number) && number >= 0)), 'ui_run_metrics_invalid');
  return row;
}

/** One row per fresh app invocation. Within-run frames/inputs/switches are never independent runs. */
export function summarizeUiRuns(runs) {
  assert.ok(runs.length > 0, 'ui_runs_required');
  const first = runs[0];
  const scenesByRun = runs.map(run => {
    assert.equal(run.fixture?.buildMode, 'production', 'ui_run_requires_production');
    assert.equal(run.fixture?.idleMinutes, 0, 'ui_run_contains_idle');
    assert.equal(run.fixture?.uiWorkloads?.sustainedStream, null, 'ui_run_contains_soak');
    for (const field of ['protocolSha256', 'fixtureSha256']) assert.equal(run[field], first[field], `ui_run_mismatch:${field}`);
    for (const field of ['gitSha', 'sourceSha256', 'lockSha256']) assert.equal(run.source[field], first.source[field], `ui_run_source_mismatch:${field}`);
    assert.deepEqual(run.host, first.host, 'ui_run_host_mismatch');
    const scenes = run.scenarios.filter(scene => scene.measurement !== undefined);
    assert.deepEqual(scenes.map(scene => scene.id).sort(), [...uiScenarioIds].sort(), 'ui_run_scenario_mismatch');
    return new Map(scenes.map(scene => [scene.id, scene]));
  });
  return uiScenarioIds.map(id => {
    const samples = scenesByRun.map(scenes => rendererWorkloadSample(scenes.get(id)));
    const summary = {}, missingSamples = {};
    for (const key of Object.keys(samples[0])) {
      const values = samples.map(row => row[key]).filter(value => value !== null);
      missingSamples[key] = samples.length - values.length;
      if (values.length > 0) summary[key] = summarize(values);
    }
    return {id, samples, summary, missingSamples};
  });
}
